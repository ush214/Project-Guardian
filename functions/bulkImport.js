// Only show UPDATED sections: new unified prompt & performNewAnalysis.
// Keep all your queue / scheduler logic as-is; replace old performNewAnalysis & prompt functions.

import { GoogleGenerativeAI } from "@google/generative-ai";
import { defineSecret } from "firebase-functions/params";
import { clamp } from "./schemaMapping.js"; // clamp reused
// ... other existing imports and setup ...

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-2.5-pro";

function buildUnifiedAssessmentPrompt(vesselName) {
  return `You are an expert OSINT analyst and marine environmental risk assessor.
Return ONLY JSON (no markdown):

{
  "wcs_hull_structure": {
    "parameters": [
      {"parameter":"Age","rationale":"...","score":0},
      {"parameter":"Construction Quality","rationale":"...","score":0},
      {"parameter":"Wreck Integrity","rationale":"...","score":0},
      {"parameter":"Corrosion Environment","rationale":"...","score":0}
    ],
    "maxScore": 20
  },
  "phs_pollution_hazard": {
    "parameters": [
      {"parameter":"Fuel Volume & Type","weight":0.40,"rationale":"...","score":0},
      {"parameter":"Ordnance","weight":0.25,"rationale":"...","score":0},
      {"parameter":"Vessel Integrity","weight":0.20,"rationale":"...","score":0},
      {"parameter":"Hazardous Materials","weight":0.15,"rationale":"...","score":0}
    ]
  },
  "esi_environmental_sensitivity": {
    "parameters": [
      {"parameter":"Proximity to Sensitive Ecosystems","rationale":"...","score":0},
      {"parameter":"Biodiversity Value","rationale":"...","score":0},
      {"parameter":"Socioeconomic Sensitivity","rationale":"...","score":0}
    ],
    "maxScore": 30
  },
  "rpm_risk_pressure_modifiers": {
    "factors": [
      {"factor":"Thermal Stress (Ocean Warming)","rationale":"...","value":1.0},
      {"factor":"Seismic Activity","rationale":"...","value":1.0},
      {"factor":"Anthropogenic Disturbance","rationale":"...","value":1.0}
    ]
  },
  "final_summary": {
    "summativeAssessment":"...",
    "remediationSuggestions":[
      {"priority":1,"title":"...","description":"..."},
      {"priority":2,"title":"...","description":"..."},
      {"priority":3,"title":"...","description":"..."}
    ]
  }
}

Rules:
- High score/value => higher risk/sensitivity.
- WCS each parameter score 0–5 (sum 0–20).
- PHS scores 0–10; use weights exactly 0.40,0.25,0.20,0.15; weighted sum 0–10.
- ESI scores 0–10 each (sum 0–30).
- RPM values 0.5–2.5 (1 baseline).
- Provide concrete rationales (no placeholders).
Vessel: ${vesselName}`;
}

function extractJsonCandidate(text) {
  let s = String(text || "");
  let m = s.match(/```json([\s\S]*?)```/i);
  if (m) return m[1].trim();
  m = s.match(/```([\s\S]*?)```/i);
  if (m) return m[1].trim();
  const f = s.indexOf("{");
  const l = s.lastIndexOf("}");
  if (f !== -1 && l !== -1 && l > f) return s.slice(f, l + 1).trim();
  return s.trim();
}

async function callGemini(prompt) {
  const key = GEMINI_API_KEY.value();
  if (!key) throw new Error("Missing GEMINI_API_KEY");
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  const res = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" }
  });
  const raw = res?.response?.text() || "";
  const cand = extractJsonCandidate(raw);
  return JSON.parse(cand);
}

function clampScore(v, min, max) {
  if (typeof v !== "number") {
    v = parseFloat(String(v));
  }
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

async function performNewAnalysis(vesselName) {
  const obj = await callGemini(buildUnifiedAssessmentPrompt(vesselName));

  const wcsParams = (obj.wcs_hull_structure?.parameters || []).map(p => ({
    name: p.parameter,
    rationale: p.rationale,
    score: clampScore(p.score, 0, 5)
  }));
  const wcsTotal = wcsParams.reduce((s, p) => s + p.score, 0);

  const phsParams = (obj.phs_pollution_hazard?.parameters || []).map(p => ({
    name: p.parameter,
    rationale: p.rationale,
    score: clampScore(p.score, 0, 10),
    weight: p.weight
  }));
  const phsWeighted = phsParams.reduce((s, p) => s + (p.score * p.weight), 0);

  const esiParams = (obj.esi_environmental_sensitivity?.parameters || []).map(p => ({
    name: p.parameter,
    rationale: p.rationale,
    score: clampScore(p.score, 0, 10)
  }));
  const esiTotal = esiParams.reduce((s, p) => s + p.score, 0);

  const rpmFactors = (obj.rpm_risk_pressure_modifiers?.factors || []).map(f => ({
    name: f.factor,
    rationale: f.rationale,
    value: clampScore(f.value, 0.5, 2.5)
  }));
  const rpmAvg = rpmFactors.length ? rpmFactors.reduce((s, f) => s + f.value, 0) / rpmFactors.length : 1.0;

  return {
    vesselName,
    wcs: { parameters: wcsParams, totalScore: wcsTotal },
    phs: { parameters: phsParams, totalWeightedScore: clampScore(phsWeighted, 0, 10) },
    esi: { parameters: esiParams, totalScore: clampScore(esiTotal, 0, 30), maxScore: 30 },
    rpm: { factors: rpmFactors, finalMultiplier: parseFloat(rpmAvg.toFixed(2)) },
    finalSummary: {
      summativeAssessment: obj.final_summary?.summativeAssessment || "",
      remediationSuggestions: obj.final_summary?.remediationSuggestions || []
    },
    status: "initial"
  };
}

// Export performNewAnalysis for queue processor usage.
// Ensure the queue processor uses this implementation now.
export { performNewAnalysis };