// Centralized constants & mapping heuristics for PHS/ESI schema upgrades.

export const PHS_V2_CANONICAL = [
  { name: "Fuel Volume & Type", weight: 0.40 },
  { name: "Ordnance", weight: 0.25 },
  { name: "Vessel Integrity", weight: 0.20 },
  { name: "Hazardous Materials", weight: 0.15 }
];

export function clamp(n, min, max) {
  if (typeof n !== "number") {
    const f = parseFloat(String(n));
    if (!Number.isFinite(f)) return min;
    n = f;
  }
  return Math.min(max, Math.max(min, n));
}

export function isPHSV2(parameters) {
  if (!Array.isArray(parameters) || parameters.length !== 4) return false;
  const names = parameters.map(p => p.name);
  return PHS_V2_CANONICAL.every(c => names.includes(c.name));
}

// Heuristic to map legacy parameter names into canonical buckets.
export function mapLegacyPHS(parameters = []) {
  const buckets = {
    "Fuel Volume & Type": [],
    "Ordnance": [],
    "Vessel Integrity": [],
    "Hazardous Materials": []
  };
  for (const p of parameters) {
    const n = (p?.name || p?.parameter || "").toLowerCase();
    if (/fuel/.test(n)) buckets["Fuel Volume & Type"].push(p);
    else if (/ordnance|cargo risk|munitions/.test(n)) buckets["Ordnance"].push(p);
    else if (/integrity|sinking/.test(n)) buckets["Vessel Integrity"].push(p);
    else if (/hazardous|material|residual oils|leak likelihood|hazard/.test(n)) {
      // If explicit Hazardous Materials we keep; else can later fold into Vessel Integrity if empty.
      buckets["Hazardous Materials"].push(p);
    } else {
      // Fallback: treat unknown as Vessel Integrity.
      buckets["Vessel Integrity"].push(p);
    }
  }
  // Construct final canonical params
  return PHS_V2_CANONICAL.map(c => {
    const arr = buckets[c.name];
    if (!arr || arr.length === 0) {
      return {
        name: c.name,
        rationale: "Not specified.",
        score: 0,
        weight: c.weight
      };
    }
    const rationale = arr.map(x => x.rationale).filter(Boolean).join(" | ") || "Not specified.";
    // average scores if multiple
    const avg = arr.reduce((s, x) => s + clamp(x.score, 0, 10), 0) / arr.length;
    return {
      name: c.name,
      rationale,
      score: Math.round(avg),
      weight: c.weight
    };
  });
}

export function computePHSV2WeightedTotal(params) {
  if (!Array.isArray(params) || params.length === 0) return 0;
  const t = params.reduce((s, p) => s + (clamp(p.score, 0, 10) * (p.weight || 0)), 0);
  return clamp(t, 0, 10);
}

export function normalizeToPHSV2(phsObj = {}) {
  let params = Array.isArray(phsObj.parameters) ? phsObj.parameters : [];
  // Convert key 'parameter' to 'name'
  params = params.map(p => ({
    name: p.name || p.parameter || "Unknown",
    rationale: (p.rationale || "").trim() || "Not specified.",
    score: clamp(p.score, 0, 10),
    weight: p.weight
  }));
  if (isPHSV2(params)) {
    // Ensure weights exactly canonical
    const merged = PHS_V2_CANONICAL.map(c => {
      const found = params.find(p => p.name === c.name) || {};
      return {
        name: c.name,
        rationale: found.rationale || "Not specified.",
        score: clamp(found.score, 0, 10),
        weight: c.weight
      };
    });
    return {
      parameters: merged,
      totalWeightedScore: computePHSV2WeightedTotal(merged)
    };
  }
  // Legacy -> map
  const mapped = mapLegacyPHS(params);
  return {
    parameters: mapped,
    totalWeightedScore: computePHSV2WeightedTotal(mapped)
  };
}

// ESI mapping: Accept either 3-param (new) or 4-param legacy; we keep unchanged here.
export function normalizeESI(esiObj = {}) {
  let params = Array.isArray(esiObj.parameters) ? esiObj.parameters : [];
  params = params.map(p => ({
    name: p.name || p.parameter || "Unknown",
    rationale: (p.rationale || "").trim() || "Not specified.",
    score: clamp(p.score, 0, 10)
  }));
  let maxScore;
  if (params.length === 3) maxScore = 30;
  else if (params.length === 4) maxScore = 40;
  else maxScore = params.length * 10;
  const total = params.reduce((s, p) => s + p.score, 0);
  return {
    parameters: params,
    totalScore: clamp(total, 0, maxScore),
    maxScore
  };
}

export function normalizeWCS(wcsObj = {}) {
  let params = Array.isArray(wcsObj.parameters) ? wcsObj.parameters : [];
  params = params.map(p => ({
    name: p.name || p.parameter || "Unknown",
    rationale: (p.rationale || "").trim() || "Not specified.",
    score: clamp(p.score, 0, 5)
  }));
  const total = params.reduce((s, p) => s + p.score, 0);
  return { parameters: params, totalScore: clamp(total, 0, 20) };
}

export function normalizeRPM(rpmObj = {}) {
  let factors = Array.isArray(rpmObj.factors) ? rpmObj.factors : [];
  factors = factors.map(f => ({
    name: f.name || f.factor || "Unknown",
    rationale: (f.rationale || "").trim() || "Not specified.",
    value: clamp(f.value, 0.5, 2.5)
  }));
  const avg = factors.length ? factors.reduce((s, f) => s + f.value, 0) / factors.length : 1.0;
  return {
    factors,
    finalMultiplier: parseFloat(avg.toFixed(2))
  };
}