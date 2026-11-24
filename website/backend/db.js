import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import bcrypt from "bcryptjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_DIR = process.env.LC_DB_DIR
  ? path.resolve(process.env.LC_DB_DIR)
  : path.join(__dirname, "database");
const DB_PATH = path.join(DB_DIR, "labcontrol.db");
const esNueva = !fs.existsSync(DB_PATH);

fs.mkdirSync(DB_DIR, { recursive: true });

let db = null;
let reemplazando = false;
const ganchosAlRestaurar = new Set();

export function baseDisponible() {
  return db !== null && !reemplazando;
}

export function alRestaurar(fn) {
  ganchosAlRestaurar.add(fn);
}

const PREFIJO_TEMPORAL = ".labcontrol-temporal-";
const rutaTemporal = (sufijo) => path.join(DB_DIR, `${PREFIJO_TEMPORAL}${sufijo}`);

function verificarIntegridadTotal(d, mensaje = "La base de datos no pasó la verificación de integridad") {
  const fila = d.prepare("PRAGMA integrity_check").get();
  const resultado = fila ? Object.values(fila)[0] : null;
  if (resultado !== "ok") {
    const err = new Error(mensaje);
    err.status = 500;
    throw err;
  }
}

function limpiarTemporales() {
  try {
    for (const nombre of fs.readdirSync(DB_DIR)) {
      if (nombre.startsWith(PREFIJO_TEMPORAL)) {
        try { fs.rmSync(path.join(DB_DIR, nombre), { force: true }); } catch {}
      }
    }
  } catch {}
}

