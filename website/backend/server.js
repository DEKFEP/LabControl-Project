import path from "node:path";
import fs from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import { body, validationResult } from "express-validator";
import { db, DB_DIR, reemplazarBaseDesdeBuffer, alRestaurar, baseDisponible, podarTablas, crearCopiaConsistente, cuentasDemoSinRotar } from "./db.js";
import { generaSecreto, verificarCodigo } from "./totp.mjs";
import { iniciarRespaldoProgramado } from "./scripts/respaldo-externo.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

{
  const [mayor, menor] = process.versions.node.split(".").map(Number);
  if (mayor < 22 || (mayor === 22 && menor < 13)) {
    console.error("LabControl requiere Node.js >=22.13.0 (usa .nvmrc con Node 24).");
    process.exit(1);
  }
}

function cargarJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const archivo = path.join(DB_DIR, ".jwt-secret");
  try {
    const existente = fs.readFileSync(archivo, "utf8").trim();
    if (existente) return existente;
  } catch {}
  const generado = randomBytes(48).toString("hex");
  try {
    fs.mkdirSync(DB_DIR, { recursive: true });
    fs.writeFileSync(archivo, generado);
  } catch {}
  return generado;
}
const JWT_SECRET = cargarJwtSecret();
const JWT_REFRESH_EXPIRES = "30d";
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD = 10;
const MAX_PASSWORD_BYTES = 72;
const MAX_PASSWORD_LOGIN = 200;
const PASSWORDS_PROHIBIDAS = new Set([
  "1234567890", "123456789", "contrasena", "contraseña", "password", "password1",
  "password123", "password1234", "qwertyuiop", "qwerty12345", "labcontrol",
  "labcontrol1", "labcontrol123", "liceo12345", "administrador", "administrador1",
  "insuco1336", "insuco12345"
]);

function errorPassword(pw) {
  if (typeof pw !== "string" || pw.length === 0) return "La contraseña es obligatoria";
  if (pw.length < MIN_PASSWORD) return `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`;
  if (Buffer.byteLength(pw, "utf8") > MAX_PASSWORD_BYTES) {
    return `La contraseña no puede superar ${MAX_PASSWORD_BYTES} bytes`;
  }
  if (!/[a-z]/.test(pw)) return "La contraseña debe incluir al menos una letra minúscula";
  if (!/[A-Z]/.test(pw)) return "La contraseña debe incluir al menos una letra mayúscula";
  if (!/[0-9]/.test(pw)) return "La contraseña debe incluir al menos un número";
  if (PASSWORDS_PROHIBIDAS.has(pw.toLowerCase())) return "Esa contraseña es demasiado común; elige otra";
  return null;
}

function reglaPassword(campo) {
  return body(campo)
    .isLength({ min: MIN_PASSWORD })
    .withMessage(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`)
    .bail()
    .custom((pw) => {
      const e = errorPassword(pw);
      if (e) throw new Error(e);
      return true;
    });
}

const SALUD_TOKEN = process.env.LC_SALUD_TOKEN || "";

const REGISTRO_DOMINIOS = String(process.env.LC_REGISTRO_DOMINIOS || "")
  .split(",")
  .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
  .filter(Boolean);

if (!process.env.JWT_SECRET) {
  console.log("  INFO: JWT_SECRET no definido; se usa (o se crea) una clave persistente en la carpeta de datos.");
  console.log("  INFO: Las sesiones sobreviven a los reinicios; en producción define JWT_SECRET como variable de entorno.");
}

if (process.env.LC_TRUST_PROXY) {
  const saltos = Number(process.env.LC_TRUST_PROXY);
  app.set("trust proxy", Number.isInteger(saltos) && saltos > 0 ? saltos : true);
}

function igualSeguro(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
function ipClienteAnclada(req) {
  const secreto = process.env.LC_PROXY_SECRET;
  if (!secreto) return null;
  const recibido = req.headers["x-lc-proxy-secret"];
  if (!recibido || !igualSeguro(recibido, secreto)) return null;
  const ip = String(req.headers["x-lc-client-ip"] || "").trim();
  if (!ip || ip.length > 45) return null;
  return ip;
}
app.use((req, _res, next) => {
  const ip = ipClienteAnclada(req);
  if (ip) Object.defineProperty(req, "ip", { value: ip, writable: true, configurable: true });
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "https://fonts.googleapis.com"],
      styleSrcElem: ["'self'", "https://fonts.googleapis.com"],
      styleSrcAttr: ["'unsafe-inline'"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: "same-origin" }
}));

app.use((_req, res, next) => {
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  next();
});

app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.use("/api", (req, res, next) => {
  if (!baseDisponible()) {
    return res.status(503).json({ error: "La base de datos se está restaurando. Intenta de nuevo en un momento." });
  }
  next();
});

app.use(cors({
  origin: process.env.ORIGIN ? process.env.ORIGIN.split(",") : false,
  credentials: true,
  methods: ["GET", "POST", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "8mb" }));

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.LC_API_LIMIT ? Number(process.env.LC_API_LIMIT) : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas peticiones. Intenta de nuevo en 15 minutos." }
});
app.use("/api/", generalLimiter);

const escrituraLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.LC_ESCRITURA_LIMIT ? Number(process.env.LC_ESCRITURA_LIMIT) : 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS",
  message: { error: "Demasiadas solicitudes. Intenta de nuevo en 1 minuto." }
});
app.use(["/api/usuarios", "/api/agenda", "/api/reportes", "/api/config", "/api/notificaciones", "/api/laboratorios", "/api/solicitudes-especialidad"], escrituraLimiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.LC_LOGIN_LIMIT) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}|${String(req.body?.usuario ?? "").toLowerCase().trim().slice(0, 24)}`,
  validate: false,
  message: { error: "Demasiados intentos de inicio de sesión. Espera 15 minutos." }
});

const registroLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.LC_REGISTRO_LIMIT) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiados intentos de registro. Intenta de nuevo más tarde." }
});

const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.LC_RESET_LIMIT) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}|${String(req.body?.email ?? "").toLowerCase().trim().slice(0, 80)}`,
  validate: false,
  message: { error: "Demasiadas solicitudes de recuperación de contraseña. Espera 1 hora." }
});
app.post("/api/recuperar-contrasena", resetLimiter);

const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas renovaciones de sesión. Intenta de nuevo en 15 minutos." }
});

const sensiblesLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.LC_SENSIBLES_LIMIT) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}|${String(req.user?.id ?? req.body?.usuario ?? "").toLowerCase()}`,
  validate: false,
  message: { error: "Demasiados intentos de verificación. Espera 15 minutos." }
});

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  let token = authHeader && authHeader.split(" ")[1];
  if (!token) token = leerCookie(req, COOKIE_ACCESO);
  if (!token) return res.status(401).json({ error: "Token de autenticación requerido" });

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Sesión expirada. Inicia sesión nuevamente." });
    }
    return res.status(403).json({ error: "Token inválido" });
  }
  if (decoded.tipo && decoded.tipo !== "access") {
    return res.status(403).json({ error: "Token inválido" });
  }

  const cuenta = db.prepare(
    "SELECT id, nombre, apellido, iniciales, rol, nivel_acceso, activo FROM usuarios WHERE id = ?"
  ).get(decoded.id);
  if (!cuenta || Number(cuenta.activo) !== 1) {
    return res.status(401).json({ error: "La cuenta no está activa. Contacta al administrador." });
  }

  req.user = {
    ...decoded,
    rol: cuenta.rol,
    nombre: cuenta.nombre,
    apellido: cuenta.apellido,
    iniciales: cuenta.iniciales,
    nivelAcceso: cuenta.nivel_acceso
  };
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.rol !== "admin") {
    return res.status(403).json({ error: "Se requieren permisos de administrador" });
  }
  next();
}

const COOKIE_ACCESO = "lc_at";
const COOKIE_REFRESCO = "lc_rt";

function leerCookies(req) {
  const crudo = req.headers?.cookie;
  const salida = {};
  if (!crudo) return salida;
  for (const parte of crudo.split(";")) {
    const i = parte.indexOf("=");
    if (i < 0) continue;
    const clave = parte.slice(0, i).trim();
    if (!clave) continue;
    try { salida[clave] = decodeURIComponent(parte.slice(i + 1).trim()); }
    catch { salida[clave] = parte.slice(i + 1).trim(); }
  }
  return salida;
}

function leerCookie(req, nombre) {
  return leerCookies(req)[nombre] || null;
}

function peticionSegura(req) {
  if (String(process.env.LC_PUBLIC_URL || "").trim().startsWith("https://")) return true;
  if (req.secure) return true;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return proto === "https";
}

function opcionesCookie(req) {
  return { httpOnly: true, secure: peticionSegura(req), sameSite: "lax", path: "/" };
}

function fijarCookiesSesion(req, res, token, refreshToken) {
  res.cookie(COOKIE_ACCESO, token, opcionesCookie(req));
  res.cookie(COOKIE_REFRESCO, refreshToken, { ...opcionesCookie(req), maxAge: REFRESH_TOKEN_TTL_MS });
}

function limpiarCookiesSesion(req, res) {
  const opciones = opcionesCookie(req);
  res.clearCookie(COOKIE_ACCESO, opciones);
  res.clearCookie(COOKIE_REFRESCO, opciones);
}

function incluirTokensEnCuerpo(req) {
  return !(req.headers["sec-fetch-mode"] || req.headers["sec-fetch-site"]);
}

function responderSesion(req, res, token, refreshToken, usuario) {
  fijarCookiesSesion(req, res, token, refreshToken);
  const cuerpo = { usuario };
  if (incluirTokensEnCuerpo(req)) {
    cuerpo.token = token;
    cuerpo.refreshToken = refreshToken;
  }
  return res.json(cuerpo);
}

function origenesPermitidos() {
  const lista = [];
  const pub = (process.env.LC_PUBLIC_URL || "").trim();
  if (pub) { try { lista.push(new URL(pub).origin); } catch {} }
  for (const o of String(process.env.ORIGIN || "").split(",")) {
    const t = o.trim();
    if (!t) continue;
    try { lista.push(new URL(t).origin); } catch {}
  }
  return lista;
}

function mismoSitio(req, valor) {
  let origen;
  try { origen = new URL(valor); } catch { return false; }
  const permitidos = origenesPermitidos();
  if (permitidos.length) return permitidos.includes(origen.origin);
  return origen.host.toLowerCase() === String(req.get("host") || "").toLowerCase();
}

function verificarOrigen(req, res, next) {
  const metodo = (req.method || "").toUpperCase();
  if (metodo === "GET" || metodo === "HEAD" || metodo === "OPTIONS") return next();
  if (req.headers["authorization"]) return next();
  if (!leerCookie(req, COOKIE_ACCESO) && !leerCookie(req, COOKIE_REFRESCO)) return next();
  const enviado = req.get("origin") || req.get("referer");
  if (enviado && mismoSitio(req, enviado)) return next();
  return res.status(403).json({ error: "Origen no permitido" });
}
app.use("/api", verificarOrigen);

const LIMITE_MAX = 100;
const LIMITE_DEFAULT = 20;

function paginacionDe(req) {
  const tienePagina = req.query.pagina !== undefined || req.query.page !== undefined;
  const tieneLimite = req.query.limite !== undefined || req.query.limit !== undefined;
  if (!tienePagina && !tieneLimite) return null;

  const limite = Number.parseInt(req.query.limite ?? req.query.limit ?? String(LIMITE_DEFAULT), 10);
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAX) {
    const err = new Error(`El parámetro 'limite' debe ser un entero entre 1 y ${LIMITE_MAX}`);
    err.status = 400;
    throw err;
  }
  const pagina = Number.parseInt(req.query.pagina ?? req.query.page ?? "1", 10);
  return { pagina: Number.isInteger(pagina) && pagina > 0 ? pagina : 1, limite };
}

function responderLista(req, res, elementos) {
  const pag = paginacionDe(req);
  if (!pag) return res.json(elementos);
  const total = elementos.length;
  const inicio = (pag.pagina - 1) * pag.limite;
  res.json({
    data: elementos.slice(inicio, inicio + pag.limite),
    total,
    pagina: pag.pagina,
    totalPaginas: Math.max(1, Math.ceil(total / pag.limite)),
    limite: pag.limite
  });
}

