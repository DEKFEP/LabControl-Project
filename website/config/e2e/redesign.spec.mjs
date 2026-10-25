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

test("los iconos tienen nombre accesible y tooltip con ratón y teclado", async ({ page }) => {
  await entrar(page);
  const enlace = page.getByRole("link", { name: "Disponibilidad", exact: true });
  await expect(enlace.locator(".label")).toBeHidden();
  await enlace.hover();
  expect(await enlace.evaluate(el => getComputedStyle(el, "::after").opacity)).toBe("1");
  await page.mouse.move(500, 500);
  await enlace.focus();
  expect(await enlace.evaluate(el => getComputedStyle(el, "::after").content)).toBe('"Disponibilidad"');
  expect(await enlace.evaluate(el => getComputedStyle(el, "::after").opacity)).toBe("1");
  await expect(page.locator('#sidebar-nav a[href="configuracion.html"]')).toHaveCount(0);
});

test("perfil muestra datos y cierra con Escape, fuera y al abrir notificaciones", async ({ page }) => {
  await entrar(page);
  const boton = page.getByRole("button", { name: "Perfil de usuario", exact: true });
  const tarjeta = page.locator(".user-profile-card");
  await boton.click();
  await expect(tarjeta).toContainText("Administrador Sistema");
  await expect(tarjeta).toContainText("admin@liceo.cl");
  await expect(tarjeta).toContainText("Usuario: INSUCO");
  await expect(tarjeta.getByRole("link", { name: "Configuración", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(tarjeta).toBeHidden();
  await expect(boton).toBeFocused();
  await boton.click();
  await page.locator("h1").click();
  await expect(tarjeta).toBeHidden();
  await boton.click();
  await page.locator(".notif-btn").click();
  await expect(tarjeta).toBeHidden();
  await expect(page.locator(".notif-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".notif-panel")).toBeHidden();
  await expect(page.locator(".notif-btn")).toBeFocused();
});

test("Ayuda desde el perfil conserva FAQ, términos y Acerca de y se puede reabrir", async ({ page }) => {
  const errores = [];
  page.on("pageerror", e => errores.push(e.message));
  await entrar(page);
  await page.locator(".user-avatar-btn").click();
  await page.getByRole("link", { name: "Ayuda y Soporte" }).click();
  const modal = page.locator("#modal-ayuda");
  await expect(modal).toBeVisible();
  await expect(page.locator("#btn-ayuda, #cfg-ayuda-menu")).toHaveCount(0);
  await modal.getByRole("button", { name: "Términos y condiciones" }).click();
  await expect(modal.locator("#modal-ayuda-titulo")).toHaveText("Términos y condiciones");
  await modal.getByRole("button", { name: "Acerca de", exact: true }).click();
  await expect(modal).toContainText("Versión del sistema");
  await modal.locator(".modal__close").click();
  await page.locator(".user-avatar-btn").click();
  await page.getByRole("link", { name: "Ayuda y Soporte" }).click();
  await expect(modal).toBeVisible();
  await expect(modal.locator("#modal-ayuda-titulo")).toHaveText("Ayuda / FAQ");
  expect(errores).toEqual([]);
});

test("foto local del perfil persiste al recargar y cerrar sesión funciona", async ({ page }) => {
  await entrar(page);
  await page.locator(".user-avatar-btn").click();
  await page.locator("#profile-photo").setInputFiles({
    name: "perfil.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1kAAAAASUVORK5CYII=", "base64")
  });
  await expect(page.locator(".user-avatar-btn img")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
  await page.reload();
  await expect(page.locator(".user-avatar-btn img")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
  await page.locator(".user-avatar-btn").click();
  await page.getByRole("button", { name: "Cerrar Sesión", exact: true }).click();
  await expect(page).toHaveURL(/login\.html/);
});

test("perfil móvil cabe en pantalla y se cierra al plegar el menú", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await entrar(page);
  await page.locator(".sidebar__toggle").click();
  await page.locator(".user-avatar-btn").click();
  const tarjeta = page.locator(".user-profile-card");
  await expect(tarjeta).toBeVisible();
  const caja = await tarjeta.boundingBox();
  expect(caja.x).toBeGreaterThanOrEqual(0);
  expect(caja.x + caja.width).toBeLessThanOrEqual(390);
  expect(caja.y + caja.height).toBeLessThanOrEqual(844);
  await page.locator(".sidebar__toggle").click();
  await expect(tarjeta).toBeHidden();
});
