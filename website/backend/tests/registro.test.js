import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";

// El registro público nace cerrado: este archivo importa el servidor SIN
// LC_REGISTRO_DOMINIOS (cada archivo de Jest tiene su propio registro de
// módulos, así que el valor no lo pisa la suite de api.test.js).
let app, dir;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lc-registro-"));
  process.env.LC_DB_DIR = dir;
  process.env.LC_SEED_DEMO = "1";
  process.env.LC_API_LIMIT = "100000";
  process.env.LC_ESCRITURA_LIMIT = "100000";
  process.env.LC_REGISTRO_LIMIT = "100000";
  delete process.env.LC_REGISTRO_DOMINIOS;
  app = (await import("../server.js")).app;
});

afterAll(async () => {
  try {
    (await import("../db.js")).db.close();
  } catch {
    // Ya estaba cerrado.
  }
  if (dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows puede mantener el archivo de SQLite abierto hasta el cierre.
    }
  }
});

test("registro público: cerrado cuando no hay LC_REGISTRO_DOMINIOS", async () => {
  const res = await request(app)
    .post("/api/registro")
    .send({ id: "prof_cerrado", nombre: "Cerrado", apellido: "Test", email: "cerrado@liceo.cl", password: "Clave12345" });
  expect(res.status).toBe(403);
  expect(res.body.error).toMatch(/cerrado/i);
});
