const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const fetch = require("node-fetch");

// This line loads the variables from your .env file into process.env
require("dotenv").config();

// Securely access the API key from the environment variables
// The key itself is ONLY in the .env file, which is NOT in GitHub.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

exports.callGeminiApi = onCall(async (request) => {
  // Check if the API key was loaded correctly
  if (!GEMINI_API_KEY) {
    logger.error("Gemini API Key is not configured in the function's environment.");
    throw new HttpsError("internal", "The server is missing its API key configuration.");
  }

  const prompt = request.data.prompt;

  if (!prompt) {
    logger.warn("Request received without a prompt.");
    throw new HttpsError("invalid-argument", "The function must be called with a 'prompt' argument.");
  }
// ... the rest of the file remains exactly the same
```

#### **Step 4: Commit and Deploy**

Now you can safely commit your changes.

1.  In your terminal (from the main `Project Guardian Local` folder), run your Git commands:
    ```bash
    git add .
    git commit -m "Secure Gemini API key using .env file"
    git push origin main
    

