// Reports which documents WOULD change if normalizeWerps applied now (dry-run diff).
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db } from "./admin.js";
import { FieldPath } from "firebase-admin/firestore";
import {
  normalizeWCS, normalizeToPHSV2, normalizeESI, normalizeRPM
} from "./schemaMapping.js";

const REGION = "us-central1";
const TARGET_PATH = "artifacts/guardian-agent-default/public/data/werpassessments";

async function getRole(uid){
  try{
    const snap=await db.doc(`system/allowlist/users/${uid}`).get();
    if(!snap.exists)return"user";
    return snap.get("Role")||"user";
  }catch{return"user";}
}

export const schemaDiffReport = onCall(
  {
    region: REGION,
    invoker: "public",
    cors:true,
    timeoutSeconds: 300,
    memory:"512MiB"
  },
  async (req)=>{
    const uid=req.auth?.uid;
    if(!uid) throw new HttpsError("unauthenticated","Sign-in required.");
    const role=await getRole(uid);
    if(role!=="admin") throw new HttpsError("permission-denied","Admin only.");

    const limitRaw = parseInt(String(req.data?.limit ?? "100"),10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw)?limitRaw:100,10),500);
    const startAfterId = typeof req.data?.startAfterId==="string"?req.data.startAfterId.trim():"";

    let q = db.collection(TARGET_PATH).orderBy(FieldPath.documentId()).limit(limit);
    if(startAfterId) q=q.startAfter(startAfterId);
    const snap=await q.get();
    if(snap.empty) return {ok:true, diffs:[], nextPageStartAfterId:undefined};

    const diffs=[];
    let lastId="";
    for(const d of snap.docs){
      lastId=d.id;
      const data=d.data()||{};
      const proposed = {
        wcs: normalizeWCS(data.wcs||{}),
        phs: normalizeToPHSV2(data.phs||{}),
        esi: normalizeESI(data.esi||{}),
        rpm: normalizeRPM(data.rpm||{})
      };
      const delta = {};
      const compare=(k)=>{
        if(JSON.stringify(data[k])!==JSON.stringify(proposed[k])){
          delta[k]={ before:data[k]||null, after:proposed[k] };
        }
      };
      compare("wcs");
      compare("phs");
      compare("esi");
      compare("rpm");
      if(Object.keys(delta).length>0){
        diffs.push({ id:d.id, changes:Object.keys(delta), delta });
      }
    }

    const next = snap.size===limit ? lastId : undefined;
    return {ok:true,count:diffs.length,diffs,nextPageStartAfterId:next};
  }
);