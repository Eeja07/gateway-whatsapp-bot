import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || "3001", 10),
  apiKey: process.env.API_KEY || "eeja_wa_gateway_secret_key_2026",
  sessionDir: process.env.SESSION_DIR || "./sessions",
  nodeEnv: process.env.NODE_ENV || "development",
  webhookUrl: process.env.WEBHOOK_URL || "https://job.eeja.fun/api/v1/whatsapp/webhook",
};