function labFromRow(row) {
  return {
    id: row.id, nombre: row.nombre, sala: row.sala, ubicacion: row.ubicacion,
    equipos: row.equipos, estado: row.estado, so: row.so, procesador: row.procesador,
    ram: row.ram, almacenamiento: row.almacenamiento, red: row.red,
    responsable: row.responsable, responsableId: row.responsable_id,
    horario: row.horario, servicios: JSON.parse(row.servicios || "[]"),
    descripcion: row.descripcion, foto: row.foto,
    imagenes: JSON.parse(row.imagenes || "[]"),
    posicion: { x: row.pos_x, y: row.pos_y, w: row.pos_w, h: row.pos_h }
  };
}

function eqFromRow(row) {
  return {
    id: row.id, labId: row.lab_id, nombre: row.nombre, tipo: row.tipo,
    fabricante: row.fabricante, modelo: row.modelo, serie: row.serie,
    procesador: row.procesador, ram: row.ram, almacenamiento: row.almacenamiento,
    so: row.so, ip: row.ip, mac: row.mac, monitor: row.monitor,
    teclado: row.teclado, mouse: row.mouse, estado: row.estado,
    ultimoEncendido: row.ultimo_encendido, observaciones: row.observaciones
  };
}

function usrFromRow(row) {
  return {
    id: row.id, nombre: row.nombre, apellido: row.apellido, iniciales: row.iniciales,
    email: row.email, rol: row.rol, area: row.area, especialidad: row.especialidad,
    nivelAcceso: row.nivel_acceso, activo: !!row.activo
  };
}

function usrPublico(row) {
  const copia = usrFromRow(row);
  delete copia.email;
  return copia;
}

function puedeVerEmail(req, row) {
  return req.user?.rol === "admin" || String(req.user?.id) === String(row.id);
}

function nivelAccesoDe(req) {
  return String(req.user?.nivelAcceso || "basico");
}

function esTecnico(req) {
  return req.user?.rol === "admin"
    || nivelAccesoDe(req) === "tecnico"
    || nivelAccesoDe(req) === "total";
}

function requireTecnico2FA(req, res, next) {
  if (!esTecnico(req)) {
    return res.status(403).json({ error: "La verificación en dos pasos solo está disponible para cuentas con acceso técnico o de administración" });
  }
  next();
}

function labFromRowVisible(row, req) {
  const lab = labFromRow(row);
  if (esTecnico(req)) return lab;
  const { so, procesador, ram, almacenamiento, red, ...visible } = lab;
  void so; void procesador; void ram; void almacenamiento; void red;
  return visible;
}

function eqFromRowVisible(row, req) {
  const eq = eqFromRow(row);
  if (esTecnico(req)) return eq;
  const { procesador, ram, almacenamiento, so, serie, ip, mac, ...visible } = eq;
  void procesador; void ram; void almacenamiento; void so; void serie; void ip; void mac;
  return visible;
}

function configParaUsuario(config, rol) {
  if (rol === "admin") return config;
  const notificaciones = { ...(config?.notificaciones || {}) };
  delete notificaciones.emailAdmin;
  return { sitio: config?.sitio || {}, notificaciones };
}

function agFromRow(row) {
  return {
    id: row.id, labId: row.lab_id, usuarioId: row.usuario_id, fecha: row.fecha,
    horaInicio: row.hora_inicio, horaFin: row.hora_fin, motivo: row.motivo, estado: row.estado
  };
}

function repFromRow(row, conAdjuntos = true) {
  const adjuntos = parsearJSON(row.adjuntos, []);
  const listaAdjuntos = Array.isArray(adjuntos) ? adjuntos : [];
  const datos = parsearJSON(row.datos, {});
  return {
    id: row.id, tipo: row.tipo, titulo: row.titulo, descripcion: row.descripcion,
    fecha: row.fecha, generadoPor: row.generado_por,
    datos: datos && typeof datos === "object" ? datos : {},
    adjuntos: conAdjuntos
      ? listaAdjuntos
      : listaAdjuntos.map((a) => ({ nombre: a.nombre, tipo: a.tipo, tamano: a.tamano }))
  };
}

function notifFromRow(row) {
  return {
    id: row.id, usuarioId: row.usuario_id, tipo: row.tipo, titulo: row.titulo,
    mensaje: row.mensaje, reporteId: row.reporte_id, solicitudId: row.solicitud_id ?? null,
    usuarioRef: row.usuario_ref ?? null,
    fecha: row.fecha, leida: !!row.leida
  };
}

function solicitudFromRow(row) {
  if (!row) return null;
  return {
    id: row.id, usuarioId: row.usuario_id,
    especialidadActual: row.especialidad_actual,
    especialidadSolicitada: row.especialidad_solicitada,
    estado: row.estado,
    creadaEn: row.creada_en,
    resueltaPor: row.resuelta_por,
    resueltaEn: row.resuelta_en
  };
}

function nombreLab(labId) {
  return db.prepare("SELECT nombre FROM laboratorios WHERE id = ?").get(labId)?.nombre ?? "laboratorio";
}

function prepararRegistroNotificacion({ toggle, tipo, titulo, mensaje, actorId = null, referencia = null, solicitudId = null, usuarioRef = null }) {
  try {
    const cfg = JSON.parse(db.prepare("SELECT data FROM config WHERE id = 1").get()?.data || "{}");
    if (cfg.notificaciones?.[toggle] === false) return null;
    if (!titulo) return null;

    let quien = "Alguien";
    if (actorId != null) {
      const actor = db.prepare("SELECT nombre, apellido FROM usuarios WHERE id = ?").get(actorId);
      if (actor) quien = `${actor.nombre} ${actor.apellido}`;
    }

    return {
      tipo: tipo ?? toggle,
      titulo: String(titulo),
      mensaje: String(mensaje ?? ""),
      quien,
      referencia,
      solicitudId: solicitudId ?? null,
      usuarioRef: usuarioRef ?? null,
      fecha: new Date().toISOString().slice(0, 10)
    };
  } catch {
    return null;
  }
}

function crearNotificacion({ destinatario, ...opciones }) {
  try {
    const registro = prepararRegistroNotificacion(opciones);
    if (!registro || !destinatario) return;
    db.prepare(`
      INSERT INTO notificaciones (usuario_id, tipo, titulo, mensaje, reporte_id, solicitud_id, usuario_ref, fecha, leida)
      VALUES (?,?,?,?,?,?,?,?,0)
    `).run(
      destinatario, registro.tipo, registro.titulo,
      registro.mensaje.replace(/\{quien\}/g, registro.quien),
      registro.referencia, registro.solicitudId, registro.usuarioRef, registro.fecha
    );
    db.prepare(`
      DELETE FROM notificaciones
      WHERE usuario_id = ?
        AND id NOT IN (SELECT id FROM notificaciones WHERE usuario_id = ? ORDER BY id DESC LIMIT 200)
    `).run(destinatario, destinatario);
  } catch (e) {
    console.error("No se pudo registrar la notificación:", e.message);
  }
}

function audFromRow(row) {
  return {
    id: row.id, fecha: row.fecha, usuarioId: row.usuario_id, rol: row.rol,
    accion: row.accion, detalle: JSON.parse(row.detalle || "{}"), ip: row.ip
  };
}

const ACCIONES_SIEMPRE = new Set([
  "login_fallido", "login_ok", "login_2fa_pendiente", "login_2fa_codigo_invalido",
  "2fa_configuracion_iniciada", "2fa_activada", "2fa_desactivada",
  "password_cambiada", "password_restablecida", "refresh_reutilizado",
  "backup_descargado", "backup_restaurado", "configuracion_actualizada",
  "usuario_creado", "usuario_editado", "usuario_registrado", "usuario_eliminado"
]);

function registrarAuditoria(req, accion, detalle = {}, contexto = null) {
  try {
    const cfg = JSON.parse(db.prepare("SELECT data FROM config WHERE id = 1").get()?.data || "{}");
    if (cfg.seguridad?.registroActividad === false && !ACCIONES_SIEMPRE.has(accion)) return;
    const origen = contexto ?? req.user ?? null;
    db.prepare(`INSERT INTO auditoria (fecha, usuario_id, rol, accion, detalle, ip) VALUES (?,?,?,?,?,?)`)
      .run(new Date().toISOString(), origen?.id ?? null, origen?.rol ?? null, accion, JSON.stringify(detalle), String(req.ip || ""));
  } catch {}
}

const DESAFIO_TTL_MS = 5 * 60 * 1000;
const DESAFIO_MAX_INTENTOS = 5;

function limpiarDesafiosVencidos() {
  const ahora = Date.now();
  db.prepare("DELETE FROM desafios_2fa WHERE expira < ?").run(ahora);
  db.prepare("DELETE FROM pendientes_2fa WHERE expira < ?").run(ahora);
}

alRestaurar(() => {
  try {
    db.prepare("DELETE FROM desafios_2fa").run();
    db.prepare("DELETE FROM pendientes_2fa").run();
  } catch (err) {
    console.error("No se pudieron limpiar los desafíos 2FA tras restaurar:", err?.message || err);
  }
});

setInterval(limpiarDesafiosVencidos, 5 * 60 * 1000).unref?.();

function enTransaccion(fn) {
  const punto = `sp_${randomBytes(8).toString("hex")}`;
  db.exec(`SAVEPOINT ${punto}`);
  try {
    const resultado = fn();
    db.exec(`RELEASE ${punto}`);
    return resultado;
  } catch (err) {
    db.exec(`ROLLBACK TO ${punto}`);
    db.exec(`RELEASE ${punto}`);
    throw err;
  }
}

function notificarATodos(opciones) {
  let destinatarios;
  try {
    destinatarios = db.prepare("SELECT id FROM usuarios WHERE activo = 1 AND id != ?").all(opciones.actorId ?? "").map((u) => u.id);
  } catch (e) {
    console.error("No se pudo registrar la notificación:", e.message);
    return;
  }
  if (!destinatarios.length) return;

  const registro = prepararRegistroNotificacion(opciones);
  if (!registro) return;

  try {
    enTransaccion(() => {
      const insertar = db.prepare(`
        INSERT INTO notificaciones (usuario_id, tipo, titulo, mensaje, reporte_id, solicitud_id, usuario_ref, fecha, leida)
        VALUES (?,?,?,?,?,?,?,?,0)
      `);
      const podar = db.prepare(`
        DELETE FROM notificaciones
        WHERE usuario_id = ?
          AND id NOT IN (SELECT id FROM notificaciones WHERE usuario_id = ? ORDER BY id DESC LIMIT 200)
      `);
      const mensaje = registro.mensaje.replace(/\{quien\}/g, registro.quien);
      for (const destinatario of destinatarios) {
        insertar.run(destinatario, registro.tipo, registro.titulo, mensaje,
          registro.referencia, registro.solicitudId, registro.usuarioRef, registro.fecha);
        podar.run(destinatario, destinatario);
      }
    });
  } catch (e) {
    console.error("No se pudo registrar la notificación:", e.message);
  }
}

function notificarCambioReporte(accion, rep, actorId) {
  const esFalla = rep?.tipo === "fallas";
  const textos = esFalla ? {
    creado:    { titulo: "Falla de equipo reportada", mensaje: `{quien} registró la falla "${rep.titulo}".` },
    editado:   { titulo: "Falla actualizada",         mensaje: `{quien} actualizó la falla "${rep.titulo}".` },
    eliminado: { titulo: "Falla eliminada",           mensaje: `{quien} eliminó el registro de falla "${rep.titulo}".` }
  } : {
    creado:    { titulo: "Nuevo reporte disponible",  mensaje: `{quien} generó el reporte "${rep.titulo}".` },
    editado:   { titulo: "Reporte actualizado",       mensaje: `{quien} editó el reporte "${rep.titulo}".` },
    eliminado: { titulo: "Reporte eliminado",         mensaje: `{quien} eliminó el reporte "${rep.titulo}".` }
  };
  const texto = textos[accion];
  if (!texto) return;
  notificarATodos({
    toggle: esFalla ? "alertaFallas" : "alertaReportes",
    tipo: accion,
    titulo: texto.titulo,
    mensaje: texto.mensaje,
    actorId,
    referencia: accion === "eliminado" ? null : rep.id
  });
}

