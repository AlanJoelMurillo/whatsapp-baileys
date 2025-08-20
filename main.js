// main.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const odbc = require("odbc");
require("dotenv").config();

// 🔹 Credenciales de conexión
const credentials = [
  { ip: process.env.DB_MPIO3_IP, pass: process.env.DB_MPIO3_PASS, name: process.env.DB_MPIO3_NAME },
  { ip: process.env.DB_MPIO4_IP, pass: process.env.DB_MPIO4_PASS, name: process.env.DB_MPIO4_NAME },
  { ip: process.env.DB_MPIOACT_IP, pass: process.env.DB_MPIOACT_PASS, name: process.env.DB_MPIOACT_NAME },
  { ip: process.env.DB_MPIOAF_IP, pass: process.env.DB_MPIOAF_PASS, name: process.env.DB_MPIOAF_NAME },
  { ip: process.env.DB_MPIOPRE_IP, pass: process.env.DB_MPIOPRE_PASS, name: process.env.DB_MPIOPRE_NAME },
  { ip: process.env.DB_MPIOAE_IP, pass: process.env.DB_MPIOAE_PASS, name: process.env.DB_MPIOAE_NAME },
  { ip: process.env.DB_MPIOPRU_I, pass: process.env.DB_MPIOPRU_PASS, name: process.env.DB_MPIOPRU_NAME },
];

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📲 Escanea este QR para vincular tu WhatsApp:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ Cliente WhatsApp listo");

      checkDatabases(sock);
      setInterval(() => {
        checkDatabases(sock);
      }, 15000);
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log("⚠️ Conexión cerrada", reason);
      if (reason !== DisconnectReason.loggedOut) {
        startSock(); // reconectar
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  return sock;
}

async function checkDatabases(sock) {
  for (const cred of credentials) {
    await consultaSybase(sock, cred.ip, cred.pass, cred.name);
  }
}

async function consultaSybase(sock, ip, pass, name) {
  let connectionString;

  try {
    connectionString =
      `Driver={${process.env.DRIVER}};` +
      `Server=${ip};` +
      `Port=5000;` +
      `Database=${process.env.NAME_DB};` +
      `UID=${process.env.USER};` +
      `PWD=${pass};` +
      `TDS_Version=5.0;`;

    const connection = await odbc.connect(connectionString);
    await connection.query("sp_who2");
    console.log(`[ o ] ${name}`);
    sendoOk(sock, name);
    await connection.close();
  } catch (err) {
    console.error(`[ x ] ${name}`);
    sendAlert(sock, ip, name, err.message);
  }
}

async function sendAlert(sock, ip, name, error) {
  const number = `${process.env.PHONE}@s.whatsapp.net`;
  const message = `❗❗❗ Falla en servidor ❗❗❗ 
⚠️ Server: ${name} 
🌐 IP: ${ip} 
❌ Error: ${error}
🔎 https://monitoreodb.juarez.gob.mx/`;

  try {
    await sock.sendMessage(
      number,
      { text: message },
      { linkPreview: false } // 🚫 desactiva preview de URLs
    );
    console.log(`📩 Alerta enviada a ${number}`);
  } catch (err) {
    console.error("❌ Error enviando mensaje:", err);
  }
}

async function sendoOk(sock, name) {
  const number = `${process.env.PHONE}@s.whatsapp.net`;
  const message = `Todo bien en Server: ${name}`;
  try {
    await sock.sendMessage(
      number,
      { text: message },
      { linkPreview: false } // 🚫 también aquí por si hay URLs
    );
    console.log(`📩 Mensaje OK enviado a ${number}`);
  } catch (err) {
    console.error("❌ Error enviando mensaje:", err);
  }
}

startSock();
