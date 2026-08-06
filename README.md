# 🤖 Centralized WhatsApp API Gateway Microservice

Microservice WhatsApp API Gateway terpusat berbasis Node.js, TypeScript, dan `@whiskeysockets/baileys`. Dirancang khusus untuk memfasilitasi pengiriman pesan WhatsApp dari berbagai project (seperti **Job Tracker**, E-commerce, Monitoring Server, dsb) secara serentak, efisien, dan aman.

---

## 🌟 Fitur Utama

- **Centralized Microservice**: 1 Service & 1 Sesi WhatsApp melayani banyak aplikasi/project sekaligus via REST API.
- **Persistent Multi-Device Session**: Sesi login WhatsApp disimpan ke volume disk (`./sessions`), tetap terhubung meskipun server/container di-restart.
- **REST API Protected by X-API-KEY**: Endpoint dilindungi header API Key untuk mencegah penggunaan tanpa izin.
- **Auto QR Code Web & Terminal**: Menyediakan endpoint `/qr` berdesain modern untuk mempermudah scan QR Code via browser HP/Laptop.
- **Queue & Rate Limiting**: Proteksi bawaan dari spam/blokir WhatsApp.

---

## 🚀 Cara Menjalankan (Local / Server)

### 1. Menggunakan Docker Compose (Direkomendasikan)

```bash
docker compose up -d --build
```
Akses halaman QR Code: [http://localhost:3001/qr](http://localhost:3001/qr)

### 2. Tanpa Docker (Development)

```bash
npm install
npm run dev
```

---

## 📡 REST API Documentation

Semua permintaan API ke `/api/v1/messages/*` **wajib** menyertakan header:
`X-API-KEY: eeja_wa_gateway_secret_key_2026`

### 1. Cek Status Client WA
- **URL**: `GET /health`
- **Response**:
```json
{
  "name": "gateway-whatsapp-bot",
  "uptime": 120.4,
  "status": "connected",
  "connectedUser": "628123456789",
  "hasQr": false
}
```

### 2. Kirim Pesan Teks
- **URL**: `POST /api/v1/messages/send`
- **Header**: `X-API-KEY: <YOUR_API_KEY>`
- **Body**:
```json
{
  "to": "081234567890",
  "message": "🔔 *JobTracker Notifikasi*\n\nAda email panggilan interview baru!"
}
```

### 3. Kirim Pesan Massal (Bulk Queue)
- **URL**: `POST /api/v1/messages/send-bulk`
- **Header**: `X-API-KEY: <YOUR_API_KEY>`
- **Body**:
```json
{
  "delayMs": 1000,
  "items": [
    { "to": "081234567890", "message": "Pesan 1" },
    { "to": "085712345678", "message": "Pesan 2" }
  ]
}
```

---

## 🔐 Environment Variables

| Variable | Default Value | Keterangan |
| :--- | :--- | :--- |
| `PORT` | `3001` | Port HTTP Server |
| `API_KEY` | `eeja_wa_gateway_secret_key_2026` | Key Keamanan REST API |
| `SESSION_DIR` | `./sessions` | Folder Penyimpanan Auth Key Baileys |

---

## 📄 Lisensi
MIT License © 2026 [Eeja07](https://github.com/Eeja07)
