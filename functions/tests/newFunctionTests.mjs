/**
 * Test the new prompt loader and analyzeWerps function structure
 */
import assert from "node:assert";
import { getInitialPrompt, getFollowupPrompt } from "../prompts/loader.js";

// Test prompt loader functionality
function testPromptLoader() {
  console.log("Testing prompt loader...");
  
  // Test initial prompt
  const initialPrompt = getInitialPrompt();
  assert(typeof initialPrompt === "string", "Initial prompt should be a string");
  assert(initialPrompt.length > 100, "Initial prompt should have substantial content");
  assert(initialPrompt.includes("WERP"), "Initial prompt should mention WERP");
  
  // Test follow-up prompt
  const followupPrompt = getFollowupPrompt({ wreckName: "USS Test" });
  assert(typeof followupPrompt === "string", "Follow-up prompt should be a string");
  assert(followupPrompt.includes("USS Test"), "Follow-up prompt should include wreck name");
  assert(!followupPrompt.includes("{{wreck_name}}"), "Placeholder should be replaced");
  
  // Test follow-up prompt without wreck name
  const followupEmptyName = getFollowupPrompt({});
  assert(followupEmptyName.includes("Unknown Vessel"), "Should handle missing wreck name");
  
  console.log("✓ Prompt loader tests passed");
}

// Test the function imports
async function testFunctionImports() {
  console.log("Testing function imports...");
  
  try {
    const analyzeWerpsModule = await import("../analyzeWerps.js");
    assert(analyzeWerpsModule.analyzeWerps, "analyzeWerps should be exported");
    
    const reassessWerpsModule = await import("../reassessWerps.js");
    assert(reassessWerpsModule.reassessWerps, "reassessWerps should be exported");
    
    console.log("✓ Function import tests passed");
  } catch (e) {
    throw new Error(`Function import failed: ${e.message}`);
  }
}

// Run tests
async function runTests() {
  try {
    testPromptLoader();
    await testFunctionImports();
    console.log("All tests passed! ✅");
  } catch (e) {
    console.error("Test failed:", e.message);
    process.exit(1);
  }
}

runTests();