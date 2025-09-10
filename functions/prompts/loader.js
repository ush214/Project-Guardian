/**
 * prompts/loader.js
 * 
 * Loads prompt templates from markdown files with in-memory caching.
 * Supports template substitution for Phase 2 prompts.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// In-memory cache for prompt content
const promptCache = new Map();

/**
 * Reads a prompt file with caching
 * @param {string} filename - The prompt file name
 * @returns {string} The prompt content
 */
function readPromptFile(filename) {
  if (promptCache.has(filename)) {
    return promptCache.get(filename);
  }
  
  try {
    const filePath = join(__dirname, filename);
    const content = readFileSync(filePath, 'utf-8');
    promptCache.set(filename, content);
    return content;
  } catch (error) {
    throw new Error(`Failed to read prompt file ${filename}: ${error.message}`);
  }
}

/**
 * Gets the initial WERP assessment prompt
 * @returns {string} The initial assessment prompt
 */
export function getInitialPrompt() {
  return readPromptFile('werps_initial_assessment_prompt.md');
}

/**
 * Gets the Phase 2 reassessment prompt with wreck name substitution
 * @param {object} options - Options object
 * @param {string} options.wreckName - The wreck name to substitute
 * @returns {string} The Phase 2 prompt with substitutions
 */
export function getFollowupPrompt({ wreckName }) {
  const template = readPromptFile('werps_phase2_reassessment_prompt.md');
  
  // Replace {{wreck_name}} placeholders with the actual wreck name
  return template.replace(/\{\{wreck_name\}\}/g, wreckName || '');
}