import dotenv from "dotenv";
dotenv.config();

/**
 * WEBHOOK_URLS: comma-separated list of webhook endpoints to broadcast all WA commands to.
 * Each project (job-tracker, finance-tracker, etc.) registers its own webhook URL here.
 * Example: "http://job-tracker-api:3000/api/v1/whatsapp/webhook,http://finance-tracker-api:3000/api/whatsapp/webhook"
 *
 * Fallback defaults cover both projects when running in the homelab Docker network.
 */
const defaultWebhookUrls = [
  "http://job-tracker-api:3000/api/v1/whatsapp/webhook",
  "http://finance-tracker-api:3000/api/whatsapp/webhook",
];

function parseWebhookUrls(): string[] {
  const raw = process.env.WEBHOOK_URLS || process.env.WEBHOOK_URL || "";
  if (!raw.trim()) return defaultWebhookUrls;
  const parsed = raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  // Merge parsed URLs with defaults so defaults are always registered
  const merged = Array.from(new Set([...parsed, ...defaultWebhookUrls]));
  return merged;
}

export const config = {
  port: parseInt(process.env.PORT || "3001", 10),
  apiKey: process.env.API_KEY || "eeja_wa_gateway_secret_key_2026",
  sessionDir: process.env.SESSION_DIR || "./sessions",
  nodeEnv: process.env.NODE_ENV || "development",
  /** All project webhook endpoints – gateway broadcasts to ALL of them on every command */
  webhookUrls: parseWebhookUrls(),
};
