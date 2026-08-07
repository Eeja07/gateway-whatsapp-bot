import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import { config } from "../config";
import { logger } from "../utils/logger";

export type ConnectionStatus = "disconnected" | "connecting" | "qr_ready" | "connected";

// ============================================================
// WHITELIST: Only these normalized phone numbers can trigger
// the bot. Self-chat (connectedUser) is always allowed.
// Format: country-code + number, no +, no spaces, no dashes.
// Add more numbers here or manage via ALLOWED_SENDERS env var.
// ============================================================
const STATIC_ALLOWED: Set<string> = new Set([
  "6287700288297",
  "087700288297",
  "135454796058717", // WhatsApp LID for friend (087700288297)
]);

// Also allow phones from ALLOWED_SENDERS env var (comma-separated)
const envAllowed = (process.env.ALLOWED_SENDERS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOWED_SENDERS: Set<string> = new Set([...STATIC_ALLOWED, ...envAllowed]);

/** Normalize a raw JID or phone string to a plain number string */
function normalizePhone(raw: string): string {
  if (!raw) return "";
  let base = raw.split("@")[0];
  base = base.split(":")[0].split(".")[0];
  let cleaned = base.replace(/\D/g, "");
  if (cleaned.startsWith("0")) {
    cleaned = "62" + cleaned.slice(1);
  }
  return cleaned;
}

/**
 * Broadcasts an incoming WA command to ALL registered webhook URLs (fan-out).
 * Each project (job-tracker, finance-tracker, ...) independently receives and
 * handles the command through their own webhook handler. Failures on one URL
 * do NOT block delivery to other URLs.
 */
async function broadcastToWebhooks(payload: {
  from: string;
  body: string;
  pushName: string;
  timestamp: any;
}): Promise<void> {
  const { webhookUrls, apiKey } = config;
  if (!webhookUrls || webhookUrls.length === 0) return;

  logger.info(
    `Broadcasting WA command "${payload.body}" from ${payload.from} to ${webhookUrls.length} webhook(s)`
  );

  const deliveries = webhookUrls.map((url) =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
        "User-Agent": "Mozilla/5.0 (WhatsAppGateway/1.0)",
      },
      body: JSON.stringify(payload),
    })
      .then(async (res) => {
        const text = await res.text().catch(() => "");
        logger.info(`Webhook [${url}] responded ${res.status}: ${text.slice(0, 120)}`);
      })
      .catch((e) => logger.error(`Webhook dispatch error for [${url}]: ${e.message}`))
  );

  await Promise.allSettled(deliveries);
}

class BaileysService {
  private sock: WASocket | null = null;
  private qrCodeStr: string | null = null;
  private qrDataUrl: string | null = null;
  private status: ConnectionStatus = "disconnected";
  private connectedUser: string | null = null;
  private isInitializing = false;
  private messageStore = new Map<string, any>();

  private saveToMessageStore(id?: string | null, message?: any) {
    if (!id || !message) return;
    if (this.messageStore.size > 200) {
      const firstKey = this.messageStore.keys().next().value;
      if (firstKey) this.messageStore.delete(firstKey);
    }
    this.messageStore.set(id, message);
  }

  public async init(): Promise<void> {
    if (this.isInitializing) return;
    this.isInitializing = true;
    this.status = "connecting";

    logger.info(`Gateway will broadcast to ${config.webhookUrls.length} webhook(s):`);
    config.webhookUrls.forEach((u, i) => logger.info(`  [${i + 1}] ${u}`));

    try {
      const sessionPath = path.resolve(config.sessionDir);
      if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
      const { version } = await fetchLatestBaileysVersion();

      logger.info(`Starting Baileys WA Client using version ${version.join(".")}`);

      this.sock = makeWASocket({
        version,
        logger: logger as any,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger as any),
        },
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        getMessage: async (key) => {
          if (key?.id && this.messageStore.has(key.id)) {
            return this.messageStore.get(key.id);
          }
          return { conversation: "WhatsApp Gateway Notification" };
        },
      });

      this.sock.ev.on("creds.update", saveCreds);

      // Listen for incoming messages and fan-out to all webhook URLs
      this.sock.ev.on("messages.upsert", async (m) => {
        if (m.type !== "notify") return;
        for (const msg of m.messages) {
          if (!msg.message) continue;

          if (msg.key?.id && msg.message) {
            this.saveToMessageStore(msg.key.id, msg.message);
          }

          let rawMsg = msg.message;
          if (rawMsg.ephemeralMessage?.message) rawMsg = rawMsg.ephemeralMessage.message;
          if (rawMsg.viewOnceMessage?.message) rawMsg = rawMsg.viewOnceMessage.message;
          if (rawMsg.viewOnceMessageV2?.message) rawMsg = rawMsg.viewOnceMessageV2.message;

          const text = (
            rawMsg.conversation ||
            rawMsg.extendedTextMessage?.text ||
            rawMsg.imageMessage?.caption ||
            rawMsg.videoMessage?.caption ||
            rawMsg.documentMessage?.caption ||
            ""
          ).trim();

          const isCommand = text.startsWith("!");
          if (!isCommand) continue;

          const remoteJid = msg.key.remoteJid || "";
          const isStatusBroadcast =
            remoteJid.startsWith("status@") || remoteJid.includes("broadcast");
          if (isStatusBroadcast) continue;

          // ── WHITELIST CHECK ──────────────────────────────────
          const senderJid = msg.key.participant || remoteJid;
          const senderPhone = normalizePhone(senderJid);
          const connectedPhone = this.connectedUser ? normalizePhone(this.connectedUser) : "";

          if (!msg.key.fromMe) {
            const isOwner = connectedPhone && senderPhone === connectedPhone;
            const isAllowed =
              ALLOWED_SENDERS.has(senderPhone) ||
              ALLOWED_SENDERS.has(normalizePhone(senderPhone));
            logger.info(
              `Received WA command "${text}" from ${senderJid} (normalized: ${senderPhone}, fromMe: ${msg.key.fromMe}, isAllowed: ${isAllowed})`
            );
            if (!isOwner && !isAllowed) {
              logger.warn(`Blocked command from unauthorized sender: ${senderPhone}`);
              continue;
            }
          }

          let from = "";
          if (msg.key.fromMe) {
            if (!remoteJid || remoteJid.endsWith("@lid") || remoteJid.startsWith("status")) {
              from = this.connectedUser || "";
            } else {
              from = remoteJid;
            }
          } else {
            from = remoteJid;
          }

          const pushName = msg.pushName || "User";

          // Fan-out to all registered project webhooks
          await broadcastToWebhooks({
            from,
            body: text,
            pushName,
            timestamp: msg.messageTimestamp,
          });
        }
      });