const ETIQUETAS_ESTADO = { disponible: "Disponible", ocupado: "Ocupado", mantencion: "Mantención" };
function notificarCambioEstadoLab(lab, estadoNuevo, estadoAnterior, actorId) {
  if (!lab || estadoNuevo === estadoAnterior) return;
  notificarATodos({
    toggle: "alertaDisponibilidad",
    tipo: "laboratorio",
    titulo: "Estado de laboratorio actualizado",
    mensaje: `{quien} marcó ${lab.nombre} como "${ETIQUETAS_ESTADO[estadoNuevo] ?? estadoNuevo}".`,
    actorId
  });
}

function notificarNuevaReserva(reserva, actorId) {
  const lab = nombreLab(reserva.labId);
  const horario = `${reserva.horaInicio ?? "—"}${reserva.horaFin ? ` - ${reserva.horaFin}` : ""}`;
  crearNotificacion({
    toggle: "alertaReservas",
    tipo: "reserva_confirmada",
    titulo: "Reserva registrada",
    mensaje: `Tu reserva de ${lab} para el ${reserva.fecha} (${horario}) quedó registrada y espera confirmación.`,
    destinatario: reserva.usuarioId
  });
  notificarATodos({
    toggle: "alertaReservas",
    tipo: "reserva",
    titulo: "Nueva reserva de laboratorio",
    mensaje: `{quien} reservó ${lab} para el ${reserva.fecha} (${horario}).`,
    actorId
  });
}

function notificarReservaCancelada(reserva, actorId) {
  if (!reserva) return;
  const lab = nombreLab(reserva.labId);
  notificarATodos({
    toggle: "alertaReservas",
    tipo: "reserva_cancelada",
    titulo: "Reserva cancelada",
    mensaje: `{quien} canceló la reserva de ${lab} para el ${reserva.fecha}.`,
    actorId
  });
}

function puedeModificarReporte(rep, req) {
  const uid = req.user?.id;
  if (!uid) return false;
  if (req.user?.rol === "admin") return true;
  return rep.generado_por === uid;
}

const MAX_ARCHIVO_ADJUNTO = 5 * 1024 * 1024;
const MAX_ARCHIVOS = 10;
const TIPOS_ADJUNTO = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain", "text/csv",
  "application/zip", "application/x-rar-compressed"
]);

const TIPO_REAL_ADMISIBLE = {
  "image/png": ["image/png"],
  "image/jpeg": ["image/jpeg"],
  "image/gif": ["image/gif"],
  "image/webp": ["image/webp"],
  "application/pdf": ["application/pdf"],
  "application/msword": ["application/msword"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["application/zip"],
  "application/zip": ["application/zip"],
  "application/x-rar-compressed": ["application/x-rar-compressed"]
};

function detectarMimeAdjunto(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buf.slice(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return "application/msword";
  if (buf[0] === 0x50 && buf[1] === 0x4b) return "application/zip";
  if (buf.slice(0, 7).toString("latin1") === "Rar!\x1a\x07") return "application/x-rar-compressed";
  return null;
}

function cuerpoBase64(data) {
  const coma = data.indexOf(",");
  return coma < 0 ? "" : data.slice(coma + 1);
}

function contenidoTextoValido(t, data) {
  if (t !== "text/plain" && t !== "text/csv") return false;
  try {
    const texto = Buffer.from(cuerpoBase64(data), "base64").toString("utf8");
    return texto.length > 0 && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(texto);
  } catch { return false; }
}

function sanitizarAdjuntos(adjuntos) {
  if (!Array.isArray(adjuntos)) return [];
  const resultado = [];
  for (const a of adjuntos.slice(0, MAX_ARCHIVOS)) {
    if (!a || typeof a !== "object") continue;
    const data = typeof a.data === "string" ? a.data : "";
    const t = String(a.tipo || "").toLowerCase();
    const tamano = Number(a.tamano) || 0;
    const cuerpo = /^data:[^,]*;base64,/.test(data) ? cuerpoBase64(data) : "";
    const bytes = cuerpo ? Buffer.from(cuerpo, "base64").length : 0;
    const valido =
      t && TIPOS_ADJUNTO.has(t) &&
      Number.isInteger(tamano) && tamano > 0 && tamano <= MAX_ARCHIVO_ADJUNTO &&
      bytes > 0 && bytes <= MAX_ARCHIVO_ADJUNTO &&
      data.length <= Math.ceil(MAX_ARCHIVO_ADJUNTO * 4 / 3) + 1024 &&
      /^data:(image|application|text)\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=\r\n]*$/.test(data) &&
      data.startsWith(`data:${t};base64,`) &&
      (t === "text/plain" || t === "text/csv"
        ? contenidoTextoValido(t, data)
        : TIPO_REAL_ADMISIBLE[t]?.includes(detectarMimeAdjunto(Buffer.from(cuerpo, "base64"))));
    if (!valido) continue;
    resultado.push({
      nombre: String(a.nombre ?? "archivo").replace(/[^\w.\- ]/gi, "").slice(0, 120) || "archivo",
      tipo: t,
      tamano,
      data
    });
  }
  return resultado;
}

function sanitizarTexto(valor, max = 5000) {
  if (typeof valor !== "string") return "";
  return String(valor).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, max);
}

function esFechaISOValida(valor) {
  if (typeof valor !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor);
  if (!m) return false;
  const anio = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return false;
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  return fecha.getUTCFullYear() === anio
    && fecha.getUTCMonth() === mes - 1
    && fecha.getUTCDate() === dia;
}

const MAX_DATOS_REPORTE = 256 * 1024;

const CLAVES_NO_DATOS = new Set(["__proto__", "constructor", "prototype"]);

function limpiarDatosLibres(valor, profundidad = 0) {
  if (profundidad > 12) return null;
  if (valor === null || typeof valor === "string" || typeof valor === "boolean") return valor;
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;
  if (Array.isArray(valor)) return valor.map((v) => limpiarDatosLibres(v, profundidad + 1));
  if (typeof valor === "object") {
    const salida = {};
    for (const [clave, v] of Object.entries(valor)) {
      if (CLAVES_NO_DATOS.has(clave)) continue;
      salida[clave] = limpiarDatosLibres(v, profundidad + 1);
    }
    return salida;
  }
  return null;
}

function parsearJSON(texto, porDefecto) {
  try {
    const valor = JSON.parse(texto || "");
    return valor === null || valor === undefined ? porDefecto : valor;
  } catch {
    return porDefecto;
  }
}

function serializarDatos(datos) {
  if (datos === undefined || datos === null) return "{}";
  if (typeof datos !== "object") {
    const e = new Error("El contenido del reporte debe ser un objeto o una lista");
    e.status = 400;
    throw e;
  }
  const limpio = limpiarDatosLibres(datos);
  if (limpio === null || typeof limpio !== "object") {
    const e = new Error("El contenido del reporte debe ser un objeto o una lista");
    e.status = 400;
    throw e;
  }
  const texto = JSON.stringify(limpio);
  if (texto.length > MAX_DATOS_REPORTE) {
    const e = new Error(`El contenido del reporte supera el máximo de ${MAX_DATOS_REPORTE / 1024} KB`);
    e.status = 400;
    throw e;
  }
  return texto;
}

function nuevoId(prefijo, sugerido, tabla = null) {
  const candidato = typeof sugerido === "string" ? sugerido.trim() : "";
  if (candidato && /^[A-Za-z0-9_]{1,32}$/.test(candidato) && !idEnUso(tabla, candidato)) return candidato;
  let generado = "";
  do {
    generado = `${prefijo}_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  } while (idEnUso(tabla, generado));
  return generado;
}

function idEnUso(tabla, id) {
  if (!tabla) return false;
  try {
    return !!db.prepare(`SELECT 1 FROM ${tabla} WHERE id = ?`).get(id);
  } catch { return true; }
}

function escaparLike(texto) {
  return texto.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function ttlAcceso() {
  if (process.env.LC_JWT_EXPIRES) return process.env.LC_JWT_EXPIRES;
  const minutos = Number(JSON.parse(
    db.prepare("SELECT data FROM config WHERE id = 1").get()?.data || "{}"
  )?.seguridad?.sesionTimeout);
  const topeMin = Number.isFinite(minutos) && minutos > 0 ? minutos : 30;
  const segundos = Math.min(Math.max(topeMin, 5) * 60, 2 * 60 * 60);
  return `${segundos}s`;
}

function firmarAcceso(fila) {
  return jwt.sign(
    { tipo: "access", id: fila.id, rol: fila.rol, nombre: fila.nombre, apellido: fila.apellido, iniciales: fila.iniciales, nivelAcceso: fila.nivel_acceso },
    JWT_SECRET,
    { expiresIn: ttlAcceso() }
  );
}

function limpiarTokensVencidos() {
  db.prepare("DELETE FROM refresh_tokens WHERE expira_en < ?").run(Date.now());
}

function emitirRefreshToken(usuarioId) {
  limpiarTokensVencidos();
  const id = randomBytes(32).toString("hex");
  const ahora = Date.now();
  db.prepare("INSERT INTO refresh_tokens (id, usuario_id, creado_en, expira_en, revocado) VALUES (?,?,?,?,0)")
    .run(id, usuarioId, ahora, ahora + REFRESH_TOKEN_TTL_MS);
  db.prepare(`
    DELETE FROM refresh_tokens
    WHERE usuario_id = ? AND revocado = 1
      AND id NOT IN (SELECT id FROM refresh_tokens WHERE usuario_id = ? ORDER BY creado_en DESC LIMIT 5)
  `).run(usuarioId, usuarioId);
  return jwt.sign(
    { tipo: "refresh", id, sub: usuarioId },
    JWT_SECRET,
    { expiresIn: JWT_REFRESH_EXPIRES }
  );
}

db.exec("CREATE INDEX IF NOT EXISTS idx_notificaciones_usuario ON notificaciones(usuario_id, id)");
const temporizadorLimpieza = setInterval(() => {
  try {
    const podadas = podarTablas();
    if (podadas) {
      const total = Object.values(podadas).reduce((a, b) => a + b, 0);
      console.log(`Limpieza periódica: ${total} registro(s) antiguos eliminados (${Object.keys(podadas).join(", ")}).`);
    }
  } catch (err) {
    console.error("Fallo en la limpieza periódica:", err?.message || err);
  }
}, 15 * 60 * 1000);
temporizadorLimpieza.unref?.();

iniciarRespaldoProgramado({ logger: console });

app.post("/api/login", loginLimiter, async (req, res) => {
  const { usuario, password } = req.body || {};

  if (typeof usuario !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "El usuario y la contraseña deben ser texto" });
  }
  const identificador = usuario.trim();
  if (!identificador || !password) return res.status(400).json({ error: "Faltan credenciales" });
  if (identificador.length > 254 || password.length > MAX_PASSWORD_LOGIN) {
    return res.status(400).json({ error: "Credenciales no válidas" });
  }

  const row = db.prepare(`
    SELECT * FROM usuarios
    WHERE (id = ? OR lower(email) = lower(?)) AND activo = 1
  `).get(identificador, identificador);

  const hashFicticio = "$2a$10$ejPcmjH1Njlwe/IlvwtMK.3Wjjl5KKIo3LwiNO4kwqGB6ffG.3R2C";
  const passwordValido = await bcrypt.compare(password, row ? row.password : hashFicticio);
  if (!row || !passwordValido) {
    registrarAuditoria(req, "login_fallido", { usuario: identificador.slice(0, 60) });
    return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
  }

  if (row.totp_habilitado === 1 && row.totp_secreto) {
    limpiarDesafiosVencidos();
    const loginId = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO desafios_2fa (login_id, usuario_id, expira, intentos) VALUES (?, ?, ?, 0)")
      .run(loginId, row.id, Date.now() + DESAFIO_TTL_MS);
    registrarAuditoria(req, "login_2fa_pendiente", { usuario: row.id }, { id: row.id, rol: row.rol });
    return res.json({ requires2FA: true, loginId, usuario: usrFromRow(row) });
  }

  registrarAuditoria(req, "login_ok", { usuario: row.id }, { id: row.id, rol: row.rol });
  const token = firmarAcceso(row);
  const refreshToken = emitirRefreshToken(row.id);

  responderSesion(req, res, token, refreshToken, usrFromRow(row));
});

app.post("/api/login/2fa", loginLimiter, (req, res) => {
  const { loginId, codigo } = req.body || {};
  if (typeof loginId !== "string" || typeof codigo !== "string" || !loginId || !codigo) {
    return res.status(400).json({ error: "Faltan el identificador de inicio de sesión y el código" });
  }

  const desafio = db.prepare("SELECT usuario_id, expira, intentos FROM desafios_2fa WHERE login_id = ?").get(loginId);
  if (!desafio || desafio.expira < Date.now()) {
    db.prepare("DELETE FROM desafios_2fa WHERE login_id = ?").run(loginId);
    return res.status(401).json({ error: "El intento de verificación expiró. Inicia sesión nuevamente." });
  }
  if (desafio.intentos >= DESAFIO_MAX_INTENTOS) {
    db.prepare("DELETE FROM desafios_2fa WHERE login_id = ?").run(loginId);
    return res.status(429).json({ error: "Demasiados intentos. Inicia sesión nuevamente." });
  }

  const row = db.prepare("SELECT * FROM usuarios WHERE id = ? AND activo = 1").get(desafio.usuario_id);
  if (!row || row.totp_habilitado !== 1 || !row.totp_secreto) {
    db.prepare("DELETE FROM desafios_2fa WHERE login_id = ?").run(loginId);
    return res.status(401).json({ error: "La verificación no está disponible. Inicia sesión nuevamente." });
  }

  if (!verificarCodigo(row.totp_secreto, String(codigo))) {
    db.prepare("UPDATE desafios_2fa SET intentos = intentos + 1 WHERE login_id = ?").run(loginId);
    registrarAuditoria(req, "login_2fa_codigo_invalido", { usuario: row.id }, { id: row.id, rol: row.rol });
    return res.status(401).json({ error: "El código de verificación es incorrecto" });
  }

  db.prepare("DELETE FROM desafios_2fa WHERE login_id = ?").run(loginId);
  registrarAuditoria(req, "login_ok", { usuario: row.id, con2fa: true }, { id: row.id, rol: row.rol });
  const token = firmarAcceso(row);
  const refreshToken = emitirRefreshToken(row.id);
  responderSesion(req, res, token, refreshToken, usrFromRow(row));
});

app.get("/api/salud", (req, res) => {
  const detallado = SALUD_TOKEN && igualSeguro(String(req.headers["x-lc-salud-token"] || ""), SALUD_TOKEN);
  res.json(detallado
    ? {
        ok: true,
        servicio: "labcontrol-api",
        version: "4.9",
        cuentasDemoPendientes: cuentasDemoSinRotar().length
      }
    : { ok: true });
});

app.get("/api/2fa/estado", authenticateToken, (req, res) => {
  const fila = db.prepare("SELECT totp_habilitado FROM usuarios WHERE id = ?").get(req.user.id);
  res.json({ habilitado: fila?.totp_habilitado === 1 });
});

app.post("/api/2fa/setup", authenticateToken, requireTecnico2FA, async (req, res) => {
  const fila = db.prepare("SELECT totp_habilitado FROM usuarios WHERE id = ?").get(req.user.id);
  if (fila?.totp_habilitado === 1) {
    return res.status(409).json({ error: "La verificación en dos pasos ya está activada" });
  }

  const secreto = generaSecreto();
  const emisor = "Liceo INSUCO - LabControl";
  const otpauth = `otpauth://totp/${encodeURIComponent(emisor)}:${encodeURIComponent(req.user.id)}?secret=${secreto}&issuer=${encodeURIComponent(emisor)}&algorithm=SHA1&digits=6&period=30`;

  let qrDataUrl = "";
  try {
    qrDataUrl = await QRCode.toDataURL(otpauth, { margin: 1, width: 220, color: { dark: "#1f2937", light: "#ffffff" } });
  } catch {}

  db.prepare(`
    INSERT INTO pendientes_2fa (usuario_id, secreto, expira) VALUES (?, ?, ?)
    ON CONFLICT(usuario_id) DO UPDATE SET secreto = excluded.secreto, expira = excluded.expira
  `).run(req.user.id, secreto, Date.now() + DESAFIO_TTL_MS);
  registrarAuditoria(req, "2fa_configuracion_iniciada");
  res.json({ secreto, otpauthUrl: otpauth, qrDataUrl });
});

