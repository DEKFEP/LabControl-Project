import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";

// Aquí se importa el servidor con un tope de escritura muy bajo para comprobar
// que las lecturas (el sondeo) no consumen esa cuota. Cada archivo de Jest tiene
// su propio registro de módulos, así que no compite con api.test.js.
let app, dir;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lc-limites-"));
  process.env.LC_DB_DIR = dir;
  process.env.LC_SEED_DEMO = "1";
  process.env.LC_API_LIMIT = "100000";
  process.env.LC_LOGIN_LIMIT = "100000";
  process.env.LC_REGISTRO_LIMIT = "100000";
  process.env.LC_ESCRITURA_LIMIT = "2";
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

test("el límite de escritura no cuenta las lecturas (sondeo de notificaciones)", async () => {
  const login = await request(app).post("/api/login").send({ usuario: "INSUCO", password: "Insuco1336" });
  const token = login.body.token;

  // Varias lecturas a una ruta con límite de escritura no consumen la cuota.
  for (let i = 0; i < 5; i++) {
    const r = await request(app).get("/api/notificaciones").set("Authorization", `Bearer ${token}`);
    expect(r.status).toBe(200);
  }

  // Las escrituras sí cuentan: con el tope en 2, a la tercera llega el 429.
  let ultimo = null;
  for (let i = 0; i < 4; i++) {
    ultimo = await request(app)
      .patch("/api/laboratorios/1")
      .set("Authorization", `Bearer ${token}`)
      .send({ estado: "disponible" });
    if (ultimo.status === 429) break;
  }
  expect(ultimo.status).toBe(429);
});
