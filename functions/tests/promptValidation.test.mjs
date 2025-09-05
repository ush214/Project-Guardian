// Lightweight validation for unified prompt outputs.
// Run with: node scripts/tests/promptValidation.test.mjs
import assert from 'node:assert';

function validateOutput(obj){
  assert(obj.wcs_hull_structure, "Missing wcs_hull_structure");
  assert(obj.phs_pollution_hazard, "Missing phs_pollution_hazard");
  assert(obj.esi_environmental_sensitivity, "Missing esi_environmental_sensitivity");
  assert(obj.rpm_risk_pressure_modifiers, "Missing rpm_risk_pressure_modifiers");

  const phs = obj.phs_pollution_hazard.parameters;
  assert(Array.isArray(phs) && phs.length===4, "PHS must have 4 parameters");
  const names = phs.map(p=>p.parameter);
  for(const required of ["Fuel Volume & Type","Ordnance","Vessel Integrity","Hazardous Materials"]){
    assert(names.includes(required), "Missing PHS param: "+required);
  }
  const weights = Object.fromEntries(phs.map(p=>[p.parameter,p.weight]));
  assert(Math.abs(weights["Fuel Volume & Type"] - 0.40)<1e-6, "Fuel Volume weight mismatch");
  assert(Math.abs(weights["Ordnance"] - 0.25)<1e-6, "Ordnance weight mismatch");
  assert(Math.abs(weights["Vessel Integrity"] - 0.20)<1e-6, "Vessel Integrity weight mismatch");
  assert(Math.abs(weights["Hazardous Materials"] - 0.15)<1e-6, "Hazardous Materials weight mismatch");
}

(function run(){
  const sample = {
    "wcs_hull_structure": {
      "parameters": [
        {"parameter":"Age","rationale":"Example","score":4},
        {"parameter":"Construction Quality","rationale":"Example","score":2},
        {"parameter":"Wreck Integrity","rationale":"Example","score":5},
        {"parameter":"Corrosion Environment","rationale":"Example","score":4}
      ],
      "maxScore":20
    },
    "phs_pollution_hazard":{
      "parameters":[
        {"parameter":"Fuel Volume & Type","weight":0.40,"rationale":"Example","score":8},
        {"parameter":"Ordnance","weight":0.25,"rationale":"Example","score":6},
        {"parameter":"Vessel Integrity","weight":0.20,"rationale":"Example","score":7},
        {"parameter":"Hazardous Materials","weight":0.15,"rationale":"Example","score":5}
      ]
    },
    "esi_environmental_sensitivity":{
      "parameters":[
        {"parameter":"Proximity to Sensitive Ecosystems","rationale":"Example","score":7},
        {"parameter":"Biodiversity Value","rationale":"Example","score":8},
        {"parameter":"Socioeconomic Sensitivity","rationale":"Example","score":6}
      ],
      "maxScore":30
    },
    "rpm_risk_pressure_modifiers":{
      "factors":[
        {"factor":"Thermal Stress (Ocean Warming)","rationale":"Example","value":1.4},
        {"factor":"Seismic Activity","rationale":"Example","value":1.8},
        {"factor":"Anthropogenic Disturbance","rationale":"Example","value":1.1}
      ]
    },
    "final_summary":{
      "summativeAssessment":"Example...",
      "remediationSuggestions":[
        {"priority":1,"title":"One","description":"Do something"},
        {"priority":2,"title":"Two","description":"Do something else"},
        {"priority":3,"title":"Three","description":"Another action"}
      ]
    }
  };
  validateOutput(sample);
  console.log("Prompt validation sample passed.");
})();