app.post("/api/2fa/verificar", authenticateToken, requireTecnico2FA, sensiblesLimiter, (req, res) => {
  const { codigo } = req.body || {};
  if (!codigo) return res.status(400).json({ error: "Falta el código de verificación" });

  const pendiente = db.prepare("SELECT secreto, expira FROM pendientes_2fa WHERE usuario_id = ?").get(req.user.id);
  if (!pendiente || pendiente.expira < Date.now()) {
    db.prepare("DELETE FROM pendientes_2fa WHERE usuario_id = ?").run(req.user.id);
    return res.status(410).json({ error: "La configuración expiró. Vuelve a iniciarla." });
  }
  if (!verificarCodigo(pendiente.secreto, String(codigo))) {
    return res.status(401).json({ error: "El código de verificación es incorrecto" });
  }

  db.prepare("UPDATE usuarios SET totp_secreto = ?, totp_habilitado = 1 WHERE id = ?")
    .run(pendiente.secreto, req.user.id);
  db.prepare("DELETE FROM pendientes_2fa WHERE usuario_id = ?").run(req.user.id);
  registrarAuditoria(req, "2fa_activada");
  res.json({ ok: true });
});

app.post("/api/2fa/desactivar", authenticateToken, sensiblesLimiter, (req, res) => {
  const { codigo } = req.body || {};
  const fila = db.prepare("SELECT totp_secreto, totp_habilitado FROM usuarios WHERE id = ?").get(req.user.id);
  if (!fila || fila.totp_habilitado !== 1) {
    return res.status(400).json({ error: "La verificación en dos pasos no está activada" });
  }
  if (!codigo) {
    return res.status(400).json({ error: "El código de verificación es obligatorio para desactivar" });
  }
  if (!verificarCodigo(fila.totp_secreto, String(codigo))) {
    return res.status(401).json({ error: "El código de verificación es incorrecto" });
  }

  db.prepare("UPDATE usuarios SET totp_secreto = NULL, totp_habilitado = 0 WHERE id = ?").run(req.user.id);
  registrarAuditoria(req, "2fa_desactivada");
  res.json({ ok: true });
});

app.get("/api/auditoria", authenticateToken, requireAdmin, (req, res) => {
  const condiciones = [];
  const valores = [];

  const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
  if (q) {
    const patron = `%${escaparLike(q)}%`;
    condiciones.push(`(accion LIKE ? ESCAPE '\\' OR IFNULL(usuario_id, '') LIKE ? ESCAPE '\\' OR IFNULL(rol, '') LIKE ? ESCAPE '\\' OR IFNULL(detalle, '') LIKE ? ESCAPE '\\')`);
    for (let i = 0; i < 4; i++) valores.push(patron);
  }
  const usuario = typeof req.query.usuario === "string" ? req.query.usuario.trim().slice(0, 80) : "";
  if (usuario) {
    condiciones.push("usuario_id = ?");
    valores.push(usuario);
  }
  const desde = typeof req.query.desde === "string" ? req.query.desde.trim() : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
    condiciones.push("substr(fecha, 1, 10) >= ?");
    valores.push(desde);
  }
  const hasta = typeof req.query.hasta === "string" ? req.query.hasta.trim() : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
    condiciones.push("substr(fecha, 1, 10) <= ?");
    valores.push(hasta);
  }

  const where = condiciones.length ? ` WHERE ${condiciones.join(" AND ")}` : "";
  const pag = paginacionDe(req);
  const limite = pag ? pag.limite : 1000;
  const offset = pag ? (pag.pagina - 1) * pag.limite : 0;

  const total = db.prepare(`SELECT COUNT(*) AS n FROM auditoria${where}`).get(...valores).n;
  const rows = db.prepare(`SELECT * FROM auditoria${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...valores, limite, offset);

  if (!pag) return res.json(rows.map(audFromRow));
  res.json({
    data: rows.map(audFromRow),
    total,
    pagina: pag.pagina,
    totalPaginas: Math.max(1, Math.ceil(total / pag.limite)),
    limite: pag.limite
  });
});

app.get("/api/backups/exportar", authenticateToken, requireAdmin, (req, res) => {
  const nombre = `labcontrol-backup-${new Date().toISOString().slice(0, 10)}-${Date.now()}.db`;
  let copia;
  try {
    copia = crearCopiaConsistente();
  } catch (err) {
    return res.status(err?.status || 500).json({
      error: err?.message || "No se pudo preparar la copia de seguridad"
    });
  }

  registrarAuditoria(req, "backup_descargado");

  res.setHeader("Content-Type", "application/octet-stream");
  res.download(copia, nombre, { dotfiles: "allow" }, (err) => {
    fs.rm(copia, { force: true }, () => {});
    if (!err) return;
    console.error("No se pudo enviar la copia de seguridad:", err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: "No se pudo enviar la copia de seguridad" });
    } else if (!res.writableEnded) {
      res.end();
    }
  });
});

app.post("/api/backups/restaurar", authenticateToken, requireAdmin,
  express.raw({ type: ["application/octet-stream", "application/x-sqlite3", "application/vnd.sqlite3"], limit: "60mb" }),
  async (req, res) => {
    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return res.status(400).json({ error: "No se recibió ningún archivo" });
    }
    try {
      await reemplazarBaseDesdeBuffer(buffer);
    } catch (err) {
      const status = err?.status || 400;
      return res.status(status).json({
        error: status === 400 ? err.message : "No se pudo restaurar el respaldo. La base anterior fue conservada."
      });
    }
    try { registrarAuditoria(req, "backup_restaurado"); } catch {}
    res.json({ ok: true });
  }
);

app.post("/api/refresh", refreshLimiter, (req, res) => {
  const refreshToken = (req.body && req.body.refreshToken) || leerCookie(req, COOKIE_REFRESCO);
  if (typeof refreshToken !== "string" || !refreshToken) {
    return res.status(400).json({ error: "Falta el token de refresco" });
  }

  let decoded;
  try {
    decoded = jwt.verify(refreshToken, JWT_SECRET);
  } catch {
    limpiarCookiesSesion(req, res);
    return res.status(401).json({ error: "Sesión expirada. Inicia sesión nuevamente." });
  }
  if (decoded.tipo !== "refresh" || !decoded.id) {
    limpiarCookiesSesion(req, res);
    return res.status(403).json({ error: "Token de refresco inválido" });
  }

  const fila = db.prepare("SELECT usuario_id, revocado, expira_en FROM refresh_tokens WHERE id = ?").get(decoded.id);
  if (!fila) {
    if (decoded.sub) {
      db.prepare("UPDATE refresh_tokens SET revocado = 1 WHERE usuario_id = ? AND revocado = 0")
        .run(decoded.sub);
      const usuarioSospechoso = db.prepare("SELECT id, rol FROM usuarios WHERE id = ?").get(decoded.sub);
      registrarAuditoria(
        req, "refresh_reutilizado",
        { usuario: decoded.sub, motivo: "fila_ausente" },
        usuarioSospechoso ?? null
      );
    }
    limpiarCookiesSesion(req, res);
    return res.status(401).json({ error: "Sesión expirada. Inicia sesión nuevamente." });
  }
  if (fila.revocado === 1) {
    const abiertas = db.prepare(
      "SELECT COUNT(*) AS n FROM refresh_tokens WHERE usuario_id = ? AND revocado = 0"
    ).get(fila.usuario_id).n;
    if (abiertas > 0) {
      db.prepare("UPDATE refresh_tokens SET revocado = 1 WHERE usuario_id = ? AND revocado = 0")
        .run(fila.usuario_id);
      const usuarioSospechoso = db.prepare("SELECT id, rol FROM usuarios WHERE id = ?").get(fila.usuario_id);
      registrarAuditoria(req, "refresh_reutilizado", { usuario: fila.usuario_id }, usuarioSospechoso ?? null);
    }
    limpiarCookiesSesion(req, res);
    return res.status(401).json({ error: "Sesión expirada. Inicia sesión nuevamente." });
  }
  if (fila.expira_en < Date.now()) {
    limpiarCookiesSesion(req, res);
    return res.status(401).json({ error: "Sesión expirada. Inicia sesión nuevamente." });
  }

  const usuario = db.prepare("SELECT * FROM usuarios WHERE id = ? AND activo = 1").get(decoded.sub);
  if (!usuario) {
    limpiarCookiesSesion(req, res);
    return res.status(401).json({ error: "Usuario no encontrado" });
  }

  db.prepare("UPDATE refresh_tokens SET revocado = 1 WHERE id = ?").run(decoded.id);
  const nuevoRefresh = emitirRefreshToken(usuario.id);

  responderSesion(req, res, firmarAcceso(usuario), nuevoRefresh, usrFromRow(usuario));
});

app.post("/api/logout", refreshLimiter, (req, res) => {
  const refreshToken = (req.body && req.body.refreshToken) || leerCookie(req, COOKIE_REFRESCO);
  let usuarioLogout = null;
  if (typeof refreshToken === "string" && refreshToken) {
    try {
      const decoded = jwt.verify(refreshToken, JWT_SECRET);
      if (decoded.tipo === "refresh" && decoded.id) {
        usuarioLogout = decoded.sub ?? null;
        db.prepare("UPDATE refresh_tokens SET revocado = 1 WHERE id = ?").run(decoded.id);
      }
    } catch {}
  }
  limpiarCookiesSesion(req, res);
  registrarAuditoria(req, "logout", { usuario: usuarioLogout });
  res.json({ ok: true });
});

app.get("/api/me", authenticateToken, (req, res) => {
  const fila = db.prepare("SELECT * FROM usuarios WHERE id = ? AND activo = 1").get(req.user.id);
  if (!fila) return res.status(401).json({ error: "La cuenta no está activa" });
  res.json({ usuario: usrFromRow(fila) });
});

app.post("/api/change-password", authenticateToken, sensiblesLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  }
  const errPassword = errorPassword(newPassword);
  if (errPassword) {
    return res.status(400).json({ error: errPassword });
  }

  const row = db.prepare("SELECT * FROM usuarios WHERE id = ?").get(req.user.id);
  if (!row) return res.status(404).json({ error: "Usuario no encontrado" });

  if (!(await bcrypt.compare(currentPassword, row.password))) {
    return res.status(401).json({ error: "La contraseña actual es incorrecta" });
  }

  const hashed = await bcrypt.hash(newPassword, 10);
  db.prepare("UPDATE usuarios SET password = ? WHERE id = ?").run(hashed, req.user.id);
  db.prepare("UPDATE refresh_tokens SET revocado = 1 WHERE usuario_id = ?").run(req.user.id);
  registrarAuditoria(req, "password_cambiada");
  res.json({ ok: true, message: "Contraseña actualizada correctamente" });
});

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const PRODUCCION = process.env.NODE_ENV === "production";

const hashResetToken = (token) => createHash("sha256").update(String(token)).digest("hex");

function limpiarResetsExpirados() {
  db.prepare("DELETE FROM contrasena_resets WHERE expira_en < ?").run(Date.now());
}

setInterval(() => {
  try {
    limpiarResetsExpirados();
  } catch (err) {
    console.error("Fallo en la limpieza de resets expirados:", err?.message || err);
  }
}, 10 * 60 * 1000).unref?.();

async function enviarCorreoReseteo(email, enlace) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log("  [Recuperar contraseña] solicitud recibida; sin RESEND_API_KEY no se envía correo.");
    return;
  }
  const from = process.env.RESEND_FROM || "LabControl <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "Restablece tu contraseña de LabControl",
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
          <h2>Restablece tu contraseña</h2>
          <p>Recibimos una solicitud para restablecer la contraseña de tu cuenta en LabControl.</p>
          <p><a href="${enlace}">Restablecer mi contraseña</a></p>
          <p style="font-size:13px;color:#555">El enlace expira en 30 minutos. Si no solicitaste este cambio, ignora este correo.</p>
        </div>`
    })
  });
  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    console.error(`Error al enviar correo de restablecimiento a ${email}: ${res.status} ${errorText}`);
  }
}