async function abrirConexion(ruta = DB_PATH) {
  const d = new DatabaseSync(ruta);
  d.exec("PRAGMA journal_mode = DELETE");
  d.exec("PRAGMA foreign_keys = ON");
  d.exec("PRAGMA busy_timeout = 15000");
  const hayTablas = Boolean(d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usuarios'").get());
  if (ruta === DB_PATH && hayTablas && estadoMigraciones(d).faltantes.length) {
    try { fs.copyFileSync(ruta, `${ruta}.bak`); } catch (err) {
      console.error("No se pudo crear la copia previa a las migraciones:", err?.message || err);
    }
  }
  crearEsquema(d);
  await aplicarMigraciones(d);
  verificarIntegridadTotal(d);
  return d;
}

function crearEsquema(sesion) {
  sesion.exec("BEGIN");
  try {
    sesion.exec(`
CREATE TABLE IF NOT EXISTS laboratorios (
  id              INTEGER PRIMARY KEY,
  nombre          TEXT NOT NULL,
  sala            TEXT NOT NULL,
  ubicacion       TEXT,
  equipos         INTEGER NOT NULL DEFAULT 0,
  estado          TEXT NOT NULL DEFAULT 'disponible',
  so              TEXT,
  procesador      TEXT,
  ram             TEXT,
  almacenamiento  TEXT,
  red             TEXT,
  responsable     TEXT,
  responsable_id  TEXT,
  horario         TEXT,
  servicios       TEXT DEFAULT '[]',
  descripcion     TEXT,
  foto            TEXT,
  imagenes        TEXT DEFAULT '[]',
  pos_x INTEGER, pos_y INTEGER, pos_w INTEGER, pos_h INTEGER
);

CREATE TABLE IF NOT EXISTS equipos (
  id                TEXT PRIMARY KEY,
  lab_id            INTEGER NOT NULL REFERENCES laboratorios(id) ON DELETE CASCADE,
  nombre            TEXT,
  tipo              TEXT,
  fabricante        TEXT,
  modelo            TEXT,
  serie             TEXT,
  procesador        TEXT,
  ram               TEXT,
  almacenamiento    TEXT,
  so                TEXT,
  ip                TEXT,
  mac               TEXT,
  monitor           TEXT,
  teclado           TEXT,
  mouse             TEXT,
  estado            TEXT DEFAULT 'activo',
  ultimo_encendido  TEXT,
  observaciones     TEXT
);

CREATE TABLE IF NOT EXISTS usuarios (
  id            TEXT PRIMARY KEY,
  nombre        TEXT NOT NULL,
  apellido      TEXT NOT NULL,
  iniciales     TEXT,
  email         TEXT UNIQUE,
  password      TEXT NOT NULL,
  rol           TEXT NOT NULL DEFAULT 'otro_area',
  area          TEXT,
  especialidad  TEXT,
  nivel_acceso  TEXT DEFAULT 'basico',
  activo        INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS agenda (
  id           TEXT PRIMARY KEY,
  lab_id       INTEGER NOT NULL REFERENCES laboratorios(id) ON DELETE CASCADE,
  usuario_id   TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  fecha        TEXT,
  hora_inicio  TEXT,
  hora_fin     TEXT,
  motivo       TEXT,
  estado       TEXT DEFAULT 'pendiente'
);

CREATE TABLE IF NOT EXISTS reportes (
  id            TEXT PRIMARY KEY,
  tipo          TEXT,
  titulo        TEXT,
  descripcion   TEXT,
  fecha         TEXT,
  generado_por  TEXT REFERENCES usuarios(id),
  datos         TEXT DEFAULT '{}',
  adjuntos      TEXT DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS notificaciones (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id   TEXT REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo         TEXT NOT NULL,
  titulo       TEXT NOT NULL,
  mensaje      TEXT,
  reporte_id   TEXT REFERENCES reportes(id) ON DELETE SET NULL,
  usuario_ref  TEXT REFERENCES usuarios(id) ON DELETE SET NULL,
  fecha        TEXT,
  leida        INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS config (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  data  TEXT NOT NULL
);

-- Registro de qué semilla de datos de ejemplo se ha aplicado (ver SEMILLA).
CREATE TABLE IF NOT EXISTS seed_history (
  version     INTEGER PRIMARY KEY,
  aplicada_en TEXT NOT NULL,
  resumen     TEXT DEFAULT ''
);
`);
    sesion.exec("COMMIT");
  } catch (err) {
    sesion.exec("ROLLBACK");
    throw err;
  }
}

const CONFIG_DEFAULT = {
  sitio: { nombreInstitucion: "Instituto Superior de Comercio", nombreSistema: "LabControl", logo: "", tema: "claro", idioma: "es" },
  red: { subredLabs: "192.168.10.0/24", servidorDNS: "192.168.1.1", puertaEnlace: "192.168.1.254", wifiHabilitado: true },
  notificaciones: { emailAdmin: "admin@liceo.cl", alertaFallas: true, alertaDisponibilidad: true, alertaReservas: true, alertaReportes: true, alertaSolicitudes: true, alertaNuevosUsuarios: true, recordatorioReserva: false },
  seguridad: { sesionTimeout: 30, intentosLoginMax: 5, registroActividad: true },
  laboratorios: { horaApertura: "07:30", horaCierre: "18:00", permitirReservaExterna: true, anticipacionMaxReserva: 7 },
  equipos: { habilitarControlRemoto: true, apagadoAutomatico: false, monitoreoTiempoReal: true, intervaloEncendido: 30 }
};

const LABORATORIOS = [
  {
    id: 1, nombre: "LAB COMP 1", sala: "Sala 2-7", ubicacion: "Segundo piso, ala derecha",
    equipos: 30, estado: "disponible", so: "Windows 11 Pro", procesador: "Intel Core i5-10400",
    ram: "8 GB DDR4", almacenamiento: "512 GB SSD", red: "Conectado a la red interna (VLAN 10)",
    responsable: "Juan Pérez", responsableId: "prof_juan", horario: "07:30 - 18:00",
    servicios: ["Pizarra", "Proyectos"],
    descripcion: "Laboratorio de Computación 1 equipado para clases de informática, programación, ofimática y navegación segura.",
    foto: "assets/lab-generico.svg", posicion: { x: 620, y: 340, w: 120, h: 80 },
    imagenes: ["img/labs/Trasera_lab1.jpg", "img/labs/Frontal_lab1.jpg"]
  },
  {
    id: 2, nombre: "LAB COMP 2", sala: "Sala 3-8", ubicacion: "Tercer piso, ala derecha",
    equipos: 27, estado: "disponible", so: "Windows 11 Pro", procesador: "Intel Core i5-10400",
    ram: "8 GB DDR4", almacenamiento: "512 GB SSD", red: "Conectado a la red interna (VLAN 10)",
    responsable: "Ana López", responsableId: "prof_ana", horario: "07:30 - 18:00",
    servicios: ["Pizarra", "Proyector"],
    descripcion: "Laboratorio de Computación 2 para asignaturas de la carrera de Programación.",
    foto: "assets/lab-generico.svg", posicion: { x: 620, y: 340, w: 100, h: 70 },
    imagenes: ["img/labs/Trasero Derecho_lab2.png", "img/labs/Frontal Derecho_lab2.png"]
  },
  {
    id: 3, nombre: "LAB CIENCIAS", sala: "Sala 3-11", ubicacion: "Tercer piso, ala derecha",
    equipos: 23, estado: "ocupado", so: "Linux Mint", procesador: "Intel Core i5-10400",
    ram: "8 GB DDR4", almacenamiento: "256 GB SSD", red: "Conectado a la red interna (VLAN 10)",
    responsable: "Diego Rojas", responsableId: "prof_diego", horario: "08:00 - 17:00",
    servicios: ["Pizarra"],
    descripcion: "Laboratorio de Ciencias orientado a programación y entornos Linux.",
    foto: "assets/lab-generico.svg", posicion: { x: 620, y: 420, w: 100, h: 70 },
    imagenes: ["img/labs/Trasera_lab3.jpg", "img/labs/Frontal_lab3.jpg"]
  },
  {
    id: 4, nombre: "LAB COMP 4", sala: "Sala 3-9", ubicacion: "Tercer piso, ala derecha",
    equipos: 28, estado: "mantencion", so: "Windows 11 Pro", procesador: "Intel Core i3-10100",
    ram: "8 GB DDR4", almacenamiento: "256 GB SSD", red: "Conectado a la red interna (VLAN 10)",
    responsable: "Camila Soto", responsableId: "prof_camila", horario: "07:30 - 18:00",
    servicios: ["Pizarra"],
    descripcion: "Laboratorio de Computación 4 de apoyo para talleres y evaluaciones prácticas.",
    foto: "assets/lab-generico.svg", posicion: { x: 730, y: 340, w: 100, h: 70 },
    imagenes: ["img/labs/Trasera_lab4.jpg", "img/labs/Frontal_lab4.jpg"]
  },
  {
    id: 5, nombre: "LAB COMP 5", sala: "Sala 3-10", ubicacion: "Tercer piso, ala derecha",
    equipos: 30, estado: "disponible", so: "Linux Mint y Windows 10", procesador: "Intel Core i7-10700",
    ram: "16 GB DDR4", almacenamiento: "1 TB SSD NVMe", red: "Rack de switches y patch panel propio",
    responsable: "Juan Pérez", responsableId: "prof_juan", horario: "07:30 - 18:00",
    servicios: ["Pizarra", "Proyector"],
    descripcion: "Laboratorio de Computación 5 con doble sistema operativo (Linux Mint y Windows 10) para clases de informática, ofimática y navegación segura.",
    foto: "assets/lab-generico.svg", posicion: { x: 840, y: 340, w: 100, h: 70 },
    imagenes: ["img/labs/Trasera_lab5.jpg", "img/labs/Frontal_lab5.jpg"]
  }
];

const DATOS_INVENTARIO = LABORATORIOS.map((l) => ({
  id: l.id, nombre: l.nombre, equipos: l.equipos, so: l.so, servicios: l.servicios
}));

const TOTAL_EQUIPOS_INVENTARIO = LABORATORIOS.reduce((n, l) => n + l.equipos, 0);

const INVENTARIO_EJEMPLO = { enFalla: 3, enMantencion: 1 };

function datosEquipo(l, i) {
  const n = String(i).padStart(2, "0");
  return {
    id: `${l.id}-PC${n}`, lab_id: l.id, nombre: `PC-${l.id}${n}`,
    tipo: "Desktop", fabricante: "HP",
    modelo: i <= 10 ? "ProDesk 400 G7" : "EliteDesk 800 G6",
    serie: `SN${l.id}${String(1000 + i)}`,
    procesador: l.procesador, ram: l.ram, almacenamiento: l.almacenamiento, so: l.so,
    ip: `192.168.${10 + l.id}.${100 + i}`,
    mac: `AA:BB:CC:${String(l.id).padStart(2, "0")}:${n}:FF`,
    monitor: '22" Full HD', teclado: "USB estándar", mouse: "USB óptico",
    estado: i === 3 && l.id === 4 ? "falla" : l.estado === "mantencion" ? "mantencion" : "activo",
    ultimo_encendido: "2026-08-20 08:15",
    observaciones: i === 3 && l.id === 4 ? "Disco duro con sectores defectuosos" : ""
  };
}

const MIGRACIONES = [
  {
    version: 2,
    nombre: "columna adjuntos en reportes",
    migrar(d) {
      const columnas = d.prepare("PRAGMA table_info(reportes)").all();
      if (!columnas.some((c) => c.name === "adjuntos")) {
        d.exec("ALTER TABLE reportes ADD COLUMN adjuntos TEXT DEFAULT '[]'");
      }
    },
    revertir(d) {
      const columnas = d.prepare("PRAGMA table_info(reportes)").all();
      if (columnas.some((c) => c.name === "adjuntos")) {
        d.exec("ALTER TABLE reportes DROP COLUMN adjuntos");
      }
    },
    nota: "Se pierden los adjuntos guardados en los reportes."
  },
  {
    version: 3,
    nombre: "hashear contraseñas en texto plano con bcrypt",
    async migrar(d) {
      const usuarios = d.prepare("SELECT id, password FROM usuarios").all();
      for (const u of usuarios) {
        if (u.password && !u.password.startsWith("$2a$") && !u.password.startsWith("$2b$")) {
          const hashed = await bcrypt.hash(u.password, 10);
          d.prepare("UPDATE usuarios SET password = ? WHERE id = ?").run(hashed, u.id);
        }
      }
    },
    reversible: false,
    nota: "No se puede deshacer: un hash bcrypt no permite recuperar el texto plano de la contraseña."
  },
  {
    version: 4,
    nombre: "completar configuracion por defecto (seccion equipos y claves nuevas)",
    migrar(d) {
      const fila = d.prepare("SELECT data FROM config WHERE id = 1").get();
      if (!fila) return;
      let actual = {};
      try { actual = JSON.parse(fila.data || "{}"); } catch (e) { actual = {}; }
      if (typeof actual !== "object" || actual === null) actual = {};
      let adicion = false;
      for (const [seccion, defs] of Object.entries(CONFIG_DEFAULT)) {
        const destino = (actual[seccion] && typeof actual[seccion] === "object") ? actual[seccion] : {};
        for (const [k, v] of Object.entries(defs)) {
          if (!(k in destino)) { destino[k] = v; adicion = true; }
        }
        actual[seccion] = destino;
      }
      if (adicion) {
        d.prepare("UPDATE config SET data = ? WHERE id = 1").run(JSON.stringify(actual));
      }
    },
    reversible: false,
    nota: "No se puede deshacer: las claves que añadió se mezclan con las que el administrador escribió después, así que no hay forma de saber cuáles retirar."
  },
  {
    version: 5,
    nombre: "solicitudes de cambio de especialidad (tabla nueva + enlace en notificaciones)",
    migrar(d) {
      d.exec(`
        CREATE TABLE IF NOT EXISTS solicitudes_especialidad (
          id                      INTEGER PRIMARY KEY AUTOINCREMENT,
          usuario_id              TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
          especialidad_actual     TEXT,
          especialidad_solicitada TEXT NOT NULL,
          estado                  TEXT NOT NULL DEFAULT 'pendiente',
          creada_en               TEXT,
          resuelta_por            TEXT REFERENCES usuarios(id),
          resuelta_en             TEXT
        )
      `);
      const columnas = d.prepare("PRAGMA table_info(notificaciones)").all();
      if (!columnas.some((c) => c.name === "solicitud_id")) {
        d.exec("ALTER TABLE notificaciones ADD COLUMN solicitud_id INTEGER REFERENCES solicitudes_especialidad(id)");
      }
    },
    revertir(d) {
      const columnas = d.prepare("PRAGMA table_info(notificaciones)").all();
      if (columnas.some((c) => c.name === "solicitud_id")) {
        d.exec("ALTER TABLE notificaciones DROP COLUMN solicitud_id");
      }
      d.exec("DROP TABLE IF EXISTS solicitudes_especialidad");
    },
    nota: "Se pierden las solicitudes de cambio de especialidad guardadas."
  },
  {
    version: 6,
    nombre: "refresh tokens para sesiones de larga duración",
    migrar(d) {
      d.exec(`
        CREATE TABLE IF NOT EXISTS refresh_tokens (
          id         TEXT PRIMARY KEY,
          usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
          creado_en  INTEGER NOT NULL,
          expira_en  INTEGER NOT NULL,
          revocado   INTEGER NOT NULL DEFAULT 0
        )
      `);
      d.exec("CREATE INDEX IF NOT EXISTS idx_refresh_tokens_usuario ON refresh_tokens(usuario_id)");
    },
    revertir(d) {
      d.exec("DROP INDEX IF EXISTS idx_refresh_tokens_usuario");
      d.exec("DROP TABLE IF EXISTS refresh_tokens");
    },
    nota: "Se invalidan las sesiones de larga duración: todos los usuarios tendrán que iniciar sesión de nuevo."
  },
  {
    version: 7,
    nombre: "verificación en dos pasos (2FA) y tabla de auditoría de actividad",
    migrar(d) {
      d.exec(`
        CREATE TABLE IF NOT EXISTS auditoria (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          fecha      TEXT NOT NULL,
          usuario_id TEXT REFERENCES usuarios(id) ON DELETE SET NULL,
          rol        TEXT,
          accion     TEXT NOT NULL,
          detalle    TEXT DEFAULT '{}',
          ip         TEXT
        )
      `);
      d.exec("CREATE INDEX IF NOT EXISTS idx_auditoria_fecha ON auditoria(fecha)");
      d.exec("CREATE INDEX IF NOT EXISTS idx_auditoria_usuario ON auditoria(usuario_id)");
      const colUsuarios = d.prepare("PRAGMA table_info(usuarios)").all();
      if (!colUsuarios.some((c) => c.name === "totp_secreto")) {
        d.exec("ALTER TABLE usuarios ADD COLUMN totp_secreto TEXT");
      }
      if (!colUsuarios.some((c) => c.name === "totp_habilitado")) {
        d.exec("ALTER TABLE usuarios ADD COLUMN totp_habilitado INTEGER DEFAULT 0");
      }
    },
    revertir(d) {
      d.exec("DROP INDEX IF EXISTS idx_auditoria_fecha");
      d.exec("DROP INDEX IF EXISTS idx_auditoria_usuario");
      d.exec("DROP TABLE IF EXISTS auditoria");
      for (const col of ["totp_habilitado", "totp_secreto"]) {
        const columnas = d.prepare("PRAGMA table_info(usuarios)").all();
        if (columnas.some((c) => c.name === col)) {
          d.exec(`ALTER TABLE usuarios DROP COLUMN ${col}`);
        }
      }
    },
    nota: "Se pierde el historial de auditoría y las claves 2FA: quien las tenía activas deberá volver a configurarlas."
  },
  {
    version: 8,
    nombre: "restablecimiento de contraseña (tabla contrasena_resets)",
    migrar(d) {
      d.exec(`
        CREATE TABLE IF NOT EXISTS contrasena_resets (
          token        TEXT PRIMARY KEY,
          usuario_id   TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
          expira_en    INTEGER NOT NULL,
          usado        INTEGER NOT NULL DEFAULT 0
        )
      `);
    },
    revertir(d) {
      d.exec("DROP TABLE IF EXISTS contrasena_resets");
    },
    nota: "Los enlaces de restablecimiento en curso quedan invalidados."
  },
  {
    version: 9,
    nombre: "ficha real de laboratorios (sistema operativo, cantidad de equipos y servicios)",
    migrar(d) {
      const updLab = d.prepare(`
        UPDATE laboratorios
        SET nombre = @nombre, equipos = @equipos, so = @so, servicios = @servicios
        WHERE id = @id
      `);
      const updSo = d.prepare("UPDATE equipos SET so = ? WHERE lab_id = ?");
      const borrarSobrantes = d.prepare(`
        DELETE FROM equipos
        WHERE lab_id = ? AND id LIKE ?
          AND CAST(SUBSTR(id, LENGTH(id) - 1) AS INTEGER) > ?
      `);
      const existeEquipo = d.prepare("SELECT 1 AS ok FROM equipos WHERE id = ?");
      const hayLab = d.prepare("SELECT equipos FROM laboratorios WHERE id = ?");
      const insertEq = d.prepare(`
        INSERT INTO equipos (id,lab_id,nombre,tipo,fabricante,modelo,serie,procesador,ram,almacenamiento,so,ip,mac,monitor,teclado,mouse,estado,ultimo_encendido,observaciones)
        VALUES (@id,@lab_id,@nombre,@tipo,@fabricante,@modelo,@serie,@procesador,@ram,@almacenamiento,@so,@ip,@mac,@monitor,@teclado,@mouse,@estado,@ultimo_encendido,@observaciones)
      `);

      for (const l of DATOS_INVENTARIO) {
        if (!hayLab.get(l.id)) continue;
        updLab.run({
          id: l.id, nombre: l.nombre, equipos: l.equipos, so: l.so,
          servicios: JSON.stringify(l.servicios)
        });
        updSo.run(l.so, l.id);
        borrarSobrantes.run(l.id, `${l.id}-PC%`, l.equipos);
        const completo = LABORATORIOS.find((x) => x.id === l.id);
        for (let i = 1; i <= l.equipos; i++) {
          const eq = datosEquipo(completo, i);
          if (!existeEquipo.get(eq.id)) insertEq.run(eq);
        }
      }

      const updReporte = d.prepare("UPDATE reportes SET datos = ? WHERE id = ?");
      for (const id of ["rep_001", "rep_003"]) {
        const fila = d.prepare("SELECT datos FROM reportes WHERE id = ?").get(id);
        if (!fila) continue;
        let datos = {};
        try { datos = JSON.parse(fila.datos || "{}"); } catch (e) { continue; }
        if (!Array.isArray(datos.labels)) continue;
        datos.labels = datos.labels.map((x) => (x === "Lab Redes" ? "Lab 5" : x));
        updReporte.run(JSON.stringify(datos), id);
      }
      const inv = d.prepare("SELECT datos FROM reportes WHERE id = 'rep_004'").get();
      if (inv) {
        let datos = {};
        try { datos = JSON.parse(inv.datos || "{}"); } catch (e) { datos = {}; }
        if (typeof datos.total === "number") {
          datos.total = TOTAL_EQUIPOS_INVENTARIO;
          if (typeof datos.activos === "number") {
            datos.activos = TOTAL_EQUIPOS_INVENTARIO
              - INVENTARIO_EJEMPLO.enFalla - INVENTARIO_EJEMPLO.enMantencion;
          }
          updReporte.run(JSON.stringify(datos), "rep_004");
        }
      }
    },
    reversible: false,
    nota: "No se puede deshacer: sobrescribe la ficha de los laboratorios, borra los equipos que sobraban y reescribe los reportes de ejemplo. Los valores anteriores no quedan guardados."
  },
  {
    version: 10,
    nombre: "alinear_columnas_con_el_esquema",
    migrar: async (d) => {
      const canonico = new DatabaseSync(":memory:");
      const anadidas = [];
      const omitidas = [];
      try {
        crearEsquema(canonico);
        const tablas = canonico
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all();
        for (const { name } of tablas) {
          const ref = `"${String(name).replace(/"/g, '""')}"`;
          const reales = new Set(d.prepare(`PRAGMA table_info(${ref})`).all().map((c) => c.name));
          for (const col of canonico.prepare(`PRAGMA table_info(${ref})`).all()) {
            if (reales.has(col.name)) continue;
            if (col.pk || (col.notnull && col.dflt_value == null)) {
              omitidas.push(`${name}.${col.name}`);
              continue;
            }
            const tipo = col.type || "TEXT";
            const def = col.dflt_value != null
              ? `${col.name} ${tipo} NOT NULL DEFAULT ${col.dflt_value}`
              : `${col.name} ${tipo}`;
            d.exec(`ALTER TABLE ${ref} ADD COLUMN ${def}`);
            anadidas.push(`${name}.${col.name}`);
          }
        }
      } finally {
        canonico.close();
      }
      if (anadidas.length) console.log(`  Migración 10: columnas añadidas: ${anadidas.join(", ")}`);
      if (omitidas.length) {
        console.warn(
          `  Migración 10: no se pudieron añadir ${omitidas.join(", ")} (SQLite no admite ` +
          "añadir una clave primaria ni una columna obligatoria sin valor por defecto). Revísalas a mano."
        );
      }
    },
    nota: "Las columnas que añadió no se pueden quitar sin perder los datos que se hayan escrito en ellas, así que se dejan en su sitio. Forzar el rollback solo desregistra la migración: la base queda con las columnas añadidas, que no estorban."
  },
  {
    version: 11,
    nombre: "desafíos de verificación en dos pasos persistidos en la base",
    migrar(d) {
      d.exec(`
        CREATE TABLE IF NOT EXISTS desafios_2fa (
          login_id   TEXT PRIMARY KEY,
          usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
          expira     INTEGER NOT NULL,
          intentos   INTEGER NOT NULL DEFAULT 0
        )
      `);
      d.exec("CREATE INDEX IF NOT EXISTS idx_desafios_2fa_expira ON desafios_2fa(expira)");
      d.exec(`
        CREATE TABLE IF NOT EXISTS pendientes_2fa (
          usuario_id TEXT PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
          secreto    TEXT NOT NULL,
          expira     INTEGER NOT NULL
        )
      `);
      d.exec("CREATE INDEX IF NOT EXISTS idx_pendientes_2fa_expira ON pendientes_2fa(expira)");
    },
    revertir(d) {
      d.exec("DROP INDEX IF EXISTS idx_pendientes_2fa_expira");
      d.exec("DROP TABLE IF EXISTS pendientes_2fa");
      d.exec("DROP INDEX IF EXISTS idx_desafios_2fa_expira");
      d.exec("DROP TABLE IF EXISTS desafios_2fa");
    },
    nota: "Se pierden los desafíos de login en curso y las configuraciones 2FA a medias: quien estuviera activando la verificación tendrá que volver a empezar."
  },
  {
    version: 12,
    nombre: "referencia al usuario en las notificaciones (usuario_ref)",
    migrar(d) {
      const columnas = d.prepare("PRAGMA table_info(notificaciones)").all();
      if (!columnas.some((c) => c.name === "usuario_ref")) {
        d.exec("ALTER TABLE notificaciones ADD COLUMN usuario_ref TEXT REFERENCES usuarios(id) ON DELETE SET NULL");
      }
    },
    revertir(d) {
      const columnas = d.prepare("PRAGMA table_info(notificaciones)").all();
      if (columnas.some((c) => c.name === "usuario_ref")) {
        d.exec("ALTER TABLE notificaciones DROP COLUMN usuario_ref");
      }
    },
    nota: "Se pierde el enlace directo desde las notificaciones a la ficha del usuario."
  },
  {
    version: 13,
    nombre: "clave foránea de notificaciones.reporte_id a reportes(id)",
    migrar(d) {
      const fks = d.prepare("PRAGMA foreign_key_list(notificaciones)").all();
      if (fks.some((f) => f.from === "reporte_id" && f.table === "reportes")) return;
      d.exec(`
        CREATE TABLE notificaciones_v13 (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          usuario_id   TEXT REFERENCES usuarios(id) ON DELETE CASCADE,
          tipo         TEXT NOT NULL,
          titulo       TEXT NOT NULL,
          mensaje      TEXT,
          reporte_id   TEXT REFERENCES reportes(id) ON DELETE SET NULL,
          solicitud_id INTEGER REFERENCES solicitudes_especialidad(id),
          usuario_ref  TEXT REFERENCES usuarios(id) ON DELETE SET NULL,
          fecha        TEXT,
          leida        INTEGER DEFAULT 0
        )
      `);
      d.exec(`
        UPDATE notificaciones
        SET reporte_id = NULL
        WHERE reporte_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM reportes WHERE id = reporte_id)
      `);
      d.exec(`
        INSERT INTO notificaciones_v13
          (id, usuario_id, tipo, titulo, mensaje, reporte_id, solicitud_id, usuario_ref, fecha, leida)
        SELECT id, usuario_id, tipo, titulo, mensaje, reporte_id, solicitud_id, usuario_ref, fecha, leida
        FROM notificaciones
      `);
      d.exec("DROP TABLE notificaciones");
      d.exec("ALTER TABLE notificaciones_v13 RENAME TO notificaciones");
      d.exec("CREATE INDEX IF NOT EXISTS idx_notificaciones_usuario ON notificaciones(usuario_id, id)");
    },
    revertir(d) {
      const fks = d.prepare("PRAGMA foreign_key_list(notificaciones)").all();
      if (!fks.some((f) => f.from === "reporte_id" && f.table === "reportes")) return;
      d.exec(`
        CREATE TABLE notificaciones_v13_ant (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          usuario_id   TEXT REFERENCES usuarios(id) ON DELETE CASCADE,
          tipo         TEXT NOT NULL,
          titulo       TEXT NOT NULL,
          mensaje      TEXT,
          reporte_id   TEXT,
          solicitud_id INTEGER REFERENCES solicitudes_especialidad(id),
          usuario_ref  TEXT REFERENCES usuarios(id) ON DELETE SET NULL,
          fecha        TEXT,
          leida        INTEGER DEFAULT 0
        )
      `);
      d.exec(`
        INSERT INTO notificaciones_v13_ant
          (id, usuario_id, tipo, titulo, mensaje, reporte_id, solicitud_id, usuario_ref, fecha, leida)
        SELECT id, usuario_id, tipo, titulo, mensaje, reporte_id, solicitud_id, usuario_ref, fecha, leida
        FROM notificaciones
      `);
      d.exec("DROP TABLE notificaciones");
      d.exec("ALTER TABLE notificaciones_v13_ant RENAME TO notificaciones");
      d.exec("CREATE INDEX IF NOT EXISTS idx_notificaciones_usuario ON notificaciones(usuario_id, id)");
    },
    nota: "Se conservan las notificaciones; las que apuntaban a reportes borrados quedan sin reporte_id."
  }
];

const ULTIMA_VERSION = MIGRACIONES[MIGRACIONES.length - 1].version;

const esReversible = (m) => Boolean(m.revertir) && m.reversible !== false;

function crearTablaMigraciones(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      nombre      TEXT NOT NULL,
      aplicada_en TEXT NOT NULL
    )
  `);
}

export function estadoMigraciones(conexion = db) {
  crearTablaMigraciones(conexion);
  const aplicadas = new Set(
    conexion.prepare("SELECT version FROM schema_migrations").all().map((r) => Number(r.version))
  );
  const declaradas = new Set(MIGRACIONES.map((m) => m.version));
  return {
    aplicadas: [...aplicadas].sort((a, b) => a - b),
    faltantes: MIGRACIONES.filter((m) => !aplicadas.has(m.version)).map((m) => m.version),
    masNueva: aplicadas.size > 0 && Math.max(...aplicadas) > ULTIMA_VERSION,
    desconocidas: [...aplicadas].filter((v) => !declaradas.has(v)).sort((a, b) => a - b),
    ultimaConocida: ULTIMA_VERSION
  };
}

async function aplicarMigraciones(conexion) {
  crearTablaMigraciones(conexion);
  const estado = estadoMigraciones(conexion);
  if (estado.masNueva) {
    const err = new Error(
      `La base de datos está en la versión de esquema ${Math.max(...estado.aplicadas)}, ` +
      `pero este programa solo conoce hasta la ${ULTIMA_VERSION}. Actualiza LabControl ` +
      "o restaura un respaldo de una versión compatible."
    );
    err.status = 409;
    throw err;
  }
  for (const m of MIGRACIONES) {
    if (estado.aplicadas.includes(m.version)) continue;
    conexion.exec(`SAVEPOINT migracion_${m.version}`);
    try {
      await m.migrar(conexion);
      conexion.prepare("INSERT INTO schema_migrations (version, nombre, aplicada_en) VALUES (?,?,?)")
        .run(m.version, m.nombre, new Date().toISOString());
      conexion.exec(`RELEASE migracion_${m.version}`);
      console.log(`  Migración ${m.version} aplicada: ${m.nombre}`);
    } catch (err) {
      conexion.exec(`ROLLBACK TO migracion_${m.version}`);
      conexion.exec(`RELEASE migracion_${m.version}`);
      console.error(`  Migración ${m.version} fallida y revertida: ${m.nombre}\n    ${err?.message || err}`);
      throw err;
    }
  }
}

export async function revertirMigraciones(conexion, objetivo = 0, { forzar = false } = {}) {
  crearTablaMigraciones(conexion);
  const aplicadas = estadoMigraciones(conexion).aplicadas;
  const ordenadas = [...aplicadas].sort((a, b) => b - a);
  const revertidas = [];

  const deshacerTodo = (err) => {
    try {
      conexion.exec("ROLLBACK TO revertir_todo");
      conexion.exec("RELEASE revertir_todo");
    } catch (rollback) {
      console.error("No se pudo deshacer el rollback:", rollback?.message || rollback);
    }
    return err;
  };

  conexion.exec("SAVEPOINT revertir_todo");
  for (const version of ordenadas) {
    if (version <= objetivo) break;
    const m = MIGRACIONES.find((x) => x.version === version);
    if (!m) {
      throw deshacerTodo(new Error(`No se puede revertir la migración ${version}: este programa no la conoce.`));
    }
    if (!esReversible(m) && !forzar) {
      throw deshacerTodo(new Error(
        `No se puede revertir la migración ${version} (${m.nombre}): ${m.nota || "no declara un paso de vuelta"}. ` +
        "Usa `forzar` solo si aceptas perder esos datos, y restaura un respaldo previo."
      ));
    }
    conexion.exec(`SAVEPOINT revertir_${version}`);
    try {
      if (m.revertir) await m.revertir(conexion);
      conexion.prepare("DELETE FROM schema_migrations WHERE version = ?").run(version);
      conexion.exec(`RELEASE revertir_${version}`);
      revertidas.push(version);
      console.log(`  Migración ${version} revertida: ${m.nombre}`);
    } catch (err) {
      conexion.exec(`ROLLBACK TO revertir_${version}`);
      conexion.exec(`RELEASE revertir_${version}`);
      throw deshacerTodo(new Error(`Falló la reversión de la migración ${version} (${m.nombre}): ${err?.message || err}`));
    }
  }
  conexion.exec("RELEASE revertir_todo");
  return revertidas;
}

limpiarTemporales();
db = await abrirConexion();

const SEMILLA_VERSION = 2;

const SEED_DEMO = /^(1|true|si|sí|yes|on)$/i.test(String(process.env.LC_SEED_DEMO || "").trim());

const EXIGIR_ROTACION_DEMO = /^(1|true|si|sí|yes|on)$/i.test(String(process.env.LC_EXIGIR_ROTACION_DEMO || "").trim());

const ADMIN_USUARIO = String(process.env.LC_ADMIN_USER || "").trim();
const ADMIN_PASSWORD = process.env.LC_ADMIN_PASSWORD || "";
const ADMIN_EMAIL = String(process.env.LC_ADMIN_EMAIL || "").trim();

const USUARIOS = [
  { id: "INSUCO", nombre: "Administrador", apellido: "Sistema", iniciales: "AD", email: "admin@liceo.cl", password: "$2a$10$LiDipTw/DKNGZQ6Fd0YjWegPqXBnLBXhF/iesNoRGu1gdff8s62e6", rol: "admin", area: "Administración", especialidad: "Gestión de sistemas y redes", nivelAcceso: "total" },
  { id: "prof_juan", nombre: "Juan", apellido: "Pérez", iniciales: "JP", email: "jperez@liceo.cl", password: "$2a$10$QiTxzjVUWgT1Uy/FODC8fO4WOL1zl61UuJPuUNNiuBKqyL6c8giiq", rol: "programacion", area: "Programación", especialidad: "Desarrollo Web y Redes", nivelAcceso: "tecnico" },
  { id: "prof_ana", nombre: "Ana", apellido: "López", iniciales: "AL", email: "alopez@liceo.cl", password: "$2a$10$zPDCNPfQSorhQxp7dl7Jv.KbIPVB/mV6X9.lFK7QAQgQdoV7nE7b2", rol: "programacion", area: "Programación", especialidad: "Bases de Datos y Programación", nivelAcceso: "tecnico" },
  { id: "prof_diego", nombre: "Diego", apellido: "Rojas", iniciales: "DR", email: "drojas@liceo.cl", password: "$2a$10$c/iRL.Oi4eIs4cjr53zvLOloefjVBuqCk9AOSxH4dH5EUMCh3VmpS", rol: "programacion", area: "Programación", especialidad: "Sistemas Operativos y Linux", nivelAcceso: "tecnico" },
  { id: "prof_camila", nombre: "Camila", apellido: "Soto", iniciales: "CS", email: "csoto@liceo.cl", password: "$2a$10$FA1/cq8EBgFtG6xCUg.82.o.LtemDH2TaZhoNxdsFQ9am6szR9GZW", rol: "otro_area", area: "Matemáticas", especialidad: "Matemáticas y Estadística", nivelAcceso: "basico" },
  { id: "prof_marcos", nombre: "Marcos", apellido: "Vera", iniciales: "MV", email: "mvera@liceo.cl", password: "$2a$10$SsoiWOWVqhO7fQVXKF7cF.oRiX7tNJl6L0OZahFBfCYdawSOXVPpO", rol: "otro_area", area: "Ciencias", especialidad: "Física y Química", nivelAcceso: "basico" },
  { id: "prof_lucia", nombre: "Lucía", apellido: "Fuentes", iniciales: "LF", email: "lfuentes@liceo.cl", password: "$2a$10$cQ1EpnNrTdMtygZ2nJNRKuH9qK9cFn2bUjaSPqbxw800piHywihWG", rol: "otro_area", area: "Lenguaje", especialidad: "Lengua y Literatura", nivelAcceso: "basico" }
];

const AGENDA = [
  { id: "res_001", labId: 1, usuarioId: "prof_juan", fecha: "2026-08-25", horaInicio: "08:00", horaFin: "10:00", motivo: "Clase de Programación Web", estado: "confirmada" },
  { id: "res_002", labId: 2, usuarioId: "prof_camila", fecha: "2026-08-25", horaInicio: "10:30", horaFin: "12:00", motivo: "Taller de Estadística aplicada", estado: "confirmada" },
  { id: "res_003", labId: 3, usuarioId: "prof_diego", fecha: "2026-08-22", horaInicio: "08:00", horaFin: "12:00", motivo: "Clase de Sistemas Operativos Linux", estado: "confirmada" },
  { id: "res_004", labId: 1, usuarioId: "prof_marcos", fecha: "2026-08-26", horaInicio: "14:00", horaFin: "16:00", motivo: "Laboratorio de Física computacional", estado: "pendiente" },
  { id: "res_005", labId: 5, usuarioId: "prof_juan", fecha: "2026-08-27", horaInicio: "09:00", horaFin: "11:00", motivo: "Clase de ofimática y navegación segura", estado: "confirmada" }
];

const REPORTES = [
  {
    id: "rep_001", tipo: "uso", titulo: "Uso mensual de laboratorios",
    descripcion: "Reporte de horas de uso por laboratorio en el mes de julio 2026.",
    fecha: "2026-07-31", generadoPor: "INSUCO",
    datos: { labels: ["Lab 1", "Lab 2", "Lab 3", "Lab 4", "Lab 5"], valores: [72, 68, 55, 20, 80] }
  },
  {
    id: "rep_002", tipo: "fallas", titulo: "Registro de fallas de equipos",
    descripcion: "Equipos con fallas reportadas durante agosto 2026.",
    fecha: "2026-08-15", generadoPor: "prof_juan",
    datos: { fallas: [
      { equipo: "PC-403", lab: "Lab 4", descripcion: "Disco duro con sectores defectuosos", estado: "en reparación" },
      { equipo: "PC-105", lab: "Lab 1", descripcion: "Teclado no funciona", estado: "resuelto" },
      { equipo: "PC-312", lab: "Lab 3", descripcion: "Pantalla con líneas horizontales", estado: "pendiente" }
    ] }
  },
  {
    id: "rep_003", tipo: "disponibilidad", titulo: "Disponibilidad semanal",
    descripcion: "Porcentaje de disponibilidad por laboratorio — semana del 17 al 21 de agosto 2026.",
    fecha: "2026-08-21", generadoPor: "INSUCO",
    datos: { labels: ["Lab 1", "Lab 2", "Lab 3", "Lab 4", "Lab 5"], valores: [85, 90, 60, 0, 95] }
  },
  {
    id: "rep_004", tipo: "inventario", titulo: "Inventario de equipos actualizado",
    descripcion: "Listado completo del estado de todos los equipos en los laboratorios.",
    fecha: "2026-08-20", generadoPor: "INSUCO",
    datos: {
      total: TOTAL_EQUIPOS_INVENTARIO,
      activos: TOTAL_EQUIPOS_INVENTARIO - INVENTARIO_EJEMPLO.enFalla - INVENTARIO_EJEMPLO.enMantencion,
      enFalla: INVENTARIO_EJEMPLO.enFalla,
      enMantencion: INVENTARIO_EJEMPLO.enMantencion
    }
  }
];

function completarSiVacio(d, tabla, id, valores, clave) {
  const sets = [];
  const args = [];
  const pendientes = [];
  for (const [col, valor] of Object.entries(valores)) {
    if (valor === null || valor === undefined || valor === "") continue;
    sets.push(`${col} = CASE WHEN ${col} IS NULL OR ${col} = '' THEN ? ELSE ${col} END`);
    args.push(valor);
    pendientes.push(`(${col} IS NULL OR ${col} = '')`);
  }
  if (!sets.length) return false;
  const info = d.prepare(
    `UPDATE ${tabla} SET ${sets.join(", ")} WHERE ${clave} = ? AND (${pendientes.join(" OR ")})`
  ).run(...args, id);
  return Number(info.changes || 0) > 0;
}

async function aplicarSemilla(conexion = db) {
  const resumen = { version: SEMILLA_VERSION, labs: 0, equipos: 0, usuarios: 0, admin: 0, agenda: 0, reportes: 0, completados: 0 };

  const existeUsuario = conexion.prepare("SELECT id FROM usuarios WHERE id = ?");
  const passwords = new Map();
  if (SEED_DEMO) {
    for (const u of USUARIOS) {
      if (existeUsuario.get(u.id)) continue;
      const yaHasheado = typeof u.password === "string" && /^\$2[aby]\$/.test(u.password);
      passwords.set(u.id, yaHasheado ? u.password : await bcrypt.hash(u.password, 10));
    }
  }

  let adminHash = null;
  if (!SEED_DEMO && ADMIN_PASSWORD) {
    const hayAdminActivo = conexion.prepare("SELECT id FROM usuarios WHERE rol = 'admin' AND activo = 1").get();
    const idAdmin = ADMIN_USUARIO || "INSUCO";
    if (!hayAdminActivo && !existeUsuario.get(idAdmin)) {
      adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    }
  }

  conexion.exec("BEGIN");
  try {
    const insertLab = conexion.prepare(`
      INSERT INTO laboratorios (id,nombre,sala,ubicacion,equipos,estado,so,procesador,ram,almacenamiento,red,responsable,responsable_id,horario,servicios,descripcion,foto,imagenes,pos_x,pos_y,pos_w,pos_h)
      VALUES (@id,@nombre,@sala,@ubicacion,@equipos,@estado,@so,@procesador,@ram,@almacenamiento,@red,@responsable,@responsable_id,@horario,@servicios,@descripcion,@foto,@imagenes,@pos_x,@pos_y,@pos_w,@pos_h)
    `);
    const insertUsr = conexion.prepare(`
      INSERT INTO usuarios (id,nombre,apellido,iniciales,email,password,rol,area,especialidad,nivel_acceso,activo)
      VALUES (@id,@nombre,@apellido,@iniciales,@email,@password,@rol,@area,@especialidad,@nivel_acceso,1)
    `);
    const insertEquipo = conexion.prepare(`
      INSERT INTO equipos (id,lab_id,nombre,tipo,fabricante,modelo,serie,procesador,ram,almacenamiento,so,ip,mac,monitor,teclado,mouse,estado,ultimo_encendido,observaciones)
      VALUES (@id,@lab_id,@nombre,@tipo,@fabricante,@modelo,@serie,@procesador,@ram,@almacenamiento,@so,@ip,@mac,@monitor,@teclado,@mouse,@estado,@ultimo_encendido,@observaciones)
    `);
    const insertAgenda = conexion.prepare(`
      INSERT INTO agenda (id, lab_id, usuario_id, fecha, hora_inicio, hora_fin, motivo, estado)
      VALUES (@id, @lab_id, @usuario_id, @fecha, @hora_inicio, @hora_fin, @motivo, @estado)
    `);
    const insertReporte = conexion.prepare(`
      INSERT INTO reportes (id,tipo,titulo,descripcion,fecha,generado_por,datos,adjuntos)
      VALUES (@id,@tipo,@titulo,@descripcion,@fecha,@generado_por,@datos,@adjuntos)
    `);
    const hayLab = conexion.prepare("SELECT id FROM laboratorios WHERE id = ?");
    const hayEquipo = conexion.prepare("SELECT id FROM equipos WHERE id = ?");
    const hayUsuario = conexion.prepare("SELECT id FROM usuarios WHERE id = ?");
    const hayAgenda = conexion.prepare("SELECT id FROM agenda WHERE id = ?");
    const hayReporte = conexion.prepare("SELECT id FROM reportes WHERE id = ?");

    for (const l of LABORATORIOS) {
      const ficha = {
        id: l.id, nombre: l.nombre, sala: l.sala, ubicacion: l.ubicacion, equipos: l.equipos,
        estado: l.estado, so: l.so, procesador: l.procesador, ram: l.ram,
        almacenamiento: l.almacenamiento, red: l.red, responsable: l.responsable,
        responsable_id: l.responsableId, horario: l.horario, servicios: JSON.stringify(l.servicios),
        descripcion: l.descripcion, foto: l.foto,
        imagenes: JSON.stringify(l.imagenes || []),
        pos_x: l.posicion.x, pos_y: l.posicion.y, pos_w: l.posicion.w, pos_h: l.posicion.h
      };
      if (hayLab.get(l.id)) {
        if (completarSiVacio(conexion, "laboratorios", l.id, {
          nombre: l.nombre, sala: l.sala, ubicacion: l.ubicacion, so: l.so,
          procesador: l.procesador, ram: l.ram, almacenamiento: l.almacenamiento,
          red: l.red, responsable: l.responsable, responsable_id: l.responsableId,
          horario: l.horario, servicios: ficha.servicios, descripcion: l.descripcion,
          foto: l.foto, imagenes: ficha.imagenes,
          pos_x: l.posicion.x, pos_y: l.posicion.y, pos_w: l.posicion.w, pos_h: l.posicion.h
        }, "id")) resumen.completados++;
      } else {
        insertLab.run(ficha);
        resumen.labs++;
      }

      for (let i = 1; i <= l.equipos; i++) {
        const eq = datosEquipo(l, i);
        if (hayEquipo.get(eq.id)) {
          if (completarSiVacio(conexion, "equipos", eq.id, {
            nombre: eq.nombre, tipo: eq.tipo, fabricante: eq.fabricante, modelo: eq.modelo,
            serie: eq.serie, procesador: eq.procesador, ram: eq.ram, almacenamiento: eq.almacenamiento,
            so: eq.so, ip: eq.ip, mac: eq.mac, monitor: eq.monitor, teclado: eq.teclado, mouse: eq.mouse
          }, "id")) resumen.completados++;
        } else {
          insertEquipo.run(eq);
          resumen.equipos++;
        }
      }
    }

    if (SEED_DEMO) {
      for (const u of USUARIOS) {
        if (hayUsuario.get(u.id)) {
          if (completarSiVacio(conexion, "usuarios", u.id, {
            nombre: u.nombre, apellido: u.apellido, iniciales: u.iniciales,
            email: u.email, area: u.area, especialidad: u.especialidad
          }, "id")) resumen.completados++;
          continue;
        }
        insertUsr.run({
          id: u.id, nombre: u.nombre, apellido: u.apellido, iniciales: u.iniciales,
          email: u.email, password: passwords.get(u.id), rol: u.rol, area: u.area,
          especialidad: u.especialidad, nivel_acceso: u.nivelAcceso
        });
        resumen.usuarios++;
      }
    } else if (adminHash) {
      const idAdmin = ADMIN_USUARIO || "INSUCO";
      insertUsr.run({
        id: idAdmin, nombre: "Administrador", apellido: "Sistema", iniciales: "AD",
        email: ADMIN_EMAIL || "admin@liceo.cl", password: adminHash, rol: "admin",
        area: "Administración", especialidad: "", nivel_acceso: "total"
      });
      resumen.admin++;
    }

    if (SEED_DEMO) for (const r of AGENDA) {
      if (hayAgenda.get(r.id)) continue;
      insertAgenda.run({
        id: r.id, lab_id: r.labId, usuario_id: r.usuarioId, fecha: r.fecha,
        hora_inicio: r.horaInicio, hora_fin: r.horaFin, motivo: r.motivo, estado: r.estado
      });
      resumen.agenda++;
    }

    if (SEED_DEMO) for (const r of REPORTES) {
      if (hayReporte.get(r.id)) continue;
      insertReporte.run({
        id: r.id, tipo: r.tipo, titulo: r.titulo, descripcion: r.descripcion,
        fecha: r.fecha, generado_por: r.generadoPor, datos: JSON.stringify(r.datos),
        adjuntos: JSON.stringify(r.adjuntos || [])
      });
      resumen.reportes++;
    }

    if (!conexion.prepare("SELECT id FROM config WHERE id = 1").get()) {
      conexion.prepare("INSERT INTO config (id, data) VALUES (1, ?)").run(JSON.stringify(CONFIG_DEFAULT));
    }

    conexion.prepare(
      "INSERT INTO seed_history (version, aplicada_en, resumen) VALUES (?,?,?) " +
      "ON CONFLICT(version) DO UPDATE SET aplicada_en = excluded.aplicada_en, resumen = excluded.resumen"
    ).run(SEMILLA_VERSION, new Date().toISOString(), JSON.stringify(resumen));

    conexion.exec("COMMIT");
  } catch (err) {
    conexion.exec("ROLLBACK");
    throw err;
  }
  return resumen;
}

export function cuentasDemoSinRotar(conexion = db) {
  if (!conexion) return [];
  const pendientes = [];
  const ver = conexion.prepare("SELECT password FROM usuarios WHERE id = ?");
  for (const u of USUARIOS) {
    const fila = ver.get(u.id);
    if (!fila) continue;
    const hasheada = typeof u.password === "string" && /^\$2[aby]\$/.test(u.password);
    if (hasheada && fila.password === u.password) pendientes.push(u.id);
  }
  return pendientes;
}

function avisarCuentasDeEjemplo() {
  const pendientes = cuentasDemoSinRotar();
  if (!pendientes.length) return pendientes;

  if (EXIGIR_ROTACION_DEMO && !SEED_DEMO) {
    throw new Error(
      `LC_EXIGIR_ROTACION_DEMO está activo y ${pendientes.length} cuenta(s) de ` +
      `ejemplo conservan la contraseña publicada del proyecto ` +
      `(${pendientes.join(", ")}). Cámbialas o desactívalas antes de arrancar.`
    );
  }

  console.warn(
    `  AVISO: ${pendientes.length} cuenta(s) de ejemplo conservan la contraseña ` +
    `publicada del proyecto (${pendientes.join(", ")}). ` +
    (SEED_DEMO
      ? "Es lo esperado con LC_SEED_DEMO=1; no uses esta base en producción."
      : "Cámbialas o desactívalas antes de usar el sistema en producción.")
  );
  return pendientes;
}

if (esNueva) {
  console.log("Base de datos nueva: preparando la base…");
}
const resumenSemilla = await aplicarSemilla();
if (resumenSemilla.labs || resumenSemilla.usuarios || resumenSemilla.admin || resumenSemilla.equipos || resumenSemilla.agenda || resumenSemilla.reportes || resumenSemilla.completados) {
  console.log(
    `Semilla v${resumenSemilla.version}: ${resumenSemilla.labs} laboratorios, ` +
    `${resumenSemilla.equipos} equipos, ${resumenSemilla.usuarios} usuarios, ` +
    `${resumenSemilla.admin} administrador(es), ${resumenSemilla.agenda} reservas, ` +
    `${resumenSemilla.reportes} reportes y ${resumenSemilla.completados} fichas completadas.`
  );
}

if (!SEED_DEMO) {
  if (!db.prepare("SELECT id FROM usuarios WHERE rol = 'admin' AND activo = 1").get()) {
    console.warn(
      "  AVISO: no hay ninguna cuenta de administrador activa. Define LC_ADMIN_USER y " +
      "LC_ADMIN_PASSWORD (y reinicia) para crear una; LC_SEED_DEMO=1 solo es para " +
      "entornos de desarrollo."
    );
  }
}

avisarCuentasDeEjemplo();

export { DB_PATH, DB_DIR, db, abrirConexion, MIGRACIONES, SEMILLA_VERSION, aplicarSemilla };

function tieneLaTabla(d, tabla) {
  return Boolean(d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabla));
}

export function podarTablas(conexion = db) {
  const aplicadas = new Set(estadoMigraciones(conexion).aplicadas);
  const borradas = {};

  if (aplicadas.has(5) && tieneLaTabla(conexion, "solicitudes_especialidad")) {
    conexion.exec("CREATE INDEX IF NOT EXISTS idx_solicitudes_usuario ON solicitudes_especialidad(usuario_id, id)");
  }
  if (aplicadas.has(8) && tieneLaTabla(conexion, "contrasena_resets")) {
    conexion.exec("CREATE INDEX IF NOT EXISTS idx_resets_usuario ON contrasena_resets(usuario_id)");
  }

  if (aplicadas.has(7) && tieneLaTabla(conexion, "auditoria")) {
    const info = conexion.prepare(
      "DELETE FROM auditoria WHERE id NOT IN (SELECT id FROM auditoria ORDER BY id DESC LIMIT 5000)"
    ).run();
    borradas.auditoria = Number(info.changes || 0);
  }
  if (tieneLaTabla(conexion, "notificaciones")) {
    const info = conexion.prepare(
      "DELETE FROM notificaciones WHERE id NOT IN (SELECT id FROM notificaciones ORDER BY id DESC LIMIT 20000)"
    ).run();
    borradas.notificaciones = Number(info.changes || 0);
  }
  if (aplicadas.has(6) && tieneLaTabla(conexion, "refresh_tokens")) {
    const info = conexion.prepare("DELETE FROM refresh_tokens WHERE expira_en < ?").run(Date.now());
    borradas.refreshTokensVencidos = Number(info.changes || 0);
  }
  if (aplicadas.has(8) && tieneLaTabla(conexion, "contrasena_resets")) {
    const info = conexion.prepare("DELETE FROM contrasena_resets WHERE expira_en < ?").run(Date.now());
    borradas.resetsVencidos = Number(info.changes || 0);
    const extra = conexion.prepare(`
      DELETE FROM contrasena_resets
      WHERE token NOT IN (
        SELECT token FROM contrasena_resets ORDER BY expira_en DESC LIMIT 200
      )
    `).run();
    borradas.resetsSobrantes = Number(extra.changes || 0);
  }
  if (aplicadas.has(5) && tieneLaTabla(conexion, "solicitudes_especialidad")) {
    const info = conexion.prepare(`
      DELETE FROM solicitudes_especialidad
      WHERE estado != 'pendiente'
        AND id NOT IN (
          SELECT id FROM solicitudes_especialidad WHERE estado != 'pendiente'
          ORDER BY id DESC LIMIT 1000
        )
    `).run();
    borradas.solicitudes = Number(info.changes || 0);
    const porUsuario = conexion.prepare(`
      DELETE FROM solicitudes_especialidad
      WHERE estado != 'pendiente'
        AND id NOT IN (
          SELECT id FROM solicitudes_especialidad
          WHERE usuario_id = solicitudes_especialidad.usuario_id AND estado != 'pendiente'
          ORDER BY id DESC LIMIT 100
        )
    `).run();
    borradas.solicitudesPorUsuario = Number(porUsuario.changes || 0);
  }

  const total = Object.values(borradas).reduce((a, b) => a + b, 0);
  return total > 0 ? borradas : null;
}

function esErrorTransitorio(err) {
  const mensaje = String(err?.message || err).toLowerCase();
  return mensaje.includes("locked") || mensaje.includes("eperm") || mensaje.includes("permission denied");
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function reintentar(fn, intentos = 6, pausaMs = 150) {
  let ultimoError;
  for (let i = 0; i < intentos; i++) {
    try {
      return await fn();
    } catch (err) {
      ultimoError = err;
      if (!esErrorTransitorio(err) || i === intentos - 1) throw err;
      await dormir(pausaMs);
    }
  }
  throw ultimoError;
}

const TABLAS_REQUERIDAS = [
  "laboratorios", "equipos", "usuarios", "agenda", "reportes", "notificaciones", "config"
];

function validarCopia(ruta) {
  let d;
  try {
    d = new DatabaseSync(ruta, { readOnly: true });
    d.exec("PRAGMA busy_timeout = 5000");
    verificarIntegridadTotal(d, "el archivo está dañado o incompleto");
    const existentes = new Set(
      d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    );
    const faltantes = TABLAS_REQUERIDAS.filter((t) => !existentes.has(t));
    if (faltantes.length) {
      throw new Error(`le faltan las tablas ${faltantes.join(", ")}`);
    }
    return true;
  } finally {
    try { d?.close(); } catch {}
  }
}

function errorValidacion(mensaje) {
  const err = new Error(`El archivo recibido no es un respaldo utilizable: ${mensaje}.`);
  err.status = 400;
  return err;
}

export function crearCopiaConsistente() {
  if (!baseDisponible()) {
    const err = new Error("La base de datos se está restaurando; inténtalo de nuevo en unos segundos");
    err.status = 503;
    throw err;
  }

  const destino = rutaTemporal(`respaldo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  try {
    db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);

    const copia = new DatabaseSync(destino);
    try {
      verificarIntegridadTotal(copia, "La copia de seguridad no pasó la verificación de integridad");
    } finally {
      copia.close();
    }
    return destino;
  } catch (err) {
    try { fs.rmSync(destino, { force: true }); } catch {}
    throw err;
  }
}

export async function reemplazarBaseDesdeBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 100) {
    throw errorValidacion("es demasiado pequeño");
  }
  const cabecera = buffer.subarray(0, 16).toString("latin1");
  if (cabecera !== "SQLite format 3\u0000") {
    throw errorValidacion("no es una base de datos SQLite");
  }

  const temporal = rutaTemporal("restaurando.db");
  const prev = `${DB_PATH}.prev`;
  reemplazando = true;
  try {
    limpiarTemporales();
    fs.writeFileSync(temporal, buffer);
    try {
      validarCopia(temporal);
    } catch (err) {
      throw errorValidacion(err?.message || "no se pudo leer");
    }

    const nueva = await reintentar(() => abrirConexion(temporal));

    const anterior = db;
    db = null;
    anterior.close();
    nueva.close();

    fs.copyFileSync(DB_PATH, prev);
    fs.copyFileSync(temporal, DB_PATH);
    fs.rmSync(temporal, { force: true });

    db = await reintentar(() => abrirConexion());

    if (tablaExiste(db, "refresh_tokens")) {
      db.prepare("UPDATE refresh_tokens SET revocado = 1 WHERE revocado = 0").run();
    }
    for (const fn of ganchosAlRestaurar) {
      try { fn(); } catch (err) {
        console.error("Error en un gancho de restauración:", err?.message || err);
      }
    }
    return { rutaAnterior: prev, versionEsquema: estadoMigraciones(db).aplicadas };
  } catch (err) {
    try { fs.rmSync(temporal, { force: true }); } catch {}
    if (db === null) {
      let recuperada = false;
      for (const ruta of [prev, DB_PATH]) {
        if (!fs.existsSync(ruta)) continue;
        try {
          validarCopia(ruta);
          if (ruta !== DB_PATH) fs.copyFileSync(ruta, DB_PATH);
          db = await reintentar(() => abrirConexion());
          recuperada = true;
          break;
        } catch (intento) {
          console.error(`No se pudo recuperar la base desde ${ruta}:`, intento?.message || intento);
        }
      }
      if (!recuperada) console.error("No quedó ninguna base válida: el servidor queda sin datos.");
    }
    throw err;
  } finally {
    reemplazando = false;
  }
}

function tablaExiste(d, tabla) {
  return Boolean(d?.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabla));
}

export default db;
