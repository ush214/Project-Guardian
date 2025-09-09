// Placeholder scheduled function (extend for real incident ingestion if needed).
import { onSchedule } from "firebase-functions/v2/scheduler";

export const guardianSentry = onSchedule(
  {
    region: "us-central1",
    schedule: "every 24 hours",
    timeZone: "Etc/UTC"
  },
  async () => {
    console.log("guardianSentry heartbeat OK");
  }
);