function urlBasePublico() {
  const fija = (process.env.LC_PUBLIC_URL || "").trim();
  if (fija) return fija.replace(/\/+$/, "");
  return `http://localhost:${PORT}`;
}

app.post("/api/recuperar-contrasena", (req, res) => {
  if (PRODUCCION && !process.env.RESEND_API_KEY) {
    return res.status(503).json({ error: "La recuperación de contraseña no está disponible en este momento." });
  }
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Ingresa un correo válido" });
  }

  const usuario = db.prepare("SELECT id, email FROM usuarios WHERE lower(email) = ? AND activo = 1").get(email);
  if (usuario) {
    limpiarResetsExpirados();
    db.prepare("DELETE FROM contrasena_resets WHERE usuario_id = ?").run(usuario.id);
    const token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO contrasena_resets (token, usuario_id, expira_en, usado) VALUES (?,?,?,0)")
      .run(hashResetToken(token), usuario.id, Date.now() + RESET_TOKEN_TTL_MS);
    registrarAuditoria(req, "recuperacion_solicitada", { usuario: usuario.id });
    const enlace = `${urlBasePublico()}/login?reset=${token}`;
    enviarCorreoReseteo(usuario.email, enlace)
      .catch((e) => console.error("No se pudo enviar el correo de restablecimiento:", e?.message || e));
  }
  res.json({ ok: true });
});

app.post("/api/recuperar-contrasena/:token", [
  reglaPassword("newPassword")
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: "Datos inválidos", details: errors.array() });
  }

  limpiarResetsExpirados();
  const tokenHash = hashResetToken(req.params.token);
  const fila = db.prepare("SELECT * FROM contrasena_resets WHERE token = ? AND usado = 0").get(tokenHash);
  if (!fila) return res.status(400).json({ error: "El enlace de restablecimiento es inválido o expiró" });

  const usuario = db.prepare("SELECT id FROM usuarios WHERE id = ? AND activo = 1").get(fila.usuario_id);
  if (!usuario) return res.status(404).json({ error: "Usuario no encontrado" });

  const hashed = await bcrypt.hash(req.body.newPassword, 10);
  db.prepare("UPDATE usuarios SET password = ? WHERE id = ?").run(hashed, fila.usuario_id);
  db.prepare("UPDATE contrasena_resets SET usado = 1 WHERE token = ?").run(tokenHash);
  db.prepare("DELETE FROM contrasena_resets WHERE usuario_id = ? AND token != ?").run(fila.usuario_id, tokenHash);
  db.prepare("UPDATE refresh_tokens SET revocado = 1 WHERE usuario_id = ?").run(fila.usuario_id);
  registrarAuditoria(req, "password_restablecida", { usuario: fila.usuario_id });
  res.json({ ok: true, message: "Contraseña actualizada. Inicia sesión con tu nueva contraseña." });
});

app.post("/api/registro", registroLimiter, [
  body("id").trim().matches(/^[a-zA-Z0-9_]{1,32}$/).withMessage("El usuario debe tener entre 1 y 32 caracteres: letras, números y guion bajo"),
  body("nombre").trim().notEmpty().withMessage("El nombre es obligatorio"),
  body("apellido").trim().notEmpty().withMessage("El apellido es obligatorio"),
  body("email").isEmail().withMessage("El correo debe ser válido"),
  reglaPassword("password"),
  body("area").optional({ values: "falsy" }).trim().isLength({ max: 100 }).withMessage("El área no puede superar 100 caracteres"),
  body("especialidad").optional({ values: "falsy" }).trim().isLength({ max: 200 }).withMessage("La especialidad no puede superar 200 caracteres")
], async (req, res) => {
  if (REGISTRO_DOMINIOS.length === 0) {
    return res.status(403).json({ error: "El registro público está cerrado. Solicita tu cuenta al administrador." });
  }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: "Datos inválidos", details: errors.array() });
  }

  const u = req.body;
  u.id = String(u.id ?? "").trim();
  u.email = String(u.email ?? "").trim().toLowerCase();

  const dominio = u.email.split("@")[1] ?? "";
  if (!REGISTRO_DOMINIOS.includes(dominio)) {
    return res.status(403).json({
      error: `Solo se permite el registro con correos de ${REGISTRO_DOMINIOS.map((d) => "@" + d).join(", ")}.`
    });
  }

  if (db.prepare("SELECT id FROM usuarios WHERE id = ?").get(u.id)) {
    return res.status(409).json({ error: "Ya existe una cuenta con ese usuario" });
  }
  if (db.prepare("SELECT id FROM usuarios WHERE lower(email) = ?").get(u.email)) {
    return res.status(409).json({ error: "El correo ya está en uso por otra cuenta" });
  }

  const iniciales = `${(u.nombre[0] ?? "?")}${(u.apellido[0] ?? "")}`.toUpperCase();
  const hashed = await bcrypt.hash(u.password, 10);
  db.prepare(`
    INSERT INTO usuarios (id,nombre,apellido,iniciales,email,password,rol,area,especialidad,nivel_acceso,activo)
    VALUES (@id,@nombre,@apellido,@iniciales,@email,@password,@rol,@area,@especialidad,@nivel_acceso,0)
  `).run({
    id: u.id,
    nombre: sanitizarTexto(u.nombre, 100),
    apellido: sanitizarTexto(u.apellido, 100),
    iniciales,
    email: u.email,
    password: hashed,
    rol: "otro_area",
    area: sanitizarTexto(u.area, 100),
    especialidad: sanitizarTexto(u.especialidad, 200),
    nivel_acceso: null
  });

  const admins = db.prepare("SELECT id FROM usuarios WHERE rol = 'admin' AND activo = 1").all();
  for (const a of admins) {
    crearNotificacion({
      toggle: "alertaNuevosUsuarios",
      tipo: "usuario_registrado",
      titulo: "Nuevo profesor registrado",
      mensaje: `{quien} se registró en el sistema (${u.id}) y espera aprobación. Abre la notificación para activar la cuenta y otorgarle el nivel de acceso.`,
      actorId: u.id,
      usuarioRef: u.id,
      destinatario: a.id
    });
  }

  registrarAuditoria(req, "usuario_registrado", { usuario: u.id, email: u.email });
  res.status(201).json({
    mensaje: "Tu cuenta quedó creada y pendiente de aprobación. Un administrador debe activarla antes de que puedas ingresar.",
    usuario: usrFromRow(db.prepare("SELECT * FROM usuarios WHERE id = ?").get(u.id))
  });
});

app.get("/api/laboratorios", authenticateToken, (req, res) => {
  const rows = db.prepare("SELECT * FROM laboratorios ORDER BY id").all();
  responderLista(req, res, rows.map((r) => labFromRowVisible(r, req)));
});

app.get("/api/laboratorios/:id", authenticateToken, (req, res) => {
  const row = db.prepare("SELECT * FROM laboratorios WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Laboratorio no encontrado" });
  res.json(labFromRowVisible(row, req));
});

app.patch("/api/laboratorios/:id", authenticateToken, (req, res) => {
  const campos = Object.keys(req.body || {});
  if (!campos.includes("estado")) {
    return res.status(400).json({ error: "Estado inválido" });
  }
  if (campos.some((k) => k !== "estado") && !esTecnico(req)) {
    return res.status(403).json({ error: "Se requieren permisos técnicos para modificar otros campos" });
  }
  const ignorados = campos.filter((k) => k !== "estado");
  if (ignorados.length) {
    return res.status(400).json({ error: `Desde aquí solo se puede cambiar el estado del laboratorio. Campo no editable: ${ignorados.join(", ")}` });
  }
  const { estado } = req.body;
  if (!["disponible", "ocupado", "mantencion"].includes(estado)) {
    return res.status(400).json({ error: "Estado inválido" });
  }
  const anterior = db.prepare("SELECT * FROM laboratorios WHERE id = ?").get(req.params.id);
  if (!anterior) return res.status(404).json({ error: "Laboratorio no encontrado" });

  db.prepare("UPDATE laboratorios SET estado = ? WHERE id = ?").run(estado, req.params.id);
  const lab = labFromRowVisible(db.prepare("SELECT * FROM laboratorios WHERE id = ?").get(req.params.id), req);

  notificarCambioEstadoLab(lab, estado, anterior.estado, req.user.id);
  registrarAuditoria(req, "laboratorio_estado_cambiado", { lab: req.params.id, anterior: anterior.estado, estado });

  res.json(lab);
});

app.get("/api/equipos", authenticateToken, (req, res) => {
  const { labId } = req.query;
  const rows = labId
    ? db.prepare("SELECT * FROM equipos WHERE lab_id = ? ORDER BY id").all(labId)
    : db.prepare("SELECT * FROM equipos ORDER BY id").all();
  responderLista(req, res, rows.map((r) => eqFromRowVisible(r, req)));
});

