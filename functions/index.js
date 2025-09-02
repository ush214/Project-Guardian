/**
 * Firebase Cloud Function to act as a secure backend for the Project Guardian agent.
 * This function includes an extended timeout to allow for deep research and enhanced logging.
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const fetch = require("node-fetch");

// This line loads the secret variables from your .env file into process.env
require("dotenv").config();

// Securely access the API key from the environment variables.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

/**
 * A callable function that can be invoked from the frontend application.
 * CRITICAL UPDATE: The timeout has been increased to 300 seconds (5 minutes)
 * to allow the multi-step Gemini analysis to complete without interruption.
 */
exports.callGeminiApi = onCall({ timeoutSeconds: 300 }, async (request) => {
  logger.info("Function invoked with extended timeout.");

  // 1. Security Check: Ensure the secret API key is loaded correctly on the server.
  if (!GEMINI_API_KEY) {
    logger.error("CRITICAL: Gemini API Key is not configured in the function's environment. The .env file may be missing or was not deployed correctly.");
    throw new HttpsError("internal", "The server is missing its API key configuration.");
  }
  logger.info("Gemini API Key loaded successfully.");

  // 2. Input Validation: Ensure the request from the client contains a prompt.
  const prompt = request.data.prompt;
  if (!prompt) {
    logger.warn("Request received from a client without a prompt.");
    throw new HttpsError("invalid-argument", "The function must be called with a 'prompt' argument.");
  }

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" },
  };

  logger.info(`Calling Gemini API for prompt: ${prompt.substring(0, 100)}...`);

  // 3. API Call with Error Handling
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error(`Gemini API Error: ${response.status}`, { errorBody });
      throw new HttpsError("internal", `API call failed with status: ${response.status}`);
    }
    logger.info("Successfully received response from Gemini API.");

    const result = await response.json();
    
    // 4. Response Validation and Return
    if (result.candidates?.[0]?.content?.parts?.[0]?.text) {
        logger.info("Successfully parsed Gemini response. Returning data to client.");
        return { success: true, data: result.candidates[0].content.parts[0].text };
    } else {
        logger.error("Unexpected API response structure from Gemini", { result });
        throw new HttpsError("internal", "Unexpected API response from Gemini.");
    }

  } catch (error) {
    logger.error("Full function execution error:", error);
    if (error instanceof HttpsError) {
        throw error;
    }
    throw new HttpsError("unknown", "An unknown server error occurred.", error.message);
  }
});

