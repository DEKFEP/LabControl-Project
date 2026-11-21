import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  crearInstantanea,
  verificarIntegridad,
  podarRespaldos,
  copiarFuera,
  ejecutarRespaldo,
  subirAS3,
  horaEnZona,
  debeEjecutarRespaldo,
  leerUltimaFecha,
  leerUltimoIntento,
  iniciarRespaldoProgramado
} from "../scripts/respaldo-externo.mjs";

let dir;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lc-respaldo-"));
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function crearBase(ruta) {
  const db = new DatabaseSync(ruta);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS prueba (id INTEGER PRIMARY KEY, valor TEXT)");
    db.prepare("INSERT INTO prueba (valor) VALUES (?)").run("dato-real");
  } finally {
    db.close();
  }
}

test("crearInstantanea copia los datos y la copia pasa integrity_check", () => {
  const rutaDb = path.join(dir, "labcontrol.db");
  crearBase(rutaDb);

  const copia = crearInstantanea(rutaDb, path.join(dir, "backups"));
  expect(fs.existsSync(copia)).toBe(true);
  expect(verificarIntegridad(copia)).toBe("ok");

  const db = new DatabaseSync(copia);
  try {
    expect(db.prepare("SELECT valor FROM prueba").get().valor).toBe("dato-real");
  } finally {
    db.close();
  }
});

test("crearInstantanea falla si la base no existe", () => {
  expect(() => crearInstantanea(path.join(dir, "no-existe.db"), path.join(dir, "backups")))
    .toThrow(/No existe la base de datos/);
});