app.get("/api/usuarios", authenticateToken, (req, res) => {
  const rows = db.prepare("SELECT * FROM usuarios ORDER BY nombre").all();
  const visibles = rows.map((r) => (puedeVerEmail(req, r) ? usrFromRow(r) : usrPublico(r)));
  responderLista(req, res, visibles);
});

app.get("/api/usuarios/:id", authenticateToken, (req, res) => {
  const row = db.prepare("SELECT * FROM usuarios WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Usuario no encontrado" });
  res.json(puedeVerEmail(req, row) ? usrFromRow(row) : usrPublico(row));
});

app.post("/api/usuarios", authenticateToken, requireAdmin, [
  body("id").trim().matches(/^[a-zA-Z0-9_]{1,32}$/).withMessage("El ID debe tener entre 1 y 32 caracteres: letras, números y guion bajo"),
  body("nombre").trim().notEmpty().withMessage("El nombre es obligatorio"),
  body("apellido").trim().notEmpty().withMessage("El apellido es obligatorio"),
  body("email").isEmail().withMessage("El email debe ser válido"),
  reglaPassword("password"),
  body("rol").optional().isIn(["admin", "programacion", "otro_area"]).withMessage("Rol inválido"),
  body("nivelAcceso").optional().isIn(["total", "tecnico", "basico"]).withMessage("Nivel de acceso inválido")
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: "Datos inválidos", details: errors.array() });
  }

  const u = req.body;
  const existe = db.prepare("SELECT id FROM usuarios WHERE id = ?").get(u.id);
  if (existe) return res.status(409).json({ error: "Ya existe un usuario con ese ID" });

  const email = String(u.email || "").trim().toLowerCase();
  const emailUso = db.prepare("SELECT id FROM usuarios WHERE lower(email) = ?").get(email);
  if (emailUso) return res.status(409).json({ error: "El email ya está en uso por otro usuario" });

  const nombre = sanitizarTexto(u.nombre, 100);
  const apellido = sanitizarTexto(u.apellido, 100);
  const iniciales = `${nombre.trim()[0] ?? ""}${apellido.trim()[0] ?? ""}`.toUpperCase();

  const hashed = await bcrypt.hash(u.password, 10);
  db.prepare(`
    INSERT INTO usuarios (id,nombre,apellido,iniciales,email,password,rol,area,especialidad,nivel_acceso,activo)
    VALUES (@id,@nombre,@apellido,@iniciales,@email,@password,@rol,@area,@especialidad,@nivel_acceso,1)
  `).run({
    id: u.id, nombre, apellido,
    iniciales: iniciales || "??",
    email, password: hashed, rol: u.rol || "otro_area",
    area: sanitizarTexto(u.area, 100), especialidad: sanitizarTexto(u.especialidad, 200),
    nivel_acceso: u.nivelAcceso || "basico"
  });

  const row = db.prepare("SELECT * FROM usuarios WHERE id = ?").get(u.id);
  registrarAuditoria(req, "usuario_creado", { usuario: u.id, rol: u.rol || "otro_area" });
  res.status(201).json(usrFromRow(row));
});

app.patch("/api/usuarios/:id", authenticateToken, [
  body("nombre").optional().trim().notEmpty(),
  body("apellido").optional().trim().notEmpty(),
  body("email").optional().isEmail().withMessage("El email debe ser válido"),
  body("password").optional().isLength({ min: MIN_PASSWORD }).withMessage(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`).bail()
    .custom((pw) => { const e = errorPassword(pw); if (e) throw new Error(e); return true; }),
  body("rol").optional().isIn(["admin", "programacion", "otro_area"]).withMessage("Rol inválido"),
  body("nivelAcceso").optional().isIn(["total", "tecnico", "basico"]).withMessage("Nivel de acceso inválido")
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: "Datos inválidos", details: errors.array() });
  }

  const esSelf = String(req.params.id) === String(req.user.id);
  const esAdmin = req.user?.rol === "admin";
  if (!esSelf && !esAdmin) {
    return res.status(403).json({ error: "Solo puedes editar tu propio perfil o ser administrador" });
  }
  const camposAdmin = ["rol", "nivelAcceso", "activo", "password"];
  if (!esAdmin && camposAdmin.some((c) => req.body[c] !== undefined)) {
    return res.status(403).json({ error: "Solo el administrador puede modificar rol, nivel de acceso, usuario activo o contraseña" });
  }
  if (!esAdmin && req.body.area !== undefined) {
    return res.status(403).json({ error: "El área/departamento no se puede modificar desde el perfil; solo el administrador puede cambiarla" });
  }
  if (!esAdmin && req.body.especialidad !== undefined) {
    return res.status(403).json({ error: "La especialidad solo se puede cambiar mediante una solicitud que debe aprobar el administrador" });
  }

  const actual = db.prepare("SELECT * FROM usuarios WHERE id = ?").get(req.params.id);
  if (!actual) return res.status(404).json({ error: "Usuario no encontrado" });

  if (req.body.email !== undefined) {
    const email = String(req.body.email).trim().toLowerCase();
    if (email !== String(actual.email ?? "").toLowerCase()) {
      const emailUso = db.prepare("SELECT id FROM usuarios WHERE lower(email) = ? AND id != ?").get(email, req.params.id);
      if (emailUso) return res.status(409).json({ error: "El email ya está en uso por otro usuario" });
    }
  }

  const map = {
    nombre: "nombre", apellido: "apellido", email: "email", password: "password",
    area: "area", especialidad: "especialidad", rol: "rol",
    nivelAcceso: "nivel_acceso", activo: "activo"
  };
  const sets = [];
  const valores = {};
  for (const [key, col] of Object.entries(map)) {
    if (req.body[key] !== undefined) {
      if (key === "password") {
        valores[col] = await bcrypt.hash(req.body[key], 10);
      } else if (key === "email") {
        valores[col] = String(req.body[key]).trim().toLowerCase();
      } else if (key === "activo") {
        valores[col] = req.body[key] ? 1 : 0;
      } else if (key === "nombre" || key === "apellido" || key === "area") {
        valores[col] = sanitizarTexto(req.body[key], 100);
      } else if (key === "especialidad") {
        valores[col] = sanitizarTexto(req.body[key], 200);
      } else {
        valores[col] = req.body[key];
      }
      sets.push(`${col} = @${col}`);
    }
  }
  if (!sets.length) return res.json(usrFromRow(actual));

  valores.id = req.params.id;
  db.prepare(`UPDATE usuarios SET ${sets.join(", ")} WHERE id = @id`).run(valores);
  registrarAuditoria(req, "usuario_editado", {
    usuario: req.params.id,
    campos: Object.keys(map).filter((k) => req.body[k] !== undefined)
  });

  if (esSelf && (req.body.nombre !== undefined || req.body.apellido !== undefined)) {
    const fresca = db.prepare("SELECT * FROM usuarios WHERE id = ?").get(req.user.id);
    const token = firmarAcceso(fresca);
    res.cookie(COOKIE_ACCESO, token, opcionesCookie(req));
    const cuerpo = { ...usrFromRow(fresca) };
    if (incluirTokensEnCuerpo(req)) cuerpo.token = token;
    return res.json(cuerpo);
  }

  res.json(usrFromRow(db.prepare("SELECT * FROM usuarios WHERE id = ?").get(req.params.id)));
});

app.delete("/api/usuarios/:id", authenticateToken, requireAdmin, (req, res) => {
  const actual = db.prepare("SELECT * FROM usuarios WHERE id = ?").get(req.params.id);
  if (!actual) return res.status(404).json({ error: "Usuario no encontrado" });
  if (String(actual.id) === String(req.user.id)) {
    return res.status(400).json({ error: "No puedes eliminar tu propio usuario" });
  }
  if (actual.rol === "admin") {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'admin'").get();
    if (n <= 1) return res.status(400).json({ error: "No puedes eliminar al único administrador" });
  }

  enTransaccion(() => {
    db.prepare("UPDATE reportes SET generado_por = NULL WHERE generado_por = ?").run(req.params.id);
    db.prepare("UPDATE solicitudes_especialidad SET resuelta_por = NULL WHERE resuelta_por = ?").run(req.params.id);
    db.prepare("DELETE FROM usuarios WHERE id = ?").run(req.params.id);
  });

  registrarAuditoria(req, "usuario_eliminado", { usuario: actual.id, rol: actual.rol });
  res.status(204).end();
});

app.get("/api/agenda", authenticateToken, (req, res) => {
  const rows = db.prepare("SELECT * FROM agenda ORDER BY fecha, hora_inicio").all();
  responderLista(req, res, rows.map(agFromRow));
});

app.post("/api/agenda", authenticateToken, [
  body("labId").trim().notEmpty().withMessage("El laboratorio es obligatorio"),
  body("fecha").custom(esFechaISOValida).withMessage("La fecha debe ser una fecha real en formato AAAA-MM-DD"),
  body("motivo").trim().notEmpty().withMessage("El motivo es obligatorio"),
  body("horaInicio").optional({ values: "falsy" }).matches(/^([01]\d|2[0-3]):[0-5]\d$/).withMessage("La hora de inicio debe tener formato HH:MM"),
  body("horaFin").optional({ values: "falsy" }).matches(/^([01]\d|2[0-3]):[0-5]\d$/).withMessage("La hora de fin debe tener formato HH:MM")
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: "Datos inválidos", details: errors.array() });
  }

  const r = req.body;

  const lab = db.prepare("SELECT id FROM laboratorios WHERE id = ?").get(r.labId);
  if (!lab) return res.status(400).json({ error: "El laboratorio no existe" });

  const hoy = new Date();
  const hoyISO = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")}`;
  if (r.fecha < hoyISO) {
    return res.status(400).json({ error: "No se pueden agendar reservas en fechas pasadas" });
  }

  const cfg = JSON.parse(db.prepare("SELECT data FROM config WHERE id = 1").get()?.data || "{}");
  const anticipMax = Number(cfg.laboratorios?.anticipacionMaxReserva) || 7;
  const fechaReserva = new Date(r.fecha + "T00:00:00Z");
  const fechaHoy = new Date(hoyISO + "T00:00:00Z");
  const dias = Math.round((fechaReserva.getTime() - fechaHoy.getTime()) / 86400000);
  if (dias > anticipMax) {
    return res.status(400).json({ error: `Solo se permite reservar con hasta ${anticipMax} día(s) de anticipación` });
  }

  const hIni = r.horaInicio || "00:00";
  const hFin = r.horaFin || "23:59";
  if (r.horaInicio && r.horaFin && r.horaFin <= r.horaInicio) {
    return res.status(400).json({ error: "La hora de fin debe ser posterior a la de inicio" });
  }

  const previas = db.prepare(`
    SELECT * FROM agenda WHERE lab_id = ? AND fecha = ? AND estado != 'cancelada'
  `).all(r.labId, r.fecha);
  for (const p of previas) {
    const pIni = p.hora_inicio || "00:00";
    const pFin = p.hora_fin || "23:59";
    if (hIni < pFin && pIni < hFin) {
      return res.status(409).json({ error: "El laboratorio ya está reservado en ese horario" });
    }
  }

  const id = nuevoId("res", r.id, "agenda");
  db.prepare(`
    INSERT INTO agenda (id, lab_id, usuario_id, fecha, hora_inicio, hora_fin, motivo, estado)
    VALUES (?,?,?,?,?,?,?,'pendiente')
  `).run(id, r.labId, req.user.id, r.fecha, r.horaInicio ?? null, r.horaFin ?? null, sanitizarTexto(r.motivo, 500));

  const reserva = agFromRow(db.prepare("SELECT * FROM agenda WHERE id = ?").get(id));
  notificarNuevaReserva(reserva, req.user.id);
  registrarAuditoria(req, "reserva_creada", { reserva: id, lab: r.labId, fecha: r.fecha });

  res.status(201).json(reserva);
});

app.delete("/api/agenda/:id", authenticateToken, (req, res) => {
  const actual = db.prepare("SELECT * FROM agenda WHERE id = ?").get(req.params.id);
  if (!actual) return res.status(404).json({ error: "Reserva no encontrada" });

  if (actual.usuario_id !== req.user.id && req.user.rol !== "admin") {
    return res.status(403).json({ error: "No tienes permiso para cancelar esta reserva" });
  }

  db.prepare("DELETE FROM agenda WHERE id = ?").run(req.params.id);
  notificarReservaCancelada(agFromRow(actual), req.user.id);
  registrarAuditoria(req, "reserva_cancelada", { reserva: req.params.id, lab: actual.lab_id, fecha: actual.fecha });
  res.status(204).end();
});

const TIPOS_REPORTE_CALCULADOS = new Set(["uso", "disponibilidad", "fallas", "inventario"]);

function rangoMes(fechaIso) {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(fechaIso || ""));
  const hoy = new Date();
  const anio = m ? Number(m[1]) : hoy.getFullYear();
  const mes = m ? Number(m[2]) : hoy.getMonth() + 1;
  if (!Number.isInteger(anio) || !Number.isInteger(mes) || mes < 1 || mes > 12) {
    const inicio = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-01`;
    const siguiente = new Date(Date.UTC(hoy.getFullYear(), hoy.getMonth() + 1, 1));
    return { inicio, fin: siguiente.toISOString().slice(0, 10) };
  }
  const inicio = `${anio}-${String(mes).padStart(2, "0")}-01`;
  const siguiente = new Date(Date.UTC(anio, mes, 1));
  return { inicio, fin: siguiente.toISOString().slice(0, 10) };
}

function horasEntre(horaInicio, horaFin) {
  const a = /^(\d{1,2}):(\d{2})$/.exec(String(horaInicio || ""));
  const b = /^(\d{1,2}):(\d{2})$/.exec(String(horaFin || ""));
  if (!a || !b) return 0;
  const minutos = (Number(b[1]) * 60 + Number(b[2])) - (Number(a[1]) * 60 + Number(a[2]));
  return minutos > 0 ? minutos / 60 : 0;
}

function calcularDatosReporte(tipo, fecha) {
  if (tipo === "uso") {
    const { inicio, fin } = rangoMes(fecha);
    const filas = db.prepare(`
      SELECT l.nombre AS lab, a.hora_inicio, a.hora_fin
      FROM laboratorios l
      LEFT JOIN agenda a ON a.lab_id = l.id AND a.fecha >= ? AND a.fecha < ?
      ORDER BY l.id
    `).all(inicio, fin);

    const horas = new Map();
    for (const fila of filas) {
      if (!horas.has(fila.lab)) horas.set(fila.lab, 0);
      if (fila.hora_inicio === null) continue;
      horas.set(fila.lab, horas.get(fila.lab) + horasEntre(fila.hora_inicio, fila.hora_fin));
    }
    const labels = [...horas.keys()];
    return {
      labels,
      valores: labels.map((lab) => Math.round(horas.get(lab) * 10) / 10)
    };
  }

  if (tipo === "disponibilidad") {
    const filas = db.prepare(`
      SELECT l.nombre AS lab, l.estado,
             COUNT(e.id) AS total,
             COALESCE(SUM(CASE WHEN e.estado = 'activo' THEN 1 ELSE 0 END), 0) AS activos
      FROM laboratorios l
      LEFT JOIN equipos e ON e.lab_id = l.id
      GROUP BY l.id
      ORDER BY l.id
    `).all();

    return {
      labels: filas.map((fila) => fila.lab),
      valores: filas.map((fila) => {
        const total = Number(fila.total || 0);
        if (total > 0) return Math.round((Number(fila.activos || 0) / total) * 100);
        return fila.estado === "disponible" ? 100 : 0;
      })
    };
  }

  if (tipo === "fallas") {
    const filas = db.prepare(`
      SELECT e.id, e.nombre AS equipo, e.estado, e.observaciones, l.nombre AS lab
      FROM equipos e
      JOIN laboratorios l ON l.id = e.lab_id
      WHERE e.estado = 'falla'
      ORDER BY l.id, e.id
    `).all();

    return {
      fallas: filas.map((fila) => ({
        equipo: fila.equipo || fila.id,
        lab: fila.lab,
        descripcion: fila.observaciones || "Falla reportada",
        estado: "pendiente"
      }))
    };
  }

  if (tipo === "inventario") {
    const fila = db.prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN estado = 'activo' THEN 1 ELSE 0 END), 0) AS activos,
             COALESCE(SUM(CASE WHEN estado = 'falla' THEN 1 ELSE 0 END), 0) AS enFalla,
             COALESCE(SUM(CASE WHEN estado = 'mantencion' THEN 1 ELSE 0 END), 0) AS enMantencion
      FROM equipos
    `).get();

    const total = Number(fila.total || 0);
    if (total > 0) {
      return {
        total,
        activos: Number(fila.activos || 0),
        enFalla: Number(fila.enFalla || 0),
        enMantencion: Number(fila.enMantencion || 0)
      };
    }

    const labs = db.prepare("SELECT equipos, estado FROM laboratorios").all();
    const totalLabs = labs.reduce((n, lab) => n + Number(lab.equipos || 0), 0);
    const enMantencion = labs
      .filter((lab) => lab.estado === "mantencion")
      .reduce((n, lab) => n + Number(lab.equipos || 0), 0);
    return {
      total: totalLabs,
      activos: Math.max(0, totalLabs - enMantencion),
      enFalla: 0,
      enMantencion
    };
  }

  return {};
}

