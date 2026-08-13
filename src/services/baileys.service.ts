import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  generateWAMessageFromContent,
  proto,
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
const LID_MAP: Record<string, string> = {
  "277141539291377": "6281288092766",
  "135454796058717": "6287700288297",
};

const PHONE_TO_LID_MAP: Record<string, string> = {
  "6281288092766": "277141539291377@lid",
  "081288092766": "277141539291377@lid",
  "6287700288297": "135454796058717@lid",
  "087700288297": "135454796058717@lid",
};

const STATIC_ALLOWED: Set<string> = new Set([
  "6281288092766",
  "081288092766",
  "277141539291377", // WhatsApp LID for user (081288092766)
  "6287700288297",
  "087700288297",
  "135454796058717", // WhatsApp LID for friend (087700288297)
]);

// Also allow phones from ALLOWED_SENDERS env var (comma-separated)
const envAllowed = (process.env.ALLOWED_SENDERS || "")
  .split(",")
  .map((s) => normalizePhone(s.trim()))
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
  private isExplicitLogout = false;
  private messageStore = new Map<string, any>();
  private lastIncomingMsgMap = new Map<string, any>();
  // Maps phone number (e.g. "6281288092766") -> phone JID for reply routing
  private senderPhoneJidMap = new Map<string, string>();

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
    this.isExplicitLogout = false;
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
        shouldSyncHistoryMessage: () => true,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false,
        retryRequestDelayMs: 250,
        maxMsgRetryCount: 5,
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

          let buttonId = "";
          if (rawMsg.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
            try {
              const parsed = JSON.parse(rawMsg.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
              if (parsed?.id) buttonId = parsed.id;
            } catch (e) {}
          } else if (rawMsg.buttonsResponseMessage?.selectedButtonId) {
            buttonId = rawMsg.buttonsResponseMessage.selectedButtonId;
          } else if (rawMsg.templateButtonReplyMessage?.selectedId) {
            buttonId = rawMsg.templateButtonReplyMessage.selectedId;
          }

          let text = (
            buttonId ||
            rawMsg.conversation ||
            rawMsg.extendedTextMessage?.text ||
            rawMsg.imageMessage?.caption ||
            rawMsg.videoMessage?.caption ||
            rawMsg.documentMessage?.caption ||
            ""
          ).trim();

          const lowerText = text.toLowerCase().trim();

          const remoteJid = msg.key.remoteJid || "";
          const isStatusBroadcast =
            remoteJid.startsWith("status@") || remoteJid.includes("broadcast");
          if (isStatusBroadcast) continue;
          const isGroupChat = remoteJid.endsWith("@g.us");

          // ── WHITELIST CHECK ──────────────────────────────────
          const senderJid = msg.key.participant || remoteJid;
          const senderPhone = normalizePhone(senderJid);
          const connectedPhone = this.connectedUser ? normalizePhone(this.connectedUser) : "";

          if (!msg.key.fromMe) {
            const isOwner = connectedPhone && senderPhone === connectedPhone;
            const isDirectChat = !isGroupChat;
            const isAllowed =
              isDirectChat ||
              ALLOWED_SENDERS.has(senderPhone) ||
              ALLOWED_SENDERS.has(normalizePhone(senderPhone));
            logger.info(
              `Received WA command "${text}" from ${senderJid} (normalized: ${senderPhone}, fromMe: ${msg.key.fromMe}, isDirectChat: ${isDirectChat}, isAllowed: ${isAllowed})`
            );
            if (!isOwner && !isAllowed) {
              logger.warn(`Blocked command from unauthorized sender: ${senderPhone}`);
              continue;
            }
          }

          // Resolve sender to a clean phone JID (@s.whatsapp.net)
          // fromMe=true means bot sent the message, the remote is the recipient
          // fromMe=false means another person sent a message to the bot
          let from = "";
          if (msg.key.fromMe) {
            // bot typed to itself or to a contact — use remoteJid as the "from" so webhook
            // sees the bot number, not the recipient
            from = this.connectedUser ? `${this.connectedUser}@s.whatsapp.net` : "";
          } else {
            // Message came from someone else — senderJid may be a LID, resolve to phone
            const resolvedPhone = LID_MAP[senderPhone] || senderPhone;
            from = `${resolvedPhone}@s.whatsapp.net`;

            // Save mapping: phone -> actual remoteJid/senderJid so reply can target correct JID (LID or phone)
            if (remoteJid) {
              this.senderPhoneJidMap.set(resolvedPhone, remoteJid);
              this.senderPhoneJidMap.set(senderPhone, remoteJid);
            }

            // Save incoming message for quoted reply lookup
            if (remoteJid) this.lastIncomingMsgMap.set(remoteJid, msg);
            if (senderJid) this.lastIncomingMsgMap.set(senderJid, msg);
            if (senderPhone) this.lastIncomingMsgMap.set(senderPhone, msg);
            if (from) this.lastIncomingMsgMap.set(from, msg);
          }

          const senderCleanPhone = normalizePhone(senderJid);
          const resolvedSenderPhone = LID_MAP[senderCleanPhone] || senderCleanPhone;
          const isAdminUser = resolvedSenderPhone === "6281288092766" || senderCleanPhone === "6281288092766";

          // Handle single digit number shortcuts (1, 2, 3, 4, 5, 6, 7)
          if (/^[1-7]$/.test(lowerText)) {
            if (isAdminUser) {
              const numberMap: Record<string, string> = {
                "1": "!loker",
                "2": "!email",
                "3": "!job",
                "4": "!saldo",
                "5": "!cicilan",
                "6": "!hariini",
                "7": "!tambah",
              };
              text = numberMap[lowerText] || text;
            } else {
              const numberMap: Record<string, string> = {
                "1": "!saldo",
                "2": "!cicilan",
                "3": "!hariini",
                "4": "!tambah",
              };
              text = numberMap[lowerText] || text;
            }
          }

          const currentLower = text.toLowerCase().trim();
          const isCommand =
            text.startsWith("!") ||
            text.startsWith("/") ||
            currentLower === "start" ||
            currentLower === "menu" ||
            currentLower === "help" ||
            currentLower.startsWith("menu") ||
            currentLower.startsWith("help");
          if (!isCommand) continue;

          // Handle /start or !start or start or menu or help centrally with complete response
          if (
            currentLower === "/start" ||
            currentLower === "!start" ||
            currentLower === "start" ||
            currentLower === "menu" ||
            currentLower === "/menu" ||
            currentLower === "!menu" ||
            currentLower === "help" ||
            currentLower === "/help" ||
            currentLower === "!help" ||
            currentLower.startsWith("menu") ||
            currentLower.startsWith("help")
          ) {
            let menuText = "";
            if (isAdminUser) {
              menuText = `🤖 *CENTRAL AUTOMATION BOT MENU & HELP*
Halo Mahija! Berikut adalah panduan lengkap perintah WhatsApp Bot:

💼 *JOB TRACKER*
*[1] !loker* / *!lamaran* ➔ Lihat 5 lamaran kerja terbaru
*[2] !email* / *!balasan* ➔ Lihat 5 email balasan HRD terbaru
*[3] !job* / *!overview* ➔ Summary status lamaran & stage penolakan
➕ *!tambah [Judul] | [Perusahaan] | [Status]* ➔ Tambah lamaran kerja
   _Contoh:_ \`!tambah Backend Dev | Tokopedia | APPLIED\`

💰 *FINANCE TRACKER*
*[4] !saldo* / *!overview* ➔ Total aset & cashflow bulan ini
*[5] !cicilan* ➔ Tagihan & cicilan aktif
*[6] !hariini* / *!pengeluaran* ➔ Rincian pengeluaran hari ini
• *!dompet* / *!rekening* ➔ Daftar dompet & saldo per akun
• *!kategori* ➔ Lihat daftar kategori keuangan
• *!riwayat* / *!transaksi* ➔ Lihat 10 transaksi terakhir

📝 *KELOLA TRANSAKSI FINANCE:*
*[7]* ➕ *!tambah [pengeluaran/pemasukan] [jumlah] | [kategori] | [deskripsi] | [dompet]*
   _Contoh:_ \`!tambah pengeluaran 35000 | Makanan | Makan Siang | GoPay\`

✏️ *!edit #no [jumlah] | [kategori] | [deskripsi] | [dompet]*
   _Contoh:_ \`!edit #1 40000 | Makanan | Makan Siang Komplit\`

❌ *!hapus #no* atau *!hapus [code]*
   _Contoh:_ \`!hapus #1\`

💡 *Quick Access:* Cukup ketik angka *1* s/d *7* untuk memilih secara cepat!`;
            } else {
              menuText = `🌸 *FINANCE TRACKER BOT MENU & HELP*
Halo Salma! Berikut adalah panduan lengkap perintah WhatsApp Bot:

📊 *INFORMASI & SALDO*
*[1] !saldo* / *!overview* ➔ Total aset & cashflow bulan ini
*[2] !cicilan* ➔ Tagihan & cicilan aktif
*[3] !hariini* / *!pengeluaran* ➔ Rincian pengeluaran hari ini
• *!dompet* / *!rekening* ➔ Daftar dompet & saldo per akun
• *!kategori* ➔ Lihat daftar kategori keuangan
• *!riwayat* / *!transaksi* ➔ Lihat 10 transaksi terakhir

📝 *KELOLA TRANSAKSI:*
*[4]* ➕ *!tambah [pengeluaran/pemasukan] [jumlah] | [kategori] | [deskripsi] | [dompet]*
   _Contoh:_ \`!tambah pengeluaran 35000 | Makanan | Makan Siang | GoPay\`

✏️ *!edit #no [jumlah] | [kategori] | [deskripsi] | [dompet]*
   _Contoh:_ \`!edit #1 40000 | Makanan | Makan Siang Komplit\`

❌ *!hapus #no* atau *!hapus [code]*
   _Contoh:_ \`!hapus #1\`

💡 *Quick Access:* Cukup ketik angka *1* s/d *4* untuk memilih secara cepat!`;
            }

            await this.sendMessage(from, menuText);
            continue;
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
          this.qrDataUrl = await QRCode.toDataURL(qr, {
            margin: 2,
            width: 400,
            errorCorrectionLevel: "M",
            color: {
              dark: "#000000",
              light: "#FFFFFF",
            },
          });
          logger.warn("QR Code generated. Scan at /qr or check dashboard.");
          qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === "close") {
          this.isInitializing = false;
          if (this.sock) {
            try {
              this.sock.ev.removeAllListeners("connection.update");
              this.sock.ev.removeAllListeners("messages.upsert");
              this.sock.ev.removeAllListeners("creds.update");
              this.sock.end(undefined);
            } catch (_) {}
            this.sock = null;
          }

          if (this.isExplicitLogout) {
            logger.info("Connection closed due to explicit logout request. Auto-reconnect skipped.");
            return;
          }

          const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
          this.connectedUser = null;
          this.status = "disconnected";

          if (reason === DisconnectReason.loggedOut) {
            logger.error("WhatsApp session logged out. Clearing session and restarting...");
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
      qrDataUrl: this.qrDataUrl,
      webhookCount: config.webhookUrls.length,
      webhookUrls: config.webhookUrls,
    };
  }

  public getQrDataUrl(): string | null {
    return this.qrDataUrl;
  }

  public formatJid(phone: string): string {
    if (!phone) return "";
    let target = phone.trim();

    if (target.includes("@g.us") || target.includes("@s.whatsapp.net")) {
      return target;
    }

    if (target.includes("@lid")) {
      const lidNum = target.split("@")[0].split(":")[0];
      if (LID_MAP[lidNum]) {
        return `${LID_MAP[lidNum]}@s.whatsapp.net`;
      }
    }

    let cleaned = target.split("@")[0].replace(/\D/g, "");
    if (LID_MAP[cleaned]) {
      cleaned = LID_MAP[cleaned];
    } else if (cleaned.startsWith("0")) {
      cleaned = "62" + cleaned.slice(1);
    }

    return `${cleaned}@s.whatsapp.net`;
  }

  public async resolveJid(phone: string): Promise<string> {
    if (!phone) return "";
    return this.formatJid(phone);
  }

  public async sendMessage(
    to: string,
    message: string | any
  ): Promise<{ success: boolean; jid: string; messageId?: string }> {
    if (this.status !== "connected" || !this.sock) {
      throw new Error("WhatsApp Gateway is not connected. Please scan QR Code first.");
    }

    const cleanPhone = normalizePhone(to);
    const resolvedPhone = LID_MAP[cleanPhone] || cleanPhone;
    const phoneJid = `${resolvedPhone}@s.whatsapp.net`;
    const mappedJid = this.senderPhoneJidMap.get(cleanPhone) || this.senderPhoneJidMap.get(resolvedPhone);
    const lidJid = mappedJid || PHONE_TO_LID_MAP[cleanPhone] || PHONE_TO_LID_MAP[resolvedPhone];

    // If lidJid is available, try lidJid first to avoid error 463 on privacy accounts
    const targetsToTry: string[] = [];
    if (lidJid && lidJid.endsWith("@lid")) {
      targetsToTry.push(lidJid);
    }
    if (!targetsToTry.includes(phoneJid)) {
      targetsToTry.push(phoneJid);
    }

    let sent: any;
    let successfulJid = phoneJid;
    let lastError: any;

    for (const targetJid of targetsToTry) {
      try {
        const sendPayload = typeof message === "string" ? { text: message } : message;
        sent = await this.sock.sendMessage(targetJid, sendPayload);
        if (sent?.key?.id) {
          successfulJid = targetJid;
          logger.info(`Message sent successfully to ${targetJid}: ${sent.key.id}`);
          break;
        }
      } catch (err: any) {
        lastError = err;
        logger.warn(`sendMessage failed for ${targetJid}: ${err?.message}`);
      }
    }

    if (!sent?.key?.id && lastError) {
      throw lastError;
    }

    if (sent?.key?.id && sent.message) {
      this.saveToMessageStore(sent.key.id, sent.message);
    }

    return {
      success: true,
      jid: successfulJid,
      messageId: sent?.key?.id || undefined,
    };
  }

  public async sendInteractiveButtons(
    to: string,
    bodyText: string,
    footerText: string,
    buttons: Array<{ text: string; id: string }>
  ) {
    const fullText = `${bodyText}\n\n${footerText}`;
    return this.sendMessage(to, fullText);
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
    logger.info("Resetting WhatsApp Gateway session and requesting new QR Code...");
    this.isExplicitLogout = true;
    this.status = "connecting";
    this.connectedUser = null;
    this.qrCodeStr = null;
    this.qrDataUrl = null;

    try {
      if (this.sock) {
        try {
          this.sock.ev.removeAllListeners("connection.update");
          this.sock.end(undefined);
        } catch (_) {}
      }
    } catch (e) {
      logger.error("Logout error:", e);
    } finally {
      this.sock = null;
      this.isInitializing = false;

      await this.clearSession().catch((e) => logger.error("clearSession error:", e));

      setTimeout(() => {
        this.init().catch((e) => logger.error("init error after logout:", e));
      }, 1000);
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