test("podarRespaldos borra las copias antiguas y conserva las recientes", () => {
  const destino = path.join(dir, "retencion");
  fs.mkdirSync(destino, { recursive: true });
  const viejo = path.join(destino, "labcontrol-viejo.db");
  const nuevo = path.join(destino, "labcontrol-nuevo.db");
  fs.writeFileSync(viejo, "copia");
  fs.writeFileSync(nuevo, "copia");

  const ahora = Date.now();
  const hace40Dias = new Date(ahora - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(viejo, hace40Dias, hace40Dias);

  const eliminados = podarRespaldos(destino, { dias: 30, conservar: 1, ahora });
  expect(eliminados).toEqual(["labcontrol-viejo.db"]);
  expect(fs.existsSync(viejo)).toBe(false);
  expect(fs.existsSync(nuevo)).toBe(true);
});

test("podarRespaldos nunca borra las últimas copias aunque superen la retención", () => {
  const destino = path.join(dir, "retencion-minima");
  fs.mkdirSync(destino, { recursive: true });
  const nombres = ["labcontrol-a.db", "labcontrol-b.db", "labcontrol-c.db"];
  const ahora = Date.now();
  const hace60Dias = new Date(ahora - 60 * 24 * 60 * 60 * 1000);

  for (const nombre of nombres) {
    const ruta = path.join(destino, nombre);
    fs.writeFileSync(ruta, "copia");
    fs.utimesSync(ruta, hace60Dias, hace60Dias);
  }
  // Orden explícito: a (más reciente), b (reciente) y c (antigua).
  fs.utimesSync(path.join(destino, "labcontrol-a.db"), new Date(ahora), new Date(ahora));
  fs.utimesSync(path.join(destino, "labcontrol-b.db"), new Date(ahora - 1000), new Date(ahora - 1000));

  const eliminados = podarRespaldos(destino, { dias: 30, conservar: 2, ahora });
  expect(eliminados).toEqual(["labcontrol-c.db"]);
  expect(fs.existsSync(path.join(destino, "labcontrol-a.db"))).toBe(true);
  expect(fs.existsSync(path.join(destino, "labcontrol-b.db"))).toBe(true);
});

test("podarRespaldos ignora archivos que no genera el script", () => {
  const destino = path.join(dir, "retencion-ajenos");
  fs.mkdirSync(destino, { recursive: true });
  const ajeno = path.join(destino, "labcontrol.db");
  fs.writeFileSync(ajeno, "base");
  const ahora = Date.now();
  const hace60Dias = new Date(ahora - 60 * 24 * 60 * 60 * 1000);
  fs.utimesSync(ajeno, hace60Dias, hace60Dias);

  expect(podarRespaldos(destino, { dias: 1, conservar: 1, ahora })).toEqual([]);
  expect(fs.existsSync(ajeno)).toBe(true);
});

test("copiarFuera replica la instantánea y verifica la copia", () => {
  const rutaDb = path.join(dir, "labcontrol.db");
  crearBase(rutaDb);
  const copia = crearInstantanea(rutaDb, path.join(dir, "backups"));

  const destino = path.join(dir, "externo");
  const externa = copiarFuera(copia, destino);
  expect(externa).toBe(path.join(destino, path.basename(copia)));
  expect(fs.existsSync(externa)).toBe(true);
  expect(verificarIntegridad(externa)).toBe("ok");
});

test("ejecutarRespaldo crea la instantánea y la copia local externa", async () => {
  const base = path.join(dir, "completo");
  fs.mkdirSync(base, { recursive: true });
  crearBase(path.join(base, "labcontrol.db"));

  const salida = path.join(base, "backups");
  const externo = path.join(base, "externo");
  const silencio = { log() {}, warn() {}, error() {} };

  const r = await ejecutarRespaldo({
    env: {
      LC_DB_DIR: base,
      LC_BACKUP_DIR: salida,
      LC_BACKUP_COPIAR_A: externo,
      LC_BACKUP_RETENCION_DIAS: "30",
      LC_BACKUP_CONSERVAR: "7"
    },
    logger: silencio
  });

  expect(fs.existsSync(r.copia)).toBe(true);
  expect(r.externa).toBe(path.join(externo, path.basename(r.copia)));
  expect(fs.existsSync(r.externa)).toBe(true);
  expect(r.subida).toBeNull();
  expect(verificarIntegridad(r.copia)).toBe("ok");
  expect(verificarIntegridad(r.externa)).toBe("ok");
});

test("subirAS3 arma la clave, el hash y el destino sin tocar la red", async () => {
  const archivo = path.join(dir, "subida.db");
  fs.writeFileSync(archivo, "contenido-de-prueba");
  const capturado = [];
  const cliente = {
    async send(comando) {
      capturado.push(comando.input);
      return {};
    }
  };

  const destino = await subirAS3(archivo, "s3://labcontrol-backups/labcontrol/", {
    cliente,
    endpoint: "https://cuenta.r2.cloudflarestorage.com",
    region: "auto"
  });

  expect(destino).toBe("s3://labcontrol-backups/labcontrol/subida.db");
  expect(capturado).toHaveLength(1);
  expect(capturado[0].Bucket).toBe("labcontrol-backups");
  expect(capturado[0].Key).toBe("labcontrol/subida.db");
  expect(capturado[0].ContentLength).toBe(fs.statSync(archivo).size);
  expect(capturado[0].Metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
  // El SDK real consume el stream; el cliente falso debe hacerlo también para
  // que el descriptor se cierre antes de borrar el directorio temporal.
  await new Promise((resolve, reject) => {
    capturado[0].Body.on("data", () => {});
    capturado[0].Body.on("end", resolve);
    capturado[0].Body.on("error", reject);
  });
});

test("horaEnZona respeta el horario de Chile en invierno y verano", () => {
  expect(horaEnZona(new Date("2026-01-15T05:15:00Z"), "America/Santiago"))
    .toEqual({ fecha: "2026-01-15", hora: "02:15" });
  expect(horaEnZona(new Date("2026-07-15T06:15:00Z"), "America/Santiago"))
    .toEqual({ fecha: "2026-07-15", hora: "02:15" });
});

test("debeEjecutarRespaldo dispara una vez al día después de la hora objetivo", () => {
  const opciones = { hora: "02:15", zona: "America/Santiago" };

  expect(debeEjecutarRespaldo(new Date("2026-01-15T05:14:00Z"), "2026-01-14", opciones)).toBe(false);
  expect(debeEjecutarRespaldo(new Date("2026-01-15T05:15:00Z"), "2026-01-14", opciones)).toBe(true);
  expect(debeEjecutarRespaldo(new Date("2026-01-15T05:15:00Z"), "2026-01-15", opciones)).toBe(false);
  // Si el proceso arranca después de la hora, recupera el respaldo perdido.
  expect(debeEjecutarRespaldo(new Date("2026-01-15T12:00:00Z"), "2026-01-14", opciones)).toBe(true);
});

test("leerUltimaFecha devuelve la marca diaria o null", () => {
  const destino = path.join(dir, "marca");
  expect(leerUltimaFecha(destino)).toBeNull();
  fs.mkdirSync(destino, { recursive: true });
  fs.writeFileSync(path.join(destino, ".ultimo-respaldo"), "2026-11-06\n");
  expect(leerUltimaFecha(destino)).toBe("2026-11-06");
  expect(leerUltimoIntento(destino)).toBeNull();
  fs.writeFileSync(path.join(destino, ".ultimo-intento"), "2026-11-07\n");
  expect(leerUltimoIntento(destino)).toBe("2026-11-07");
});

test("iniciarRespaldoProgramado no arranca sin activación o sin destino", () => {
  const silencio = { log() {}, warn() {}, error() {} };
  expect(iniciarRespaldoProgramado({ env: {}, logger: silencio })).toBeNull();
  expect(iniciarRespaldoProgramado({
    env: { LC_BACKUP_AUTO: "1" },
    logger: silencio
  })).toBeNull();
});
