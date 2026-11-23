import { AUTH, ESTADOS_EQUIPO, cargarEquipos, cargarLaboratorios } from "./data.js";
import { abrirModal, esc, getQueryParam, renderSidebar, showToast } from "./app.js";

await renderSidebar("equipos");
const $ = id => document.getElementById(id);
const control = $("seccion-remoto");
const permitido = AUTH.puedeControlRemoto();
const limites = new Map();
const resultados = new Map();
let laboratorios = [];
let equipos = [];
let seleccionado, origen, laboratorioAccion;

function estado(eq) {
  if (eq.estado === "bloqueado") return {label: "Bloqueado", clase: "badge--mantencion"};
  return ESTADOS_EQUIPO[eq.estado] ?? {label: eq.estado, clase: "badge--muted"};
}

function etiqueta(eq) {
  const {clase, label} = estado(eq);
  return `<span class="badge ${clase}">${esc(label)}</span>`;
}

function actualizarTotales() {
  const activos = equipos.filter(eq => eq.estado === "activo").length;
  $("total").textContent = equipos.length;
  $("activos").textContent = activos;
  $("otros").textContent = equipos.length - activos;
}

function fila(eq) {
  return `<li class="equipo"><div><div class="linea"><strong>${esc(eq.nombre)}</strong>${etiqueta(eq)}</div>
    <p>${esc(eq.tipo)} · ${esc(eq.so || "Sistema sin especificar")}</p></div>
    ${permitido ? `<button class="btn btn--sm" data-control="${esc(eq.id)}">Controlar</button>` : ""}</li>`;
}

function coincidencias(lista, lab, q) {
  return lista.filter(eq => [eq.nombre, eq.id, eq.tipo, lab.nombre].some(v => String(v).toLowerCase().includes(q)));
}

function busqueda() {
  return $("filtro-busq-eq").value.trim().toLowerCase();
}

function inventario() {
  const filtro = $("filtro-lab").value;
  const q = busqueda();
  const bloques = [];
  for (const lab of laboratorios) {
    if (filtro && filtro !== String(lab.id)) continue;
    const todos = equipos.filter(eq => eq.labId === lab.id);
    const encontrados = coincidencias(todos, lab, q);
    if (q && !encontrados.length) continue;
    const limite = limites.get(lab.id) ?? 5;
    bloques.push(`<article class="bloque-lab"><header><div><h3>${esc(lab.nombre)}</h3><p>${esc(lab.sala)} · ${todos.length} equipos</p></div>
      ${permitido ? `<button class="btn btn--sm" data-acciones="${esc(lab.id)}">Acciones del laboratorio</button>` : ""}</header>
      <ul>${encontrados.slice(0, limite).map(fila).join("")}</ul>
      ${encontrados.length > limite ? `<button class="ver-mas" data-mas="${esc(lab.id)}">Ver más equipos</button>` : ""}</article>`);
  }
  $("inventario").innerHTML = bloques.join("") || '<p class="vacio">Sin equipos que coincidan con la búsqueda.</p>';
}

function comandos(eq) {
  const encendido = ["activo", "bloqueado"].includes(eq.estado);
  return {encender: eq.estado === "apagado", apagar: encendido, reiniciar: encendido, bloquear: encendido, captura: encendido};
}

function actualizarPanel() {
  const eq = seleccionado;
  $("rem-badge").innerHTML = etiqueta(eq);
  const disponibles = comandos(eq);
  for (const btn of control.querySelectorAll("[data-cmd]")) {
    btn.disabled = !disponibles[btn.dataset.cmd];
    if (btn.dataset.cmd === "bloquear") btn.textContent = eq.estado === "bloqueado" ? "Desbloquear" : "Bloquear";
  }
  $("remote-log").textContent = resultados.get(eq.id) ?? `Sesión de control iniciada sobre ${eq.nombre}.`;
}

function abrirControl(btn) {
  seleccionado = equipos.find(eq => String(eq.id) === btn.dataset.control);
  if (!permitido || !seleccionado) return;
  origen = btn;
  const eq = seleccionado;
  $("rem-nombre").textContent = `Control de ${eq.nombre}`;
  $("rem-detalle").textContent = laboratorios.find(lab => lab.id === eq.labId)?.nombre;
  $("tecnico").open = false;
  $("tecnico").querySelector("dl").innerHTML = Object.entries({
    IP: eq.ip, MAC: eq.mac, Procesador: eq.procesador, Memoria: eq.ram, Almacenamiento: eq.almacenamiento
  }).map(([nombre, valor]) => `<div><dt>${nombre}</dt><dd>${esc(valor || "—")}</dd></div>`).join("");
  actualizarPanel();
  control.showModal();
  $("control-cabecera").parentElement.scrollTop = 0;
}

$("inventario").addEventListener("click", e => {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.hasAttribute("data-control")) return abrirControl(btn);
  if (btn.hasAttribute("data-mas")) {
    const id = Number(btn.dataset.mas);
    const lab = laboratorios.find(l => l.id === id);
    const encontrados = coincidencias(equipos.filter(eq => eq.labId === id), lab, busqueda());
    const desde = limites.get(id) ?? 5;
    const hasta = desde + 5;
    const lista = btn.closest(".bloque-lab").querySelector("ul");
    lista.insertAdjacentHTML("beforeend", encontrados.slice(desde, hasta).map(fila).join(""));
    limites.set(id, hasta);
    if (hasta >= encontrados.length) btn.remove();
    lista.children[desde]?.querySelector("button")?.focus({preventScroll: true});
  } else if (permitido && btn.hasAttribute("data-acciones")) {
    laboratorioAccion = laboratorios.find(lab => String(lab.id) === btn.dataset.acciones);
    $("acciones-detalle").textContent = `${laboratorioAccion.nombre} · ${laboratorioAccion.sala} · Control simulado`;
    abrirModal("acciones-lab");
  }
});

