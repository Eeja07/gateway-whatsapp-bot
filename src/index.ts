import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { config } from "./config";
import { logger } from "./utils/logger";
import { baileysService } from "./services/baileys.service";
import { healthRouter } from "./routes/health.router";
import { messageRouter } from "./routes/message.router";
import { apiKeyAuth } from "./middleware/auth.middleware";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Global rate limiting to prevent spam
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Public status & QR code endpoints
app.use("/", healthRouter);

// Protected REST API endpoints for external projects
app.use("/api/v1/messages", apiKeyAuth, messageRouter);

// Initialize Baileys Client
baileysService.init();

app.listen(config.port, () => {
  logger.info(`🚀 Central WhatsApp API Gateway running on port ${config.port} [${config.nodeEnv}]`);
  logger.info(`📱 Open http://localhost:${config.port}/qr to view live QR Code`);
});
