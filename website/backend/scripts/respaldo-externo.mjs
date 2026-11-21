/* respaldo-externo.mjs — instantánea consistente + copia fuera del servidor.
 *
 *   node scripts/respaldo-externo.mjs
 *
 * Produce una copia con `VACUUM INTO` (no lee el archivo vivo), comprueba su
 * integridad y la deja en LC_BACKUP_DIR. Si hay un destino externo configurado,
 * la replica para que la pérdida del volumen no se lleve la única copia:
 *
 *   LC_BACKUP_COPIAR_A     carpeta de otro disco/NAS/USB montado.
 *   LC_BACKUP_S3_URI       destino S3/R2, p. ej. s3://labcontrol-backups/labcontrol/
 *   LC_BACKUP_S3_ENDPOINT  endpoint de R2 si no se usa AWS.
 *   LC_BACKUP_S3_REGION    región (para R2: auto).
 *
 * El servidor puede programarlo solo con LC_BACKUP_AUTO=1; en ese caso corre
 * una vez al día a la hora local indicada (LC_BACKUP_HORA, por defecto 02:15)
 * y recupera el respaldo si el proceso estuvo caído en ese momento. Nunca
 * imprime credenciales; el aviso final recuerda si la copia quedó solo en el
 * mismo volumen que la base.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DB_DIR = process.env.LC_DB_DIR
  ? path.resolve(process.env.LC_DB_DIR)
  : path.join(__dirname, "..", "database");

// Número de entorno con valor por defecto y mínimo razonable.
function numeroEnv(nombre, porDefecto, minimo = 1, env = process.env) {
  const n = Number(env[nombre]);
  return Number.isFinite(n) && n >= minimo ? n : porDefecto;
}

function rutaBase(env = process.env) {
  const dir = env.LC_DB_DIR ? path.resolve(env.LC_DB_DIR) : DB_DIR;
  return path.join(dir, "labcontrol.db");
}

function directorioRespaldo(env = process.env) {
  return env.LC_BACKUP_DIR
    ? path.resolve(env.LC_BACKUP_DIR)
    : path.join(path.dirname(rutaBase(env)), "backups");
}

// Crea una instantánea consistente. `VACUUM INTO` copia dentro de una única
// transacción de lectura, así que la copia no puede quedar a medias aunque el
// servidor esté escribiendo en ese momento.
export function crearInstantanea(rutaDb, dirSalida) {
  if (!fs.existsSync(rutaDb)) {
    throw new Error(`No existe la base de datos: ${rutaDb}`);
  }
  fs.mkdirSync(dirSalida, { recursive: true });

  const marca = new Date().toISOString().replace(/[:.]/g, "-");
  const sufijo = Math.random().toString(36).slice(2, 8);
  const destino = path.join(dirSalida, `labcontrol-${marca}-${sufijo}.db`);

  const db = new DatabaseSync(rutaDb);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  } catch (err) {
    fs.rmSync(destino, { force: true });
    throw err;
  } finally {
    db.close();
  }
  return destino;
}

// Valida que la copia se pueda abrir y que SQLite la considere íntegra.
export function verificarIntegridad(ruta) {
  const db = new DatabaseSync(ruta);
  try {
    const fila = db.prepare("PRAGMA integrity_check").get();
    const resultado = fila ? Object.values(fila)[0] : null;
    if (resultado !== "ok") {
      throw new Error(`La copia no pasó integrity_check: ${resultado}`);
    }
    return resultado;
  } finally {
    db.close();
  }
}

// Retención: conserva siempre las últimas `conservar` copias y, además, las
// que tengan menos de `dias`. Solo borra archivos con el nombre que genera
// este script (nunca bases ni temporales ajenos).
export function podarRespaldos(dir, { dias = 30, conservar = 7, ahora = Date.now() } = {}) {
  if (!fs.existsSync(dir)) return [];
  const limite = ahora - dias * 24 * 60 * 60 * 1000;

  const archivos = fs.readdirSync(dir)
    .filter((nombre) => /^labcontrol-.*\.db$/.test(nombre))
    .map((nombre) => {
      const ruta = path.join(dir, nombre);
      return { nombre, ruta, mtime: fs.statSync(ruta).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  const eliminados = [];
  archivos.forEach((archivo, indice) => {
    if (indice < conservar || archivo.mtime >= limite) return;
    fs.rmSync(archivo.ruta, { force: true });
    eliminados.push(archivo.nombre);
  });
  return eliminados;
}

// Copia a otra ruta montada (USB, NAS, segundo disco) y verifica la copia.
export function copiarFuera(ruta, destinoDir) {
  if (!destinoDir) return null;
  fs.mkdirSync(destinoDir, { recursive: true });
  const destino = path.join(destinoDir, path.basename(ruta));
  fs.copyFileSync(ruta, destino);
  verificarIntegridad(destino);
  return destino;
}

function partirS3(uri) {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(uri);
  if (!m) throw new Error("LC_BACKUP_S3_URI debe tener la forma s3://bucket/prefijo/");
  return { bucket: m[1], prefijo: m[2] };
}

// Sube con el SDK de AWS, que también sirve para R2 y otros S3 compatibles. Se
// usa el SDK (no la CLI) para que el respaldo programado funcione en Railway
// sin instalar awscli en la imagen.
export async function subirAS3(ruta, uri, {
  endpoint = process.env.LC_BACKUP_S3_ENDPOINT,
  region = process.env.LC_BACKUP_S3_REGION,
  forcePathStyle = process.env.LC_BACKUP_S3_FORCE_PATH_STYLE === "1",
  cliente
} = {}) {
  if (!uri) return null;

  const { bucket, prefijo } = partirS3(uri);
  const nombre = path.basename(ruta);
  const clave = prefijo && !prefijo.endsWith("/") ? `${prefijo}/${nombre}` : `${prefijo}${nombre}`;
  const destino = `s3://${bucket}/${clave}`;

  const s3 = cliente || new S3Client({
    region: region || (endpoint ? "auto" : process.env.AWS_REGION || "us-east-1"),
    ...(endpoint ? { endpoint, forcePathStyle } : {})
  });

  const sha256 = createHash("sha256").update(fs.readFileSync(ruta)).digest("hex");
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: clave,
    Body: fs.createReadStream(ruta),
    ContentLength: fs.statSync(ruta).size,
    ContentType: "application/vnd.sqlite3",
    Metadata: { sha256 }
  }));
  return destino;
}

// Ejecuta un respaldo completo. Devuelve las rutas generadas o lanza el error
// para que el llamador decida (CLI: código 1; programador: registrar y seguir).
export async function ejecutarRespaldo({ env = process.env, logger = console } = {}) {
  const dirSalida = directorioRespaldo(env);
  const dias = numeroEnv("LC_BACKUP_RETENCION_DIAS", 30, 1, env);
  const conservar = numeroEnv("LC_BACKUP_CONSERVAR", 7, 1, env);
  const copiarA = env.LC_BACKUP_COPIAR_A ? path.resolve(env.LC_BACKUP_COPIAR_A) : "";
  const s3Uri = env.LC_BACKUP_S3_URI || "";
  const s3Endpoint = env.LC_BACKUP_S3_ENDPOINT || "";
  const s3Region = env.LC_BACKUP_S3_REGION || "";

  const copia = crearInstantanea(rutaBase(env), dirSalida);
  verificarIntegridad(copia);
  logger.log(`  Instantánea: ${copia}`);

  const externa = copiarFuera(copia, copiarA);
  if (externa) logger.log(`  Copia local externa: ${externa}`);

  const subida = await subirAS3(copia, s3Uri, { endpoint: s3Endpoint, region: s3Region });
  if (subida) logger.log(`  Copia en S3/R2: ${subida}`);

  let eliminados = [];
  if (!externa && !subida) {
    logger.warn(
      "  AVISO: no hay destino externo configurado. La copia vive en el mismo " +
      "volumen que la base y no protege contra la pérdida del servidor."
    );
  } else {
    eliminados = podarRespaldos(dirSalida, { dias, conservar });
    logger.log(`  Retención: ${eliminados.length} copia(s) local(es) eliminada(s).`);
  }

  logger.log("  Respaldo completado.");
  return { copia, externa, subida, eliminados };
}

// Fecha y hora en una zona IANA, sin depender de la zona del contenedor.
export function horaEnZona(fecha, zona = "America/Santiago") {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: zona,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(fecha);
  const v = Object.fromEntries(partes.map((p) => [p.type, p.value]));
  return { fecha: `${v.year}-${v.month}-${v.day}`, hora: `${v.hour}:${v.minute}` };
}

// ¿Toca respaldar? Se dispara al pasar la hora objetivo y no se repite el
// mismo día. Si el proceso arranca después de la hora, recupera la copia
// perdida en la primera revisión.
export function debeEjecutarRespaldo(ahora, ultimaFecha, {
  hora = "02:15",
  zona = "America/Santiago"
} = {}) {
  const objetivo = /^([01]\d|2[0-3]):[0-5]\d$/.test(hora) ? hora : "02:15";
  const local = horaEnZona(ahora, zona);
  return local.hora >= objetivo && local.fecha !== ultimaFecha;
}

function archivoMarca(dir) {
  return path.join(dir, ".ultimo-respaldo");
}

function archivoIntento(dir) {
  return path.join(dir, ".ultimo-intento");
}

export function leerUltimaFecha(dir) {
  try {
    return fs.readFileSync(archivoMarca(dir), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function guardarUltimaFecha(dir, fecha) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(archivoMarca(dir), `${fecha}\n`, "utf8");
}

export function leerUltimoIntento(dir) {
  try {
    return fs.readFileSync(archivoIntento(dir), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function guardarUltimoIntento(dir, fecha) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(archivoIntento(dir), `${fecha}\n`, "utf8");
}

// Programa el respaldo dentro del propio servidor. Solo se activa si hay un
// destino externo y LC_BACKUP_AUTO=1; así un despliegue de desarrollo no
// empieza a generar copias sin querer.
export function iniciarRespaldoProgramado({
  env = process.env,
  logger = console,
  intervaloMs = 5 * 60 * 1000
} = {}) {
  if (env.LC_BACKUP_AUTO !== "1") return null;
  if (!env.LC_BACKUP_S3_URI && !env.LC_BACKUP_COPIAR_A) {
    logger.warn(
      "LC_BACKUP_AUTO=1 pero no hay LC_BACKUP_S3_URI ni LC_BACKUP_COPIAR_A: " +
      "no se programa el respaldo."
    );
    return null;
  }

  const hora = env.LC_BACKUP_HORA || "02:15";
  const zona = env.LC_BACKUP_TZ || "America/Santiago";
  const dir = directorioRespaldo(env);
  let ejecutando = false;

  const revisar = async () => {
    if (ejecutando) return;
    ejecutando = true;
    let fechaIntento = null;
    try {
      const ahora = new Date();
      if (!debeEjecutarRespaldo(ahora, leerUltimaFecha(dir), { hora, zona })) return;

      const local = horaEnZona(ahora, zona);
      fechaIntento = local.fecha;
      // Un fallo se registra para no repetir la subida cada 5 minutos durante
      // todo el día; el siguiente intento será al día siguiente o manual.
      if (leerUltimoIntento(dir) === local.fecha) return;

      logger.log(`Respaldo programado (${local.fecha} ${local.hora} ${zona})...`);
      const r = await ejecutarRespaldo({ env, logger });
      if (r.subida || r.externa) {
        guardarUltimaFecha(dir, local.fecha);
        fs.rmSync(archivoIntento(dir), { force: true });
      }
    } catch (err) {
      if (fechaIntento) guardarUltimoIntento(dir, fechaIntento);
      logger.error(
        `Fallo el respaldo programado: ${err?.message || err}. ` +
        "No se reintenta hasta mañana; ejecuta `npm run respaldo` para forzarlo."
      );
    } finally {
      ejecutando = false;
    }
  };

  const temporizador = setInterval(revisar, intervaloMs);
  temporizador.unref?.();
  // Revisión inmediata (fuera del arranque): recupera el respaldo si el proceso
  // estuvo caído a la hora objetivo. La marca evita repetirlo el mismo día.
  const inicial = setImmediate(revisar);
  inicial.unref?.();
  return temporizador;
}

async function ejecutar() {
  try {
    await ejecutarRespaldo();
    return 0;
  } catch (err) {
    console.error(`  ERROR de respaldo: ${err?.message || err}`);
    return 1;
  }
}

const ejecutadoDirectamente = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (ejecutadoDirectamente) {
  process.exit(await ejecutar());
}
