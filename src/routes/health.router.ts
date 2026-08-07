import { Router } from "express";
import { baileysService } from "../services/baileys.service";

const router = Router();

router.get("/health", (req, res) => {
  const status = baileysService.getStatusInfo();
  const qrDataUrl = baileysService.getQrDataUrl();
  // status already includes webhookCount + webhookUrls from getStatusInfo()
  res.json({
    name: "gateway-whatsapp-bot",
    uptime: process.uptime(),
    ...status,
    qrDataUrl,
  });
});

router.get("/qr", (req, res) => {
  const qrDataUrl = baileysService.getQrDataUrl();
  const statusInfo = baileysService.getStatusInfo();

  if (statusInfo.status === "connected") {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>WhatsApp Gateway - Connected</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #1e293b; padding: 2.5rem; border-radius: 1rem; border: 1px solid #334155; text-align: center; max-width: 400px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
            .badge { background: #10b981; color: #022c22; padding: 0.35rem 0.85rem; border-radius: 9999px; font-weight: 700; font-size: 0.85rem; display: inline-block; margin-bottom: 1rem; }
            h1 { font-size: 1.5rem; margin-bottom: 0.5rem; color: #f8fafc; }
            p { color: #94a3b8; font-size: 0.9rem; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="badge">CONNECTED</div>
            <h1>WhatsApp Gateway Online</h1>
            <p>Terhubung sebagai: <strong>${statusInfo.connectedUser}</strong></p>
            <p style="margin-top: 1.5rem; font-size: 0.8rem; color: #64748b;">API Gateway siap menerima & mengirimkan pesan dari semua project Anda.</p>
          </div>
        </body>
      </html>
    `);
  }

  if (!qrDataUrl) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>WhatsApp Gateway - Connecting</title>
          <meta http-equiv="refresh" content="3">
          <style>
            body { font-family: sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #1e293b; padding: 2rem; border-radius: 1rem; text-align: center; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>Memuat WhatsApp Gateway...</h2>
            <p>Menyiapkan QR Code, halaman akan mereset otomatis dalam 3 detik...</p>
          </div>
        </body>
      </html>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>WhatsApp Gateway - Scan QR Code</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="refresh" content="30">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: #1e293b; padding: 2.5rem; border-radius: 1rem; border: 1px solid #334155; text-align: center; max-width: 420px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
          h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
          p { color: #94a3b8; font-size: 0.85rem; margin-bottom: 1.5rem; }
          img { border-radius: 0.75rem; border: 8px solid #ffffff; width: 240px; height: 240px; }
          .footer { font-size: 0.75rem; color: #64748b; margin-top: 1.5rem; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Scan QR Code WhatsApp</h1>
          <p>Buka WhatsApp di HP &rarr; Perangkat Tertaut (Linked Devices) &rarr; Tautkan Perangkat</p>
          <img src="${qrDataUrl}" alt="WhatsApp QR Code" />
          <div class="footer">Halaman akan memperbarui QR Code secara otomatis setiap 30 detik.</div>
        </div>
      </body>
    </html>
  `);
});

export { router as healthRouter };
