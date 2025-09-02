/**
 * Firebase Cloud Function to act as a secure backend for the Project Guardian agent.
 * This is the final, production-ready version using the latest Firebase SDK syntax.
 * It handles CORS, uses an extended timeout, and has enhanced logging.
 */

const functions = require("firebase-functions");
const logger = require("firebase-functions/logger");
const fetch = require("node-fetch");
const cors = require("cors")({ origin: true });

// This line loads the secret variables from your .env file into process.env
require("dotenv").config();

// Securely access the API key from the environment variables.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Define the function with runtime options (5-minute timeout)
exports.callGeminiApi = functions.runWith({ timeoutSeconds: 300 }).https.onRequest((req, res) => {
  // Use the cors middleware to automatically handle security headers
  cors(req, res, async () => {
    logger.info("Function invoked via HTTP, CORS handled.");

    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    if (!GEMINI_API_KEY) {
      logger.error("CRITICAL: Gemini API Key is not configured in the function's environment.");
      res.status(500).send({ error: "Server is missing API key configuration." });
      return;
    }
    logger.info("Gemini API Key loaded successfully.");

    const prompt = req.body.data?.prompt;
    if (!prompt) {
      logger.warn("Request received without a prompt.");
      res.status(400).send({ error: "The request must include a 'prompt' in the data payload." });
      return;
    }

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    };

    logger.info(`Calling Gemini API for prompt: ${prompt.substring(0, 100)}...`);

    try {
      const apiResponse = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!apiResponse.ok) {
        const errorBody = await apiResponse.text();
        logger.error(`Gemini API Error: ${apiResponse.status}`, { errorBody });
        res.status(500).send({ error: `API call failed with status: ${apiResponse.status}` });
        return;
      }
      logger.info("Successfully received response from Gemini API.");

      const result = await apiResponse.json();
      
      if (result.candidates?.[0]?.content?.parts?.[0]?.text) {
          logger.info("Successfully parsed Gemini response. Returning data to client.");
          res.status(200).send({ data: { success: true, data: result.candidates[0].content.parts[0].text } });
      } else {
          logger.error("Unexpected API response structure from Gemini", { result });
          res.status(500).send({ error: "Unexpected API response from Gemini." });
      }
    } catch (error) {
      logger.error("Full function execution error:", error);
      res.status(500).send({ error: "An unknown server error occurred." });
    }
  });
});

