// Replace your existing helpers with these improved versions:

function extractJsonCandidate(text) {
  const s = String(text || "");
  // 1) Prefer ```json ... ``` fenced blocks
  const fence = s.match(/```json([\s\S]*?)```/i) || s.match(/```([\s\S]*?)```/i);
  if (fence && fence[1]) return fence[1].trim();

  // 2) Try to capture the first well-formed top-level JSON object
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return s.slice(firstBrace, lastBrace + 1).trim();
  }
  return s.trim();
}

async function callGemini(prompt, schema) {
  const key = GEMINI_API_KEY.value();
  if (!key) throw new Error("GEMINI_API_KEY secret is not available at runtime.");

  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  // Ask for JSON-only output, optionally enforce a schema if provided
  const request = {
    contents: [{ role: "user", parts: [{ text: prompt }]}],
    generationConfig: {
      responseMimeType: "application/json",
      ...(schema ? { responseSchema: schema } : {})
    }
  };

  const res = await model.generateContent(request);
  const raw = res?.response?.text ? res.response.text() : "";
  const candidate = extractJsonCandidate(raw);

  try {
    return JSON.parse(candidate);
  } catch (e) {
    logger.error("Failed to parse Gemini JSON. Raw output:", raw);
    throw new Error("Gemini did not return valid JSON for the given prompt.");
  }
}