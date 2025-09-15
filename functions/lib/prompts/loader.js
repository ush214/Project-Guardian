/**
 * Prompts loader with in-memory caching
 * Reads prompt files and provides functions to get initial and follow-up prompts
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// In-memory cache
let cachedPrompts = null;
function loadPrompts() {
    if (cachedPrompts) {
        return cachedPrompts;
    }
    try {
        const initialPromptPath = join(__dirname, 'werps_initial_assessment_prompt.md');
        const phase2PromptPath = join(__dirname, 'werps_phase2_reassessment_prompt.md');
        const initialPrompt = readFileSync(initialPromptPath, 'utf-8');
        const phase2Prompt = readFileSync(phase2PromptPath, 'utf-8');
        cachedPrompts = {
            initial: initialPrompt,
            phase2: phase2Prompt
        };
        return cachedPrompts;
    }
    catch (error) {
        console.error('Error loading prompts:', error);
        throw new Error('Failed to load prompt files');
    }
}
/**
 * Get the initial assessment prompt
 * @returns {string} The initial prompt text
 */
export function getInitialPrompt() {
    const prompts = loadPrompts();
    return prompts.initial;
}
/**
 * Get the follow-up assessment prompt with wreck name substitution
 * @param {Object} options - Options object
 * @param {string} options.wreckName - The name of the wreck to substitute
 * @returns {string} The phase 2 prompt with substitutions
 */
export function getFollowupPrompt({ wreckName }) {
    const prompts = loadPrompts();
    // Replace {{wreck_name}} placeholder with actual wreck name
    return prompts.phase2.replace(/\{\{wreck_name\}\}/g, wreckName || 'Unknown Vessel');
}
// Clear cache function for testing/debugging
export function clearCache() {
    cachedPrompts = null;
}