function datosDeReporte(tipo, fecha, datosCliente) {
  return TIPOS_REPORTE_CALCULADOS.has(tipo)
    ? calcularDatosReporte(tipo, fecha)
    : datosCliente;
}

app.get("/api/reportes", authenticateToken, (req, res) => {
  const rows = esTecnico(req)
    ? db.prepare("SELECT * FROM reportes ORDER BY fecha DESC").all()
    : db.prepare("SELECT * FROM reportes WHERE generado_por = ? ORDER BY fecha DESC").all(req.user.id);
  responderLista(req, res, rows.map((r) => repFromRow(r, false)));
});

app.get("/api/reportes/:id", authenticateToken, (req, res) => {
  const row = db.prepare("SELECT * FROM reportes WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Reporte no encontrado" });
  if (!esTecnico(req) && row.generado_por !== req.user.id) {
    return res.status(403).json({ error: "No tienes acceso a este reporte" });
  }
  res.json(repFromRow(row));
});

app.post("/api/reportes", authenticateToken, [
  body("tipo").trim().isLength({ min: 1, max: 50 }).withMessage("El tipo debe tener entre 1 y 50 caracteres"),
  body("titulo").trim().notEmpty().withMessage("El título es obligatorio"),
  body("descripcion").trim().notEmpty().withMessage("La descripción es obligatoria"),
  body("fecha").optional({ values: "falsy" }).custom(esFechaISOValida).withMessage("La fecha debe ser una fecha real en formato AAAA-MM-DD")
], (req, res) => {
  if (!esTecnico(req)) {
    return res.status(403).json({ error: "Solo el administrador o los profesores de programación pueden crear reportes" });
  }
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: "Datos inválidos", details: errors.array() });
  }

  const r = req.body;
  const tipoFinal = sanitizarTexto(r.tipo, 50);
  const id = nuevoId("rep", r.id, "reportes");
  const hoy = new Date();
  const fechaPorDefecto = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")}`;
  const fechaFinal = r.fecha || fechaPorDefecto;
  db.prepare(`
    INSERT INTO reportes (id, tipo, titulo, descripcion, fecha, generado_por, datos, adjuntos)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(id, tipoFinal, sanitizarTexto(r.titulo, 300), sanitizarTexto(r.descripcion, 5000),
         fechaFinal, req.user.id,
         serializarDatos(datosDeReporte(tipoFinal, fechaFinal, r.datos)),
         JSON.stringify(sanitizarAdjuntos(r.adjuntos)));

  const rep = repFromRow(db.prepare("SELECT * FROM reportes WHERE id = ?").get(id));
  notificarCambioReporte("creado", rep, req.user.id);
  res.status(201).json(rep);
});

app.patch("/api/reportes/:id", authenticateToken, [
  body("titulo").optional().trim().notEmpty(),
  body("descripcion").optional().trim().notEmpty(),
  body("tipo").optional().trim().isLength({ min: 1, max: 50 }),
  body("fecha").optional().custom(esFechaISOValida).withMessage("La fecha debe ser una fecha real en formato AAAA-MM-DD")
], (req, res) => {
  const actual = db.prepare("SELECT * FROM reportes WHERE id = ?").get(req.params.id);
  if (!actual) return res.status(404).json({ error: "Reporte no encontrado" });
  if (!puedeModificarReporte(actual, req)) {
    return res.status(403).json({ error: "Solo el administrador o el creador pueden editar este reporte" });
  }

  const errores = validationResult(req);
  if (!errores.isEmpty()) {
    return res.status(400).json({ error: errores.array()[0].msg });
  }

  const r = req.body;
  if ((r.titulo !== undefined && !String(r.titulo).trim()) ||
      (r.descripcion !== undefined && !String(r.descripcion).trim())) {
    return res.status(400).json({ error: "El título y la descripción son obligatorios" });
  }

  const tipoFinal = r.tipo !== undefined ? sanitizarTexto(r.tipo, 50) : actual.tipo;
  const fechaFinal = r.fecha ?? actual.fecha;
  const datosFinales = TIPOS_REPORTE_CALCULADOS.has(tipoFinal)
    ? calcularDatosReporte(tipoFinal, fechaFinal)
    : (r.datos !== undefined ? r.datos : parsearJSON(actual.datos, {}));

  db.prepare(`
    UPDATE reportes SET
      tipo        = ?,
      titulo      = ?,
      descripcion = ?,
      fecha       = ?,
      datos       = ?,
      adjuntos    = ?
    WHERE id = ?
  `).run(
    tipoFinal,
    r.titulo !== undefined ? sanitizarTexto(r.titulo, 300) : actual.titulo,
    r.descripcion !== undefined ? sanitizarTexto(r.descripcion, 5000) : actual.descripcion,
    fechaFinal,
    serializarDatos(datosFinales),
    JSON.stringify(r.adjuntos !== undefined ? sanitizarAdjuntos(r.adjuntos) : parsearJSON(actual.adjuntos, [])),
    req.params.id
  );

  const rep = repFromRow(db.prepare("SELECT * FROM reportes WHERE id = ?").get(req.params.id));
  notificarCambioReporte("editado", rep, req.user.id);
  res.json(rep);
});

app.delete("/api/reportes/:id", authenticateToken, (req, res) => {
  const actual = db.prepare("SELECT * FROM reportes WHERE id = ?").get(req.params.id);
  if (!actual) return res.status(404).json({ error: "Reporte no encontrado" });
  if (!puedeModificarReporte(actual, req)) {
    return res.status(403).json({ error: "Solo el administrador o el creador pueden eliminar este reporte" });
  }

  db.prepare("DELETE FROM reportes WHERE id = ?").run(req.params.id);
  notificarCambioReporte("eliminado", repFromRow(actual), req.user.id);
  res.status(204).end();
});

app.get("/api/notificaciones", authenticateToken, (req, res) => {
  const usuarioId = req.user.id;
  const rows = db.prepare("SELECT * FROM notificaciones WHERE usuario_id = ? ORDER BY id DESC LIMIT 50").all(usuarioId);
  responderLista(req, res, rows.map(notifFromRow));
});

app.patch("/api/notificaciones/:id", authenticateToken, (req, res) => {
  const row = db.prepare("SELECT * FROM notificaciones WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Notificación no encontrada" });
  if (row.usuario_id !== req.user.id) {
    return res.status(403).json({ error: "No tienes permiso para modificar esta notificación" });
  }
  db.prepare("UPDATE notificaciones SET leida = ? WHERE id = ?").run(req.body?.leida ? 1 : 0, req.params.id);
  res.json(notifFromRow(db.prepare("SELECT * FROM notificaciones WHERE id = ?").get(req.params.id)));
});

app.post("/api/notificaciones/leer-todas", authenticateToken, (req, res) => {
  db.prepare("UPDATE notificaciones SET leida = 1 WHERE usuario_id = ?").run(req.user.id);
  res.json({ ok: true });
});

app.delete("/api/notificaciones/:id", authenticateToken, (req, res) => {
  const row = db.prepare("SELECT * FROM notificaciones WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Notificación no encontrada" });
  if (row.usuario_id !== req.user.id && req.user.rol !== "admin") {
    return res.status(403).json({ error: "No tienes permiso" });
  }
  db.prepare("DELETE FROM notificaciones WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

app.get("/api/solicitudes-especialidad", authenticateToken, (req, res) => {
  const rows = req.user.rol === "admin"
    ? db.prepare("SELECT * FROM solicitudes_especialidad ORDER BY id DESC").all()
    : db.prepare("SELECT * FROM solicitudes_especialidad WHERE usuario_id = ? ORDER BY id DESC").all(req.user.id);
  responderLista(req, res, rows.map(solicitudFromRow));
});

app.get("/api/solicitudes-especialidad/:id", authenticateToken, (req, res) => {
  const row = db.prepare("SELECT * FROM solicitudes_especialidad WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Solicitud no encontrada" });
  if (req.user.rol !== "admin" && row.usuario_id !== req.user.id) {
    return res.status(403).json({ error: "No tienes permiso para ver esta solicitud" });
  }
  const usr = db.prepare("SELECT id, nombre, apellido, email, area, especialidad, rol FROM usuarios WHERE id = ?").get(row.usuario_id);
  res.json({ ...solicitudFromRow(row), solicitante: usr ?? null });
});

app.post("/api/solicitudes-especialidad", authenticateToken, [
  body("especialidad").trim().notEmpty().withMessage("La especialidad solicitada es obligatoria"),
  body("especialidad").isLength({ max: 200 }).withMessage("La especialidad no puede superar 200 caracteres")
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: "Datos inválidos", details: errors.array() });
  }
  if (req.user.rol === "admin") {
    return res.status(403).json({ error: "Los administradores editan su especialidad directamente desde el perfil" });
  }

  const pendiente = db.prepare(
    "SELECT id FROM solicitudes_especialidad WHERE usuario_id = ? AND estado = 'pendiente'"
  ).get(req.user.id);
  if (pendiente) {
    return res.status(409).json({ error: "Ya tienes una solicitud de especialidad pendiente de aprobación" });
  }

  const actual = db.prepare("SELECT nombre, apellido, especialidad FROM usuarios WHERE id = ?").get(req.user.id);
  const solicitada = sanitizarTexto(req.body.especialidad, 200);
  if (actual && solicitada === actual.especialidad) {
    return res.status(400).json({ error: "La especialidad solicitada es la misma que ya tienes asignada" });
  }

  const info = db.prepare(`
    INSERT INTO solicitudes_especialidad (usuario_id, especialidad_actual, especialidad_solicitada, estado, creada_en)
    VALUES (?,?,?,?,?)
  `).run(req.user.id, actual?.especialidad ?? null, solicitada, "pendiente", new Date().toISOString());
  const solicitudId = Number(info.lastInsertRowid);

  const admins = db.prepare("SELECT id FROM usuarios WHERE rol = 'admin' AND activo = 1").all();
  for (const a of admins) {
    crearNotificacion({
      toggle: "alertaSolicitudes",
      tipo: "solicitud_especialidad",
      titulo: "Solicitud de cambio de especialidad",
      mensaje: `{quien} solicita cambiar su especialidad de "${actual?.especialidad ?? "—"}" a "${solicitada}". Abre la notificación para revisarla en detalle y aprobarla o rechazarla.`,
      actorId: req.user.id,
      destinatario: a.id,
      solicitudId
    });
  }

  res.status(201).json(solicitudFromRow(db.prepare("SELECT * FROM solicitudes_especialidad WHERE id = ?").get(solicitudId)));
});

app.post("/api/solicitudes-especialidad/:id/aceptar", authenticateToken, requireAdmin, (req, res) => {
  const solicitud = db.prepare("SELECT * FROM solicitudes_especialidad WHERE id = ?").get(req.params.id);
  if (!solicitud) return res.status(404).json({ error: "Solicitud no encontrada" });
  if (solicitud.estado !== "pendiente") {
    return res.status(409).json({ error: "La solicitud ya fue resuelta" });
  }
  db.prepare(`
    UPDATE solicitudes_especialidad SET estado = 'aceptada', resuelta_por = ?, resuelta_en = ? WHERE id = ?
  `).run(req.user.id, new Date().toISOString(), solicitud.id);
  db.prepare("UPDATE usuarios SET especialidad = ? WHERE id = ?")
    .run(solicitud.especialidad_solicitada, solicitud.usuario_id);
  crearNotificacion({
    toggle: "alertaSolicitudes",
    tipo: "solicitud_especialidad_resolucion",
    titulo: "Especialidad actualizada",
    mensaje: `El administrador aprobó tu solicitud de cambio de especialidad: ahora tu especialidad es "${solicitud.especialidad_solicitada}".`,
    destinatario: solicitud.usuario_id
  });
  registrarAuditoria(req, "solicitud_aceptada", { solicitud: solicitud.id, usuario: solicitud.usuario_id });
  res.json(solicitudFromRow(db.prepare("SELECT * FROM solicitudes_especialidad WHERE id = ?").get(solicitud.id)));
});

app.post("/api/solicitudes-especialidad/:id/rechazar", authenticateToken, requireAdmin, (req, res) => {
  const solicitud = db.prepare("SELECT * FROM solicitudes_especialidad WHERE id = ?").get(req.params.id);
  if (!solicitud) return res.status(404).json({ error: "Solicitud no encontrada" });
  if (solicitud.estado !== "pendiente") {
    return res.status(409).json({ error: "La solicitud ya fue resuelta" });
  }
  db.prepare(`
    UPDATE solicitudes_especialidad SET estado = 'rechazada', resuelta_por = ?, resuelta_en = ? WHERE id = ?
  `).run(req.user.id, new Date().toISOString(), solicitud.id);
  crearNotificacion({
    toggle: "alertaSolicitudes",
    tipo: "solicitud_especialidad_resolucion",
    titulo: "Solicitud de especialidad rechazada",
    mensaje: `El administrador rechazó tu solicitud para cambiar la especialidad a "${solicitud.especialidad_solicitada}". Tu especialidad no cambió.`,
    destinatario: solicitud.usuario_id
  });
  registrarAuditoria(req, "solicitud_rechazada", { solicitud: solicitud.id, usuario: solicitud.usuario_id });
  res.json(solicitudFromRow(db.prepare("SELECT * FROM solicitudes_especialidad WHERE id = ?").get(solicitud.id)));
});

app.get("/api/config", authenticateToken, (req, res) => {
  const row = db.prepare("SELECT data FROM config WHERE id = 1").get();
  if (!row) return res.status(404).json({ error: "Configuración no encontrada" });
  res.json(configParaUsuario(JSON.parse(row.data), req.user?.rol));
});

const CONFIG_ESQUEMA = {
  sitio: {
    nombreInstitucion: (v) => typeof v === "string" && v.trim().length >= 1 && v.length <= 120,
    nombreSistema: (v) => typeof v === "string" && v.trim().length >= 1 && v.length <= 60,
    logo: (v) => typeof v === "string" && v.length <= 2000,
    tema: (v) => typeof v === "string" && v.length <= 40,
    idioma: (v) => v === "es" || v === "en"
  },
  red: {
    subredLabs: (v) => typeof v === "string" && v.length <= 100,
    servidorDNS: (v) => typeof v === "string" && v.length <= 100,
    puertaEnlace: (v) => typeof v === "string" && v.length <= 100,
    wifiHabilitado: (v) => typeof v === "boolean"
  },
  notificaciones: {
    emailAdmin: (v) => typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254,
    alertaFallas: (v) => typeof v === "boolean",
    alertaDisponibilidad: (v) => typeof v === "boolean",
    alertaReservas: (v) => typeof v === "boolean",
    alertaReportes: (v) => typeof v === "boolean",
    alertaSolicitudes: (v) => typeof v === "boolean",
    alertaNuevosUsuarios: (v) => typeof v === "boolean",
    recordatorioReserva: (v) => typeof v === "boolean"
  },
  seguridad: {
    sesionTimeout: (v) => Number.isInteger(v) && v >= 5 && v <= 120,
    intentosLoginMax: (v) => Number.isInteger(v) && v >= 3 && v <= 10,
    registroActividad: (v) => typeof v === "boolean"
  },
  laboratorios: {
    horaApertura: (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
    horaCierre: (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
    permitirReservaExterna: (v) => typeof v === "boolean",
    anticipacionMaxReserva: (v) => Number.isInteger(v) && v >= 1 && v <= 30
  },
  equipos: {
    habilitarControlRemoto: (v) => typeof v === "boolean",
    apagadoAutomatico: (v) => typeof v === "boolean",
    monitoreoTiempoReal: (v) => typeof v === "boolean",
    intervaloEncendido: (v) => Number.isInteger(v) && v >= 5 && v <= 300
  }
};

function validarCambiosConfig(cuerpo) {
  const errores = [];
  for (const [seccion, valor] of Object.entries(cuerpo)) {
    if (CLAVES_NO_DATOS.has(seccion)) continue;
    const esquema = CONFIG_ESQUEMA[seccion];
    if (!esquema || valor === null || typeof valor !== "object" || Array.isArray(valor)) {
      errores.push(`Sección inválida: ${seccion}`);
      continue;
    }
    for (const [clave, v] of Object.entries(valor)) {
      if (CLAVES_NO_DATOS.has(clave)) continue;
      if (!esquema[clave] || !esquema[clave](v)) errores.push(`${seccion}.${clave} no es válido`);
    }
  }
  return errores;
}

app.patch("/api/config", authenticateToken, requireAdmin, (req, res) => {
  const row = db.prepare("SELECT data FROM config WHERE id = 1").get();
  if (!row) return res.status(404).json({ error: "Configuración no encontrada" });
  const actual = JSON.parse(row.data);
  const nuevo = { ...actual };

  if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) {
    return res.status(400).json({ error: "El cuerpo de la solicitud debe ser un objeto JSON" });
  }
  const errores = validarCambiosConfig(req.body);
  if (errores.length) {
    return res.status(400).json({ error: "Configuración inválida", details: errores });
  }

  for (const [seccion, valor] of Object.entries(req.body)) {
    if (CLAVES_NO_DATOS.has(seccion)) continue;
    const permitidas = CONFIG_ESQUEMA[seccion];
    const limpio = {};
    for (const [clave, v] of Object.entries(valor)) {
      if (permitidas[clave] && !CLAVES_NO_DATOS.has(clave)) limpio[clave] = v;
    }
    nuevo[seccion] = { ...(actual[seccion] || {}), ...limpio };
  }

  db.prepare("UPDATE config SET data = ? WHERE id = 1").run(JSON.stringify(nuevo));
  registrarAuditoria(req, "configuracion_actualizada", { claves: Object.keys(req.body) });
  res.json(nuevo);
});

const dirSitio = path.resolve(process.env.LC_PUBLIC_DIR || path.join(__dirname, "..", "public"));
const sitioDentro = fs.existsSync(path.join(dirSitio, "index.html"));

const PAGINAS_HTML = new Set([
  "index", "login", "laboratorios", "disponibilidad",
  "equipos", "reportes", "usuarios", "configuracion"
]);
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const coincidencia = /^\/([\w-]+)\.html$/.exec(req.path);
  if (!coincidencia || !PAGINAS_HTML.has(coincidencia[1])) return next();
  const pagina = coincidencia[1];
  const limpia = pagina === "index" ? "/" : `/${pagina}`;
  const query = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  return res.redirect(308, `${limpia}${query}`);
});

app.use(express.static(dirSitio, {
  dotfiles: "deny",
  index: ["index.html"],
  extensions: ["html"]
}));

app.use((err, req, res, _next) => {
  if (err?.status) return res.status(err.status).json({ error: err.message });
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "JSON inválido en el cuerpo de la petición" });
  console.error(err);
  res.status(500).json({ error: "Error interno del servidor" });
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (PRODUCCION && !(process.env.LC_PUBLIC_URL || "").trim()) {
    console.error("LC_PUBLIC_URL es obligatoria en producción: los enlaces de recuperación y las cookies Secure dependen de ella.");
    process.exit(1);
  }
  const servidor = app.listen(PORT, () => {
    console.log(`\n  LabControl v4.9`);
    if (sitioDentro) {
      console.log(`  API + sitio corriendo en: http://localhost:${PORT}/login`);
    } else {
      console.log(`  API corriendo en: http://localhost:${PORT}/api`);
      console.log(`  El sitio no está en ${dirSitio}: esta instancia solo responde la API.`);
      console.log(`  Sube la carpeta public/ o indica la ruta con LC_PUBLIC_DIR.`);
    }
    console.log(`  Seguridad: JWT + bcrypt + rate limiting + helmet\n`);
  });

  servidor.headersTimeout = 65_000;
  servidor.requestTimeout = 120_000;
  servidor.keepAliveTimeout = 61_000;
}

export { app };