$("apagar-lab").onclick = () => {
  if (!permitido || !laboratorioAccion) return;
  const afectados = equipos.filter(eq => eq.labId === laboratorioAccion.id && comandos(eq).apagar);
  if (!confirm(`¿Apagar los ${afectados.length} equipos activos o bloqueados de ${laboratorioAccion.nombre}?`)) return;
  for (const eq of afectados) {
    eq.estado = "apagado";
    resultados.set(eq.id, `Apagado simulado de ${eq.nombre} completado.`);
  }
  $("acciones-lab").querySelector(".modal__close").click();
  actualizarTotales();
  inventario();
  showToast(`Apagado simulado de ${afectados.length} equipos.`);
};

control.querySelector(".comandos").onclick = e => {
  const cmd = e.target.closest("button")?.dataset.cmd;
  const eq = seleccionado;
  if (!permitido || !eq || !comandos(eq)[cmd]) return;
  const destino = {encender: "activo", apagar: "apagado", reiniciar: "activo", bloquear: eq.estado === "bloqueado" ? "activo" : "bloqueado"};
  const mensaje = {
    encender: "Encendido correcto", apagar: "Apagado correcto", reiniciar: "Reinicio en curso",
    bloquear: eq.estado === "bloqueado" ? "Pantalla desbloqueada" : "Pantalla bloqueada",
    captura: "Captura de pantalla obtenida (simulada)"
  };
  if (destino[cmd]) eq.estado = destino[cmd];
  resultados.set(eq.id, `[${new Date().toLocaleTimeString("es-CL")}] ${eq.nombre} · ${mensaje[cmd]}.`);
  origen.closest(".equipo").querySelector(".badge").outerHTML = etiqueta(eq);
  actualizarTotales();
  actualizarPanel();
};

$("salir-control").onclick = () => control.close();
let fondoInicio = false;
let fondoFin = false;
control.onpointerdown = e => { fondoInicio = e.target === control; fondoFin = false; };
control.onpointerup = e => { fondoFin = e.target === control && document.elementFromPoint(e.clientX, e.clientY) === control; };
control.onclick = e => {
  if (e.target === control && fondoInicio && fondoFin) control.close();
};
const cabecera = $("control-cabecera");
const hoja = cabecera.parentElement;
let gesto;
cabecera.onpointerdown = e => {
  if (!matchMedia("(max-width: 860px)").matches || !e.isPrimary || e.button !== 0) return;
  gesto = {id: e.pointerId, inicio: e.clientY};
  cabecera.setPointerCapture(e.pointerId);
};
cabecera.onpointermove = e => {
  if (gesto?.id === e.pointerId) hoja.style.transform = `translateY(${Math.max(0, e.clientY - gesto.inicio)}px)`;
};
// Mantener la capa hasta consumir el final del toque evita que el navegador
// sintetice un clic sobre la fila que aparece debajo de la hoja.
let cerrarPorGesto = false;
cabecera.onpointerup = e => {
  if (gesto?.id !== e.pointerId) return;
  cerrarPorGesto = e.clientY - gesto.inicio > 80;
  gesto = null;
  if (!cerrarPorGesto) hoja.style.transform = "";
};
cabecera.addEventListener("touchend", e => {
  if (!cerrarPorGesto) return;
  e.preventDefault();
  control.close();
}, {passive: false});
cabecera.onclick = e => {
  if (cerrarPorGesto) {
    e.stopPropagation();
    control.close();
  }
};
cabecera.onlostpointercapture = () => {
  gesto = null;
  if (!cerrarPorGesto) hoja.style.transform = "";
};
control.onkeydown = e => {
  if (e.key !== "Tab") return;
  const opciones = control.querySelectorAll("button:not(:disabled), summary");
  const primero = opciones[0];
  const ultimo = opciones[opciones.length - 1];
  if (e.shiftKey && [primero, $("rem-nombre")].includes(document.activeElement)) {
    e.preventDefault();
    ultimo.focus();
  } else if (!e.shiftKey && document.activeElement === ultimo) {
    e.preventDefault();
    primero.focus();
  }
};
control.onclose = () => {
  seleccionado = null;
  cerrarPorGesto = false;
  hoja.style.transform = "";
  origen?.focus({preventScroll: true});
};
for (const id of ["filtro-lab", "filtro-busq-eq"]) $(id).oninput = inventario;

try {
  [laboratorios, equipos] = await Promise.all([cargarLaboratorios(), cargarEquipos()]);
  $("filtro-lab").innerHTML = '<option value="">Todos los laboratorios</option>' + laboratorios.map(l => `<option value="${esc(l.id)}">${esc(l.nombre)}</option>`).join("");
  $("filtro-lab").value = getQueryParam("lab") || "";
  if (!permitido) $("aviso-sin-permiso").style.display = "flex";
  actualizarTotales();
  inventario();
} catch {
  showToast("No se pudieron cargar los equipos.", "error");
}
