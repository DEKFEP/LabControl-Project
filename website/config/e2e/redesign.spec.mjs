import { test, expect } from "@playwright/test";

async function entrar(page) {
  await page.goto("/login.html");
  await page.fill("#input-user", process.env.LC_E2E_ADMIN_USER || "INSUCO");
  await page.fill("#input-pass", process.env.LC_E2E_ADMIN_PASS || "Insuco1336");
  await page.click("#btn-login-enviar");
  await page.waitForURL("**/index.html");
}

test("inicio conserva los laboratorios y abre el listado completo desde Ver más", async ({ page, request }) => {
  const errores = [];
  page.on("pageerror", e => errores.push(e.message));
  await entrar(page);
  await expect(page.locator("#labs-home .lab-card")).toHaveCount(5);
  await expect(page.locator("#status-list, #donut")).toHaveCount(0);
  await expect(page.locator('#sidebar-nav a[href="laboratorios.html"], #sidebar-nav a[href="mapa.html"], #sidebar-nav a[href="usuarios.html"]')).toHaveCount(0);
  await page.getByRole("link", { name: "Ver más" }).click();
  await expect(page).toHaveURL(/laboratorios\.html/);
  await expect(page.locator("#lab-grid .lab-card")).toHaveCount(5);
  expect((await request.get("/mapa.html")).status()).toBe(404);
  expect(errores).toEqual([]);
});

test("disponibilidad conserva la tabla y las reservas sin tarjetas de resumen", async ({ page }) => {
  await entrar(page);
  await page.getByRole("link", { name: "Disponibilidad", exact: true }).click();
  await expect(page.locator("#disp-stats")).toHaveCount(0);
  await expect(page.locator("#tabla-disponibilidad tr")).toHaveCount(5);
  await page.locator("#btn-nueva-reserva").click();
  await expect(page.locator("#modal-reserva")).toBeVisible();
});

test("la campana está dentro de la sidebar y su panel cabe en escritorio", async ({ page }) => {
  await entrar(page);
  const sidebar = await page.locator(".sidebar").boundingBox();
  const boton = await page.locator(".notif-btn").boundingBox();
  expect(boton.x).toBeGreaterThanOrEqual(sidebar.x);
  expect(boton.x + boton.width).toBeLessThanOrEqual(sidebar.x + sidebar.width);
  await page.locator(".notif-btn").click();
  await expect(page.locator(".notif-panel")).toBeVisible();
  const panel = await page.locator(".notif-panel").boundingBox();
  expect(panel.x).toBeGreaterThanOrEqual(sidebar.width);
  expect(panel.y).toBeGreaterThanOrEqual(0);
  expect(panel.y + panel.height).toBeLessThanOrEqual(800);
});

test("el menú móvil mantiene accesibles la navegación y las notificaciones", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await entrar(page);
  await page.locator(".sidebar__toggle").click();
  await expect(page.getByRole("link", { name: "Disponibilidad", exact: true })).toBeVisible();
  await page.locator(".notif-btn").click();
  await expect(page.locator(".notif-panel")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
