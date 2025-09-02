/**
 * Project Guardian - Secure backend for Gemini calls (Firebase Functions v2)
 * - Uses onRequest (v2) with built-in CORS handling
 * - 5-minute timeout
 * - Secrets via Firebase Functions params
 * - Uses global fetch (Node 18/20+)
 */

const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const { defineSecret } = require("firebase-functions/params");

// Define secret; set it via: firebase functions:secrets:set GEMINI_API_KEY
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

exports.callGeminiApi = onRequest(
  {
    timeoutSeconds: 300,
    secrets: [GEMINI_API_KEY],
    // Let Functions v2 handle CORS automatically (preflight + headers)
    // You can restrict to known origins by replacing true with an array:
    // cors: ["https://project-guardian-agent.web.app", "https://project-guardian-agent.firebaseapp.com"]
    cors: true,
    region: "us-central1",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const apiKey = GEMINI_API_KEY.value();
    if (!apiKey) {
      logger.error("CRITICAL: GEMINI_API_KEY secret is not configured.");
      res.status(500).send({ error: "Server is missing API key configuration." });
      return;
    }
    logger.info("Gemini API Key loaded successfully.");

    const prompt = req.body?.data?.prompt;
    if (!prompt) {
      logger.warn("Request received without a prompt.");
      res.status(400).send({ error: "The request must include a 'prompt' in the data payload." });
      return;
    }

    const apiUrl =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=" +
      encodeURIComponent(apiKey);
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

      const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        logger.info("Successfully parsed Gemini response. Returning data to client.");
        res.status(200).send({ data: { success: true, data: text } });
      } else {
        logger.error("Unexpected API response structure from Gemini", { result });
        res.status(500).send({ error: "Unexpected API response from Gemini." });
      }
    } catch (error) {
      logger.error("Full function execution error:", error);
      res.status(500).send({ error: "An unknown server error occurred." });
    }
  }
);