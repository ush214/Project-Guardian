/**
 * Firebase Cloud Function to act as a secure backend for the Project Guardian agent.
 * Production-ready: handles CORS, 5-minute timeout, Gen 2 secrets, and robust logging.
 */

const functions = require("firebase-functions");
const logger = require("firebase-functions/logger");
const cors = require("cors")({ origin: true });

// Use Firebase Functions Secrets (Gen 2)
const { defineSecret } = require("firebase-functions/params");
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

exports.callGeminiApi = functions
  .runWith({
    timeoutSeconds: 300,
    secrets: [GEMINI_API_KEY], // Injects GEMINI_API_KEY into process securely
  })
  .https.onRequest((req, res) => {
    // Handle CORS (including preflight) using middleware and explicit headers
    cors(req, res, async () => {
      // Echo the Origin for credential-less CORS, vary for caches
      res.set("Access-Control-Allow-Origin", req.get("Origin") || "*");
      res.set("Vary", "Origin");

      if (req.method === "OPTIONS") {
        // Preflight
        res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.set("Access-Control-Allow-Headers", "Content-Type");
        res.set("Access-Control-Max-Age", "3600");
        res.status(204).send("");
        return;
      }

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
        // Use global fetch (Node 18/20+)
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

        if (result?.candidates?.[0]?.content?.parts?.[0]?.text) {
          logger.info("Successfully parsed Gemini response. Returning data to client.");
          res.status(200).send({
            data: { success: true, data: result.candidates[0].content.parts[0].text },
          });
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