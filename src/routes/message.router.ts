import { Router } from "express";
import { baileysService } from "../services/baileys.service";

const router = Router();

router.post("/send", async (req, res) => {
  try {
    const { to, message } = req.body || {};
    if (!to || !message) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Fields 'to' (phone number) and 'message' are required.",
      });
    }

    const result = await baileysService.sendMessage(to, message);
    return res.json({
      success: true,
      data: result,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to send WhatsApp message",
    });
  }
});

router.post("/send-bulk", async (req, res) => {
  try {
    const { items, delayMs } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Field 'items' must be a non-empty array of { to, message }.",
      });
    }

    const results = await baileysService.sendBulk(items, typeof delayMs === "number" ? delayMs : 1000);
    return res.json({
      success: true,
      data: results,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to process bulk messages",
    });
  }
});

router.post("/logout", async (req, res) => {
  try {
    await baileysService.logout();
    return res.json({
      success: true,
      message: "WhatsApp session logged out and reset successfully.",
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to logout session",
    });
  }
});

export { router as messageRouter };
