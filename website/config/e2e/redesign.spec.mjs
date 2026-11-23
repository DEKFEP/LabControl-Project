import { test, expect } from "@playwright/test";

async function entrar(page) {
  await page.goto("/login");
  await page.fill("#input-user", process.env.LC_E2E_ADMIN_USER || "INSUCO");
  await page.fill("#input-pass", process.env.LC_E2E_ADMIN_PASS || "Insuco1336");
  await page.click("#btn-login-enviar");
  await page.waitForURL("**/index");
}

test("inicio conserva los laboratorios y abre el listado completo desde Ver más", async ({ page, request }) => {
  const errores = [];
  page.on("pageerror", e => errores.push(e.message));
  await entrar(page);
  await expect(page.locator("#labs-home .lab-card")).toHaveCount(5);
  await expect(page.locator("#status-list, #donut")).toHaveCount(0);
  await expect(page.locator('#sidebar-nav a[href="laboratorios"], #sidebar-nav a[href="mapa"], #sidebar-nav a[href="usuarios"]')).toHaveCount(0);
  await page.getByRole("link", { name: "Ver más" }).click();
  await expect(page).toHaveURL(/laboratorios(?:\?|$)/);
  await expect(page.locator("#lab-grid .lab-card")).toHaveCount(5);
  expect((await request.get("/mapa")).status()).toBe(404);
  expect(errores).toEqual([]);
});

test("disponibilidad conserva la tabla y las reservas con indicadores actuales", async ({ page }) => {
  await entrar(page);
  await page.getByRole("link", { name: "Disponibilidad", exact: true }).click();
  await expect(page.locator("#disp-stats dd").first()).toHaveText("5");
  await expect(page.locator("#tabla-disponibilidad tr")).toHaveCount(5);
  await page.locator("#btn-nueva-reserva").click();
  await expect(page.locator("#modal-reserva")).toBeVisible();
});

test("la campana está dentro de la sidebar y su panel cabe en escritorio", async ({ page }) => {
  await entrar(page);
  const sidebar = await page.locator(".sidebar").boundingBox();
  const boton = await page.locator(".notif-btn").boundingBox();
  const reportes = await page.getByRole("link", { name: "Reportes", exact: true }).boundingBox();
  expect(sidebar.width).toBeLessThan(76);
  expect(boton.y).toBeGreaterThanOrEqual(reportes.y + reportes.height);
  expect(await page.locator(".notif-wrap").evaluate(el => parseFloat(getComputedStyle(el).borderTopWidth))).toBeGreaterThan(0);
  expect(await page.locator(".notif-btn").evaluate(el => ({ borde: getComputedStyle(el).borderWidth, fondo: getComputedStyle(el).backgroundColor }))).toEqual({ borde: "0px", fondo: "rgba(0, 0, 0, 0)" });
  expect(boton.x).toBeGreaterThanOrEqual(sidebar.x);
  expect(boton.x + boton.width).toBeLessThanOrEqual(sidebar.x + sidebar.width);
  await page.locator(".notif-btn").click();
  await expect(page.locator(".notif-panel")).toBeVisible();
  const panel = await page.locator(".notif-panel").boundingBox();
  expect(panel.x).toBeGreaterThanOrEqual(sidebar.width);
  expect(panel.y).toBeGreaterThanOrEqual(0);
  expect(panel.y + panel.height).toBeLessThanOrEqual(800);
});

test("la barra móvil mantiene accesibles la navegación y las notificaciones", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await entrar(page);
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
  await expect(page.locator('#sidebar-nav a[href="configuracion"]')).toHaveCount(0);
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
  await expect(page).toHaveURL(/login(?:\?|$)/);
});

