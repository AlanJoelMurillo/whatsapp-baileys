// main.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys"); // Importa Baileys, gestor de sesión y enum de desconexión
const qrcode = require("qrcode-terminal");  // Imprime QR en terminal
const odbc = require("odbc");               // Cliente ODBC para Sybase
const express = require("express");         // Servidor HTTP ligero
const fs = require("fs");                   // Filesystem para manejar el socket Unix
require("dotenv").config();  
const path = require("path");               // Carga variables de .env a process.env

// 🔹 Variable dinámica para el número de WhatsApp
let phoneNumber = process.env.PHONE;        // Guarda el número que se usará para enviar mensajes; se puede actualizar en caliente

// 🔹 Credenciales de conexión
const credentials = [                       // Arreglo de conexiones a distintas BD, cada una con IP, PASS y un nombre para logs
  { ip: process.env.DB_MPIO3_IP, pass: process.env.DB_MPIO3_PASS, name: process.env.DB_MPIO3_NAME },
  { ip: process.env.DB_MPIO4_IP, pass: process.env.DB_MPIO4_PASS, name: process.env.DB_MPIO4_NAME },
  { ip: process.env.DB_MPIOACT_IP, pass: process.env.DB_MPIOACT_PASS, name: process.env.DB_MPIOACT_NAME },
  { ip: process.env.DB_MPIOAF_IP, pass: process.env.DB_MPIOAF_PASS, name: process.env.DB_MPIOAF_NAME },
  { ip: process.env.DB_MPIOPRE_IP, pass: process.env.DB_MPIOPRE_PASS, name: process.env.DB_MPIOPRE_NAME },
  { ip: process.env.DB_MPIOAE_IP, pass: process.env.DB_MPIOAE_PASS, name: process.env.DB_MPIOAE_NAME },
  { ip: process.env.DB_MPIOPRU_IP, pass: process.env.DB_MPIOPRU_PASS, name: process.env.DB_MPIOPRU_NAME },
];

let sock; // 👈 referencia global al cliente de WhatsApp; permite usarlo en otras funciones (sendAlert, etc.)

async function startSock() {                                        // Inicia (o reinicia) el cliente de WhatsApp
  const { state, saveCreds } = await useMultiFileAuthState("auth_info"); // Crea/lee carpeta auth_info para persistir sesión, y devuelve función para guardar

  sock = makeWASocket({
    auth: state,                                                    // Inyecta el estado de autenticación persistente
    printQRInTerminal: false,                                       // No imprime QR por defecto (lo manejamos en evento)
  });

  sock.ev.on("connection.update", (update) => {                     // Listener de cambios de conexión
    const { connection, lastDisconnect, qr } = update;              // Desestructura el estado, posible error y QR

    if (qr) {                                                       // Si Baileys emite un QR (sesión sin vincular)
      console.log("📲 Escanea este QR para vincular tu WhatsApp:"); // Log amigable
      qrcode.generate(qr, { small: true });                         // Dibuja el QR en la terminal
    }

    if (connection === "open") {                                    // Cuando la conexión se abre correctamente
      console.log("✅ Cliente WhatsApp listo");

      checkDatabases(sock);                                         // Ejecuta el primer chequeo a BD
      setInterval(() => {                                           // Programa chequeos periódicos cada 15s
        checkDatabases(sock);
      }, 15000);
    }

    if (connection === "close") {                                   // Si la conexión se cierra
      const reason = lastDisconnect?.error?.output?.statusCode;     // Intenta extraer el código de causa
      console.log("⚠️ Conexión cerrada", reason);
      if (reason !== DisconnectReason.loggedOut) {                  // Si no es cierre por logout (pérdida de sesión)
        startSock();                                                // Reintenta conexión (relogin) automática
      }
    }
  });
  
  sock.ev.on("messages.upsert", async (m) => {
        try {
            const msg = m.messages[0]
            if (!msg.message) return // mensaje vacío o no soportado

            const from = msg.key.remoteJid
            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                null

            console.log("📩 Nuevo mensaje de:", from)
            if (text) {
                console.log("   Texto:", text)
            } else {
                console.log("   (No se pudo leer el contenido o no es texto)")
            }
        } catch (err) {
            console.error("❌ Error al manejar mensaje:", err)
        }
    })

  sock.ev.on("creds.update", saveCreds);                            // Cada vez que cambian credenciales, persístelas en disco

  return sock;                                                      // Devuelve el socket por si lo necesitas
}

async function checkDatabases(sock) {                               // Recorre todas las credenciales y consulta cada BD
  for (const cred of credentials) {
    await consultaSybase(sock, cred.ip, cred.pass, cred.name);      // Llama secuencialmente (await) para evitar saturar recursos
  }
}

