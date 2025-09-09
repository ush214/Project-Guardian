/**
 * Prompt validation test for CI (PHS v3).
 * Ensures shape & weights for PHS, parameter counts for each section.
 */
import assert from "node:assert";

function validate(obj) {
  assert(obj.wcs_hull_structure, "Missing wcs_hull_structure");
  assert(obj.phs_pollution_hazard, "Missing phs_pollution_hazard");
  assert(obj.esi_environmental_sensitivity, "Missing esi_environmental_sensitivity");
  assert(obj.rpm_risk_pressure_modifiers, "Missing rpm_risk_pressure_modifiers");

  const wcs = obj.wcs_hull_structure.parameters;
  assert(Array.isArray(wcs) && wcs.length === 4, "WCS must have 4 parameters");

  const phs = obj.phs_pollution_hazard;
  assert(phs.version === 3, "PHS version must be 3");
  assert(Array.isArray(phs.parameters) && phs.parameters.length === 3, "PHS must have 3 parameters");
  const phsNames = phs.parameters.map(p => p.parameter);
  ["Fuel Volume & Type", "Ordnance", "Hazardous Materials"].forEach(r =>
    assert(phsNames.includes(r), "Missing PHS parameter: " + r)
  );
  const weightMap = Object.fromEntries(phs.parameters.map(p => [p.parameter, p.weight]));
  assert(Math.abs(weightMap["Fuel Volume & Type"] - 0.50) < 1e-6, "Fuel Volume weight mismatch");
  assert(Math.abs(weightMap["Ordnance"] - 0.30) < 1e-6, "Ordnance weight mismatch");
  assert(Math.abs(weightMap["Hazardous Materials"] - 0.20) < 1e-6, "Hazardous Materials weight mismatch");

  const esi = obj.esi_environmental_sensitivity.parameters;
  assert(Array.isArray(esi) && esi.length === 3, "ESI must have 3 parameters");

  const rpm = obj.rpm_risk_pressure_modifiers.factors;
  assert(Array.isArray(rpm) && rpm.length === 3, "RPM must have 3 factors");
}

(function run() {
  const sample = {
    "wcs_hull_structure": {
      "parameters": [
        { "parameter": "Age", "rationale": "Example", "score": 5 },
        { "parameter": "Construction Quality", "rationale": "Example", "score": 3 },
        { "parameter": "Wreck Integrity", "rationale": "Example", "score": 4 },
        { "parameter": "Corrosion Environment", "rationale": "Example", "score": 4 }
      ],
      "maxScore": 20
    },
    "phs_pollution_hazard": {
      "version": 3,
      "parameters": [
        { "parameter": "Fuel Volume & Type", "weight": 0.50, "rationale": "Example", "score": 8 },
        { "parameter": "Ordnance", "weight": 0.30, "rationale": "Example", "score": 6 },
        { "parameter": "Hazardous Materials", "weight": 0.20, "rationale": "Example", "score": 5 }
      ]
    },
    "esi_environmental_sensitivity": {
      "parameters": [
        { "parameter": "Proximity to Sensitive Ecosystems", "rationale": "Example", "score": 7 },
        { "parameter": "Biodiversity Value", "rationale": "Example", "score": 8 },
        { "parameter": "Socioeconomic Sensitivity", "rationale": "Example", "score": 6 }
      ],
      "maxScore": 30
    },
    "rpm_risk_pressure_modifiers": {
      "factors": [
        { "factor": "Thermal Stress (Ocean Warming)", "rationale": "Example", "value": 1.3 },
        { "factor": "Seismic Activity", "rationale": "Example", "value": 1.7 },
        { "factor": "Anthropogenic Disturbance", "rationale": "Example", "value": 1.1 }
      ]
    },
    "final_summary": {
      "summativeAssessment": "Example summary.",
      "remediationSuggestions": [
        { "priority": 1, "title": "One", "description": "Do something" },
        { "priority": 2, "title": "Two", "description": "Do something else" },
        { "priority": 3, "title": "Three", "description": "Another action" }
      ]
    }
  };

  validate(sample);
  console.log("Prompt validation sample (PHS v3) passed.");
})();