test("el perfil conserva la tarjeta en PC y abre Configuración en celular", async ({ page }) => {
  await entrar(page);
  await page.locator(".user-avatar-btn").click();
  const tarjeta = page.locator(".user-profile-card");
  await expect(tarjeta).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(tarjeta).toBeHidden();
  await expect(page.locator(".user-avatar-btn")).not.toHaveAttribute("aria-haspopup", "dialog");
  await page.locator(".user-avatar-btn").click();
  await expect(page).toHaveURL(/configuracion(?:\?|$)/);
  await expect(page.locator("#panel-perfil")).toBeVisible();
  await expect(page.locator("#btn-ayuda-movil")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator("#btn-ayuda-movil")).toBeHidden();
  await expect(page.locator("#btn-cerrar-sesion-perfil")).toBeHidden();
  await page.locator(".user-avatar-btn").click();
  await expect(page.locator(".user-profile-card")).toBeVisible();
});

test("paleta verde, cabecera de LabControl y superficies verificadas en todas las vistas", async ({ page }, testInfo) => {
  test.setTimeout(90000);
  const errores = [];
  page.on("pageerror", e => errores.push(e.message));
  await page.goto("/login");
  const acceso = await page.locator(".login-card").boundingBox();
  expect(Math.abs(acceso.x + acceso.width / 2 - 640)).toBeLessThan(2);
  await page.screenshot({ path: testInfo.outputPath("4.9.0-login.png"), fullPage: true, animations: "disabled" });
  await entrar(page);
  const vistas = [
    ["index", "#labs-home .lab-card", "inicio"],
    ["laboratorios", "#lab-grid .lab-card", "laboratorios"],
    ["disponibilidad", "#tabla-disponibilidad tr", "disponibilidad"],
    ["equipos", ".bloque-lab .equipo", "equipos"],
    ["reportes", ".rep-card", "reportes"],
    ["configuracion", "#panel-perfil", "configuracion"]
  ];
  for (const [url, selector, nombre] of vistas) {
    await page.goto(`/${url}`);
    await expect(page.locator(selector).first()).toBeVisible();
    await expect(page.locator('img[src*="logo-insuco"]')).toHaveCount(0);
    const marca = await page.locator(".app-brand a").boundingBox();
    expect(marca.x).toBeLessThan(30);
    expect(marca.y).toBeLessThan(20);
    const estilo = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      return ["--color-primary", "--color-bg", "--color-surface", "--color-text", "--radius"].map(v => css.getPropertyValue(v).trim().toUpperCase());
    });
    expect(estilo).toEqual(["#059669", "#EAF7F0", "#FFFFFF", "#18251F", "6PX"]);
    await page.screenshot({ path: testInfo.outputPath(`4.9.0-${nombre}.png`), fullPage: true, animations: "disabled" });
  }
  await page.locator(".user-avatar-btn").click();
  await page.screenshot({ path: testInfo.outputPath("4.9.0-perfil.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await page.evaluate(() => { localStorage.setItem("lc_tema", "oscuro"); });
  await page.goto("/index");
  await expect(page.locator("#labs-home .lab-card")).toHaveCount(5);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "oscuro");
  await page.screenshot({ path: testInfo.outputPath("4.9.0-oscuro.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("4.9.0-movil.png"), animations: "disabled" });
  await page.locator(".user-avatar-btn").click();
  await expect(page.locator("#panel-perfil")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("4.9.0-movil-perfil.png"), animations: "disabled" });
  await page.locator(".notif-btn").click();
  await page.screenshot({ path: testInfo.outputPath("4.9.0-movil-notificaciones.png"), animations: "disabled" });
  expect(errores).toEqual([]);
});

test("control centrado y retorno al sexto equipo de cada bloque consultado", async ({ page }) => {
  await entrar(page);
  await page.goto("/equipos");
  const bloques = page.locator(".bloque-lab");
  for (const indice of [2, 0, 4]) {
    const bloque = bloques.nth(indice);
    await expect(bloque.locator(".equipo")).toHaveCount(5);
    await bloque.getByText("Ver más equipos").click();
    const sexto = bloque.locator(".equipo").nth(5);
    const nombre = await sexto.locator("strong").innerText();
    const control = sexto.getByText("Controlar");
    await control.scrollIntoViewIfNeeded();
    const y = await page.evaluate(() => scrollY);
    await control.click();
    await expect(page.locator("#rem-nombre")).toHaveText("Control de " + nombre);
    const caja = await page.locator(".control-hoja").boundingBox();
    expect(Math.abs(caja.y + caja.height / 2 - 400)).toBeLessThan(2);
    expect(await page.evaluate(() => scrollY)).toBe(y);
    // Un arrastre que cruza el borde en cualquier dirección mantiene el diálogo.
    for (const [desde, hasta] of [[15, 640], [640, 15]]) {
      await page.mouse.move(desde, caja.y + 14);
      await page.mouse.down();
      await page.mouse.move(hasta, caja.y + 14);
      await page.mouse.up();
      await expect(page.locator("#seccion-remoto")).toBeVisible();
    }
    await page.mouse.click(15, 90);
    await expect(control).toBeFocused();
    expect(await page.evaluate(() => scrollY)).toBe(y);
    await bloque.locator(".equipo").nth(6).getByText("Controlar").click();
    await page.keyboard.press("Escape");
  }
});

for (const ancho of [360, 390, 430]) {
  test.describe(`inventario y disponibilidad a ${ancho}px`, () => {
    test.use({ viewport: {width: ancho, height: 780}, hasTouch: true });
    test("búsqueda, control táctil y formulario de reserva", async ({page}) => {
      await entrar(page);
      await page.goto("/equipos");
      const bloque = page.locator(".bloque-lab").first();
      await bloque.getByText("Ver más equipos").tap();
      const nombre = await bloque.locator(".equipo strong").nth(5).innerText();
      await page.reload();
      await page.selectOption("#filtro-lab", {index: 1});
      await page.fill("#filtro-busq-eq", nombre);
      const fila = page.locator(".equipo");
      await expect(fila).toHaveCount(1);
      const btn = fila.getByText("Controlar");
      const caja = await btn.boundingBox();
      expect(caja.x + caja.width).toBeLessThanOrEqual(ancho);
      await btn.tap();
      const hoja = page.locator(".control-hoja");
      const panel = await hoja.boundingBox();
      expect(panel.y + panel.height).toBeCloseTo(780, 0);
      const cmd = page.locator('.comandos button:enabled').first();
      await cmd.tap();
      await expect(page.locator("#remote-log")).toContainText("Apagado correcto");
      await page.getByText("Detalles técnicos").tap();
      await expect(page.locator("#tecnico")).toHaveAttribute("open", "");
      const client = await page.context().newCDPSession(page);
      const deslizar = async (x, y, delta) => {
        for (const [type, dy] of [["touchStart", 0], ["touchMove", delta / 2], ["touchMove", delta], ["touchEnd", 0]]) {
          await client.send("Input.dispatchTouchEvent", {type, touchPoints: type === "touchEnd" ? [] : [{x, y: y + dy}]});
        }
      };
      // Texto ampliado y espacio vertical reducido: desplazar los detalles
      // debe mover la hoja por dentro sin mover el inventario ni cerrarla.
      await page.setViewportSize({width: ancho, height: 500});
      await page.evaluate(() => { document.documentElement.style.fontSize = "24px"; });
      const fondoY = await page.evaluate(() => scrollY);
      await page.locator("#tecnico summary").scrollIntoViewIfNeeded();
      const detalles = await page.locator("#tecnico summary").boundingBox();
      const antes = await hoja.evaluate(el => el.scrollTop);
      await deslizar(110, detalles.y + 12, -100);
      await expect.poll(() => hoja.evaluate(el => el.scrollTop)).toBeGreaterThan(antes);
      await expect(hoja).toBeVisible();
      expect(await page.evaluate(() => scrollY)).toBe(fondoY);
      await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
      await page.setViewportSize({width: ancho, height: 780});
      await page.locator(".tirador").scrollIntoViewIfNeeded();
      const cabecera = page.locator("#control-cabecera");
      await cabecera.tap(); // Detiene la inercia del desplazamiento anterior.
      const punto = async () => {
        const rect = await cabecera.boundingBox();
        return {x: ancho / 2, y: rect.y + rect.height / 2};
      };
      const inicio = await punto();
      await client.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [inicio]});
      await client.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{x: inicio.x, y: inicio.y + 100}]});
      await client.send("Input.dispatchTouchEvent", {type: "touchCancel", touchPoints: []});
      await expect(hoja).toHaveCSS("transform", "none");
      const corto = await punto();
      await deslizar(corto.x, corto.y, 30);
      await expect(hoja).toBeVisible();
      const largo = await punto();
      await deslizar(largo.x, largo.y, 104);
      await expect(hoja).toBeHidden();
      await expect(btn).toBeFocused();
      await expect(page.locator("#filtro-busq-eq")).toHaveValue(nombre);
      await expect(fila.locator(".badge")).toHaveText("Apagado");
      await btn.tap();
      await page.touchscreen.tap(14, 100);
      await expect(hoja).toBeHidden();
      await btn.tap();
      await page.keyboard.press("Escape");
      await expect(btn).toBeFocused();

      await page.goto("/disponibilidad");
      const tarjeta = page.locator(".tarjeta").first();
      await tarjeta.getByText("Ver detalles").tap();
      await tarjeta.getByText("Cambiar estado").tap();
      const selector = page.locator("#select-nuevo-estado");
      const estado = await selector.inputValue() === "disponible" ? "ocupado" : "disponible";
      await selector.selectOption(estado);
      await page.click("#btn-guardar-estado");
      await expect(tarjeta.locator(".badge")).toHaveText(new RegExp(estado, "i"));
      await expect(tarjeta.getByText("Ocultar detalles")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(ancho);
      await page.click("#btn-nueva-reserva");
      const actividad = "Práctica " + ancho;
      await page.fill("#res-motivo", actividad);
      await page.fill("#res-fin", "07:00");
      await page.click("#btn-guardar-reserva");
      await expect(page.locator("#res-error")).toContainText("posterior");
      await expect(page.locator("#res-motivo")).toHaveValue(actividad);
      await page.fill("#res-fin", "09:00");
      await page.click("#btn-guardar-reserva");
      const reserva = page.locator(".reserva").filter({hasText: actividad});
      await expect(reserva).toBeVisible();
      await page.click('[data-modo="semana"]');
      await expect(reserva).toBeVisible();
      page.once("dialog", d => d.accept());
      await reserva.getByText("Cancelar").click();
      await expect(reserva).toHaveCount(0);
    });
  });
}

test("acciones de laboratorio confirman el alcance del apagado simulado", async ({page}) => {
  await entrar(page);
  await page.goto("/equipos");
  const bloques = page.locator(".bloque-lab");
  const lab = bloques.first();
  const nombre = await lab.locator("h3").innerText();
  const total = (await lab.locator("header p").innerText()).match(/(\d+) equipos/)[1];
  await lab.getByText("Acciones del laboratorio").click();
  const apagar = page.getByRole("button", {name: "Apagar todos los equipos"});
  for (const aceptar of [false, true]) {
    const espera = page.waitForEvent("dialog");
    const click = apagar.click();
    const confirmacion = await espera;
    expect(confirmacion.message()).toContain(nombre);
    expect(confirmacion.message()).toContain(total + " equipos");
    if (aceptar) await confirmacion.accept();
    else await confirmacion.dismiss();
    await click;
  }
  await expect(lab.locator(".equipo .badge").first()).toHaveText("Apagado");
  await expect(bloques.nth(1).locator(".equipo .badge").first()).toHaveText("Activo");
});