async function consultaSybase(sock, ip, pass, name) {               // Consulta "ping" a una BD específica
  let connectionString;

  try {
    connectionString =                                              // Construye el connection string ODBC
      `Driver={${process.env.DRIVER}};` +                           // Driver ODBC (Devart, FreeTDS, etc.)
      `Server=${ip};` +                                             // IP de la BD
      `Port=5000;` +                                                // Puerto de tu Sybase
      `Database=${process.env.NAME_DB};` +                          // Nombre de BD
      `UID=${process.env.USER_DB};` +                                  // Usuario
      `PWD=${pass};` +                                              // Password (desde credencial particular)
      `TDS_Version=5.0;`;                                           // Versión de protocolo TDS si aplica

    const connection = await odbc.connect(connectionString);        // Abre conexión ODBC
    await connection.query("sp_who2");                              // Ejecuta una consulta ligera (a modo de healthcheck)
    console.log(`[ o ] ${name}`);                                   // Log de OK
    //sendoOk(sock, name);                                          // (Opcional) Aviso de OK por WhatsApp
    await connection.close();                                       // Cierra conexión
  } catch (err) {
    console.error(`[ x ] ${name}`);                                 // Log de KO
    sendAlert(sock, ip, name, err.message);                         // Envía alerta por WhatsApp al número configurado
  }
}

async function sendAlert(sock, ip, name, error) {                   // Arma y envía mensaje de alerta
  const number = `${phoneNumber}@s.whatsapp.net`;                   // Construye el JID con el número dinámico
  const message = `❗❗❗ Falla en servidor ❗❗❗ 
⚠️ Server: ${name} 
🌐 IP: ${ip} 
❌ Error: ${error}
🔎 https://monitoreodb.juarez.gob.mx/`;                              // Texto del mensaje (con link desactivado)

  try {
    await sock.sendMessage(                                         // Envía mensaje de texto
      number,
      { text: message },
      { linkPreview: false }                                        // Evita previsualización del link
    );
    console.log(`📩 Alerta enviada a ${number}`);                   // Log de envío exitoso
  } catch (err) {
    console.error("❌ Error enviando mensaje:", err);               // Log si falla el envío
  }
}

async function sendoOk(sock, name) {                                // (No usado por defecto) Mensaje de OK
  const number = `${phoneNumber}@s.whatsapp.net`;
  const message = `Todo bien en Server: ${name}`;
  try {
    await sock.sendMessage(number, { text: message }, { linkPreview: false });
    console.log(`📩 Mensaje OK enviado a ${number}`);
  } catch (err) {
    console.error("❌ Error enviando mensaje:", err);
  }
}

// 🚀 Servidor HTTP con Unix Socket
function startHttpServer() {                                        // Monta un servidor Express que escucha en /tmp/whatsapp.sock
  const app = express();                                            // Crea instancia de Express
  app.use(express.json());                                          // Habilita parseo de JSON en body

  // Endpoint para actualizar el número
  app.post("/update-phone", (req, res) => {                         // Define ruta POST /update-phone
    const { phone } = req.body;                                     // Extrae "phone" del body JSON
    if (!phone) {                                                   // Valida que venga el número
      return res.status(400).json({ error: "Falta el número de teléfono" });
    }

    phoneNumber = phone;
    updateEnv("PHONE", `521${phone}`);                                            // Actualiza la variable global en caliente
    console.log(`📲 Número actualizado dinámicamente a: ${phoneNumber}`);

    res.json({ ok: true, newPhone: phoneNumber });                  // Responde con el nuevo valor
  });

  const socketPath = "/tmp/whatsapp.sock";                          // Ruta del socket Unix

  // si ya existe el socket viejo, lo eliminamos
  if (fs.existsSync(socketPath)) {                                  // A veces, si la app se cae, el archivo de socket queda
    fs.unlinkSync(socketPath);                                      // Elimínalo antes de volver a abrirlo
  }

  app.listen(socketPath, () => {                                    // En lugar de puerto TCP, escucha en el archivo de socket
    console.log(`📡 Servidor HTTP escuchando en socket: ${socketPath}`);
  });
}


function updateEnv(key, value) {
  const envPath = path.resolve(__dirname, ".env");
  let envConfig = fs.readFileSync(envPath, "utf-8").split("\n");

  let updated = false;

  envConfig = envConfig.map(line => {
    if (line.startsWith(`${key}=`)) {
      updated = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!updated) {
    envConfig.push(`${key}=${value}`);
  }

  fs.writeFileSync(envPath, envConfig.join("\n"));
  console.log(`✅ ${key} actualizado en .env`);
}

// Ejemplo de uso:



startSock();                                                        // Arranca el cliente de WhatsApp
startHttpServer();                                                  // Arranca el servidor HTTP en el socket Unix
