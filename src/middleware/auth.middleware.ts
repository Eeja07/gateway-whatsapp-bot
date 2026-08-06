import type { Request, Response, NextFunction } from "express";
import { config } from "../config";

export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const apiKeyHeader = req.headers["x-api-key"] || req.query.api_key;

  if (!apiKeyHeader || apiKeyHeader !== config.apiKey) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Invalid or missing X-API-KEY header / api_key query parameter",
    });
  }

  next();
}