      this.sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.qrCodeStr = qr;
          this.status = "qr_ready";
          this.qrDataUrl = await QRCode.toDataURL(qr);
          logger.warn("QR Code generated. Scan at /qr or check dashboard.");
          qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === "close") {
          const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
          this.connectedUser = null;
          this.status = "disconnected";

          if (reason === DisconnectReason.loggedOut) {
            logger.error("WhatsApp session logged out. Clearing session and restarting...");
            try {
              this.sock?.end(undefined);
            } catch (_) {}
            this.sock = null;
            setTimeout(async () => {
              await this.clearSession().catch((e) => logger.error("clearSession error:", e));
              setTimeout(() => this.init(), 1000);
            }, 2000);
          } else {
            logger.warn(`Connection closed (reason: ${reason}). Reconnecting in 3s...`);
            setTimeout(() => this.init(), 3000);
          }
        } else if (connection === "open") {
          this.status = "connected";
          this.qrCodeStr = null;
          this.qrDataUrl = null;
          this.connectedUser = this.sock?.user?.id
            ? this.sock.user.id.split(":")[0]
            : "Connected User";
          logger.info(`✅ WhatsApp Gateway connected! User: ${this.connectedUser}`);
          logger.info(
            `📡 Broadcasting to ${config.webhookUrls.length} project(s): ${config.webhookUrls.join(", ")}`
          );
        }
      });
    } catch (err: any) {
      logger.error("Failed to initialize Baileys WA Client:", err);
      this.status = "disconnected";
    } finally {
      this.isInitializing = false;
    }
  }

  public getStatusInfo() {
    return {
      status: this.status,
      connectedUser: this.connectedUser,
      hasQr: !!this.qrDataUrl,
      webhookCount: config.webhookUrls.length,
      webhookUrls: config.webhookUrls,
    };
  }

  public getQrDataUrl(): string | null {
    return this.qrDataUrl;
  }

  public formatJid(phone: string): string {
    if (
      phone.includes("@s.whatsapp.net") ||
      phone.includes("@g.us") ||
      phone.includes("@lid")
    ) {
      return phone;
    }
    let cleaned = phone.replace(/\D/g, "");
    if (cleaned.startsWith("0")) {
      cleaned = "62" + cleaned.slice(1);
    }
    return `${cleaned}@s.whatsapp.net`;
  }

  public async sendMessage(
    to: string,
    message: string
  ): Promise<{ success: boolean; jid: string; messageId?: string }> {
    if (this.status !== "connected" || !this.sock) {
      throw new Error("WhatsApp Gateway is not connected. Please scan QR Code first.");
    }

    const jid = this.formatJid(to);
    const sent = await this.sock.sendMessage(jid, { text: message });

    if (sent?.key?.id && sent.message) {
      this.saveToMessageStore(sent.key.id, sent.message);
    }

    return {
      success: true,
      jid,
      messageId: sent?.key?.id || undefined,
    };
  }

  public async sendBulk(
    items: Array<{ to: string; message: string }>,
    delayMs = 1000
  ): Promise<Array<{ to: string; success: boolean; error?: string }>> {
    const results = [];
    for (const item of items) {
      try {
        await this.sendMessage(item.to, item.message);
        results.push({ to: item.to, success: true });
      } catch (err: any) {
        results.push({ to: item.to, success: false, error: err.message });
      }
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return results;
  }

  public async logout(): Promise<void> {
    try {
      if (this.sock) {
        await this.sock.logout();
      }
    } catch (e) {
      logger.error("Logout error:", e);
    } finally {
      await this.clearSession().catch((e) => logger.error("clearSession error:", e));
      this.status = "disconnected";
      this.connectedUser = null;
      this.qrCodeStr = null;
      this.qrDataUrl = null;
      setTimeout(() => this.init(), 3000);
    }
  }

  private async clearSession(): Promise<void> {
    const sessionPath = path.resolve(config.sessionDir);
    try {
      if (!fs.existsSync(sessionPath)) return;
      const entries = await fs.promises.readdir(sessionPath);
      await Promise.all(
        entries.map((entry) =>
          fs.promises.rm(path.join(sessionPath, entry), { recursive: true, force: true })
        )
      );
      logger.info("Session files cleared (folder kept to avoid EBUSY).");
    } catch (e: any) {
      logger.warn(`clearSession: ${e.message}`);
    }
  }
}

export const baileysService = new BaileysService();
