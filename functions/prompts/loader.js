/**
 * loader.js
 *
 * Loads prompt files at runtime with in-memory caching.
 * Exports getInitialPrompt() and getFollowupPrompt({ wreckName }).
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// In-memory cache
let initialPromptCache = null;
let followupPromptCache = null;

/**
 * Get the initial WERP assessment prompt
 * @returns {string} The initial prompt content
 */
export function getInitialPrompt() {
  if (initialPromptCache === null) {
    const promptPath = join(__dirname, "werps_initial_assessment_prompt.md");
    initialPromptCache = readFileSync(promptPath, "utf-8");
  }
  return initialPromptCache;
}

/**
 * Get the follow-up/Phase 2 reassessment prompt with wreck name substitution
 * @param {Object} options - Options object
 * @param {string} options.wreckName - The name of the wreck to substitute
 * @returns {string} The follow-up prompt with wreck name substituted
 */
export function getFollowupPrompt({ wreckName }) {
  if (followupPromptCache === null) {
    const promptPath = join(__dirname, "werps_phase2_reassessment_prompt.md");
    followupPromptCache = readFileSync(promptPath, "utf-8");
  }
  
  // Replace {{wreck_name}} placeholder with actual wreck name
  return followupPromptCache.replace(/\{\{wreck_name\}\}/g, wreckName || "Unknown Vessel");
}