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
          return { conversation: "Job Tracker Bot Notification" };
        },
      });

      this.sock.ev.on("creds.update", saveCreds);

      // Listen for incoming messages and dispatch to webhook URL
      this.sock.ev.on("messages.upsert", async (m) => {
        if (m.type !== "notify") return;
        for (const msg of m.messages) {
          if (!msg.message) continue;

          if (msg.key?.id && msg.message) {
            this.saveToMessageStore(msg.key.id, msg.message);
          }

          const text = (
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            ""
          ).trim();

          const isCommand = text.startsWith("!");

          // Ignore normal self-sent messages unless it is a command starting with !
          if (msg.key.fromMe && !isCommand) continue;

          let from = "";
          if (msg.key.remoteJid) {
            const raw = msg.key.remoteJid.split("@")[0];
            if (msg.key.remoteJid.endsWith("@lid") || raw === "status" || !raw) {
              from = this.connectedUser || raw;
            } else {
              from = raw;
            }
          } else {
            from = this.connectedUser || "";
          }

          const pushName = msg.pushName || "User";

          if (text && config.webhookUrl) {
            logger.info(`Dispatching WA message from ${from} (fromMe: ${msg.key.fromMe}): ${text}`);
            fetch(config.webhookUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-API-KEY": config.apiKey,
                "User-Agent": "Mozilla/5.0 (WhatsAppGateway/1.0)",
              },
              body: JSON.stringify({
                from,
                body: text,
                pushName,
                timestamp: msg.messageTimestamp,
              }),
            }).catch((e) => logger.error("Webhook dispatch error:", e));
          }
        }
      });

      this.sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.qrCodeStr = qr;
          this.status = "qr_ready";
          this.qrDataUrl = await QRCode.toDataURL(qr);
          logger.warn("QR Code generated. Please scan QR Code below or visit /qr in browser:");
          qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === "close") {
          const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
          this.connectedUser = null;
          this.status = "disconnected";

          if (reason === DisconnectReason.loggedOut) {
            logger.error("WhatsApp session logged out. Clearing sessions directory...");
            this.clearSession();
            setTimeout(() => this.init(), 2000);
          } else {
            logger.warn(`Connection closed due to reason: ${reason}. Reconnecting in 3s...`);
            setTimeout(() => this.init(), 3000);
          }
        } else if (connection === "open") {
          this.status = "connected";
          this.qrCodeStr = null;
          this.qrDataUrl = null;
          this.connectedUser = this.sock?.user?.id ? this.sock.user.id.split(":")[0] : "Connected User";
          logger.info(`✅ WhatsApp Gateway successfully connected! User: ${this.connectedUser}`);
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
    };
  }

  public getQrDataUrl(): string | null {
    return this.qrDataUrl;
  }

  public formatJid(phone: string): string {
    let cleaned = phone.replace(/\D/g, "");
    if (cleaned.startsWith("0")) {
      cleaned = "62" + cleaned.slice(1);
    }
    if (!cleaned.endsWith("@s.whatsapp.net")) {
      cleaned = `${cleaned}@s.whatsapp.net`;
    }
    return cleaned;
  }

  public async sendMessage(to: string, message: string): Promise<{ success: boolean; jid: string; messageId?: string }> {
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

  public async sendBulk(items: Array<{ to: string; message: string }>, delayMs = 1000): Promise<Array<{ to: string; success: boolean; error?: string }>> {
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
      this.clearSession();
      this.status = "disconnected";
      this.connectedUser = null;
      this.qrCodeStr = null;
      this.qrDataUrl = null;
      setTimeout(() => this.init(), 2000);
    }
  }

  private clearSession(): void {
    const sessionPath = path.resolve(config.sessionDir);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
  }
}

export const baileysService = new BaileysService();
