// Fill missing or "Not specified." rationales using the model without altering scores.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { db } from "./admin.js";
import { FieldPath } from "firebase-admin/firestore";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { clamp } from "./schemaMapping.js";

const REGION = "us-central1";
const TARGET_PATH = "artifacts/guardian-agent-default/public/data/werpassessments";
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-2.5-pro";

async function getRole(uid){
  try{
    const snap=await db.doc(`system/allowlist/users/${uid}`).get();
    if(!snap.exists)return"user";
    return snap.get("Role")||"user";
  }catch{return"user";}
}

function createModel(){
  const key=GEMINI_API_KEY.value();
  if(!key) throw new Error("Missing GEMINI_API_KEY");
  const genAI = new GoogleGenerativeAI(key);
  return genAI.getGenerativeModel({model:GEMINI_MODEL});
}

function extractJsonCandidate(t){
  t=String(t||"");
  let m=t.match(/```json([\s\S]*?)```/i); if(m) return m[1].trim();
  m=t.match(/```([\s\S]*?)```/i); if(m) return m[1].trim();
  const f=t.indexOf("{"), l=t.lastIndexOf("}");
  if(f!==-1 && l!==-1 && l>f) return t.slice(f,l+1).trim();
  return t.trim();
}

function buildRationalePrompt(vesselName, section, items){
  const listing = items.map(i => `{"name":"${i.name}","existing":${JSON.stringify(i.rationale)}}`).join("\n");
  return `Provide improved concise rationales for each ${section} item below (avoid redundancy, 1-2 sentences):
Return ONLY JSON: {"items":[{"name":"...","rationale":"..."}...]}
Items:
${listing}
Vessel: ${vesselName}`;
}

async function getImprovedRationales(model, vesselName, section, items){
  const prompt = buildRationalePrompt(vesselName, section, items);
  const res = await model.generateContent({
    contents:[{role:"user",parts:[{text:prompt}]}],
    generationConfig:{responseMimeType:"application/json"}
  });
  const raw = res?.response?.text() || "";
  const cand = extractJsonCandidate(raw);
  const parsed = JSON.parse(cand);
  const outMap = {};
  for (const it of (parsed.items||[])) {
    outMap[it.name] = it.rationale;
  }
  return outMap;
}

export const backfillRationales = onCall(
  {
    region: REGION,
    timeoutSeconds: 540,
    memory: "1GiB",
    invoker: "public",
    secrets:[GEMINI_API_KEY],
    cors:true
  },
  async (req)=>{
    const uid=req.auth?.uid;
    if(!uid) throw new HttpsError("unauthenticated","Sign-in required.");
    const role=await getRole(uid);
    if(role!=="admin") throw new HttpsError("permission-denied","Admin only.");

    const dryRun = req.data?.dryRun===undefined?true:!!req.data.dryRun;
    const pageSizeRaw = parseInt(String(req.data?.pageSize ?? "100"),10);
    const pageSize = Math.min(Math.max(Number.isFinite(pageSizeRaw)?pageSizeRaw:100,20),400);
    const maxDocsRaw = parseInt(String(req.data?.maxDocs ?? pageSize),10);
    const maxDocs = Math.min(Math.max(Number.isFinite(maxDocsRaw)?maxDocsRaw:pageSize,1),pageSize);
    const startAfterId = typeof req.data?.startAfterId==="string"?req.data.startAfterId.trim():"";

    const began=Date.now();
    const col=db.collection(TARGET_PATH);
    let q = col.orderBy(FieldPath.documentId()).limit(pageSize);
    if(startAfterId) q=q.startAfter(startAfterId);
    const snap=await q.get();

    if(snap.empty){
      return {ok:true,dryRun,pages:0,scanned:0,updated:0,nextPageStartAfterId:undefined,tookMs:Date.now()-began};
    }

    const model = createModel();
    let scanned=0, updated=0;
    let processed=0;
    let lastId="";
    for(const doc of snap.docs){
      if(processed>=maxDocs) break;
      scanned++;
      lastId=doc.id;
      try{
        const data=doc.data()||{};
        const vesselName = data.vesselName || doc.id;
        const update={};

        // Sections to fill: wcs.parameters, phs.parameters, esi.parameters, rpm.factors
        const targets = [
          { path:"wcs.parameters", list:data?.wcs?.parameters, section:"hull_structure" },
          { path:"phs.parameters", list:data?.phs?.parameters, section:"pollution_hazard" },
          { path:"esi.parameters", list:data?.esi?.parameters, section:"environmental_sensitivity" },
          { path:"rpm.factors", list:data?.rpm?.factors, section:"risk_pressure_modifiers" }
        ];

        let changed = false;
        for(const t of targets){
          if(!Array.isArray(t.list) || t.list.length===0) continue;
          const needing = t.list.filter(x=>!x.rationale || /^not specified\.$/i.test(x.rationale.trim()));
          if(needing.length===0) continue;
          const improvedMap = await getImprovedRationales(model, vesselName, t.section, needing);
          const newList = t.list.map(item => {
            if(improvedMap[item.name]) {
              changed = true;
              return {...item, rationale: improvedMap[item.name]};
            }
            return item;
          });
          update[t.path] = newList;
        }

        if(changed && !dryRun){
          await doc.ref.update(update);
          updated++;
        }
        processed++;
      }catch(e){
        // continue
      }
    }

    let nextToken;
    if(processed>=maxDocs || snap.size===pageSize){
      nextToken = lastId;
    }

    return {
      ok:true,
      dryRun,
      scanned,
      updated,
      nextPageStartAfterId: nextToken,
      tookMs: Date.now()-began
    };
  }
);