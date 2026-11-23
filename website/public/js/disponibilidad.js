import { AUTH, ESTADOS, actualizarEstadoLaboratorio, cargarAgenda, cargarLaboratorios, cargarUsuarios, crearReserva, eliminarReserva } from "./data.js";
import { abrirModal, esc, renderSidebar, showToast } from "./app.js";

await renderSidebar("disponibilidad");
const $ = id => document.getElementById(id);
const sesion = AUTH.getSesion();
const fechaLocal = d => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
const fechaLarga = d => d.toLocaleDateString("es-CL", {weekday: "long", day: "numeric", month: "long", year: "numeric"});
const hoy = () => fechaLocal(new Date());
let labs = [], agenda = [], usuarios = [];
let labSeleccionado;
const escritorio = matchMedia("(min-width: 861px)");
let modo = escritorio.matches ? "semana" : "dia";
$("fecha-agenda").value = hoy();
$("fecha-hoy").textContent = fechaLarga(new Date());

function indicadores() {
  $("total").textContent = labs.length;
  $("disponibles").textContent = labs.filter(l => l.estado === "disponible").length;
  $("reservas-hoy").textContent = agenda.filter(r => r.fecha === hoy()).length;
}

function badge(lab) {
  return `<span class="badge badge--${esc(lab.estado)}" data-estado="${esc(lab.id)}">${esc(ESTADOS[lab.estado]?.label || lab.estado)}</span>`;
}
function cambiar(lab) {
  return sesion ? `<button class="btn btn--sm" data-lab-id="${esc(lab.id)}">Cambiar estado</button>` : "";
}
function renderLabs() {
  $("cuenta-labs").textContent = `${labs.length} laboratorios`;
  $("tabla-disponibilidad").innerHTML = labs.map(l => `<tr><td><div class="nombre-lab"><i data-lucide="building-2" aria-hidden="true"></i><strong>${esc(l.nombre)}</strong></div></td><td>${esc(l.sala)}</td><td>${esc(l.equipos)}</td><td>${badge(l)}</td>
    <td>${esc(l.horario)}</td><td>${esc(l.responsable)}</td><td><div class="linea">${cambiar(l)}<a class="btn btn--sm" href="laboratorios?id=${esc(l.id)}">Ver detalles</a></div></td></tr>`).join("");
  $("tarjetas-disponibilidad").innerHTML = labs.map(l => `<article class="tarjeta"><div class="linea"><h3>${esc(l.nombre)}</h3>${badge(l)}</div>
    <p>${esc(l.sala)} · ${esc(l.equipos)} equipos</p><details><summary><span>Ver detalles</span><span>Ocultar detalles</span></summary>
    <dl><div><dt>Horario</dt><dd>${esc(l.horario)}</dd></div><div><dt>Responsable</dt><dd>${esc(l.responsable)}</dd></div></dl>${cambiar(l)}</details></article>`).join("");
  $("res-lab").innerHTML = labs.map(l => `<option value="${esc(l.id)}">${esc(l.nombre)} · ${esc(l.sala)}</option>`).join("");
}

$("main-content").addEventListener("click", e => {
  const btn = e.target.closest("[data-lab-id]");
  if (!sesion || !btn) return;
  labSeleccionado = labs.find(l => String(l.id) === btn.dataset.labId);
  $("modal-estado-lab").textContent = `${labSeleccionado.nombre} · ${labSeleccionado.sala}`;
  $("select-nuevo-estado").value = labSeleccionado.estado;
  abrirModal("modal-estado", "#btn-cerrar-estado, #btn-cancelar-estado");
});
$("btn-guardar-estado").onclick = async e => {
  const lab = labSeleccionado;
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const actualizado = await actualizarEstadoLaboratorio(lab.id, $("select-nuevo-estado").value);
    lab.estado = actualizado.estado;
    document.querySelectorAll(`[data-estado="${lab.id}"]`).forEach(el => { el.outerHTML = badge(lab); });
    indicadores();
    if (lab === labSeleccionado && $("modal-estado").style.display !== "none") $("btn-cerrar-estado").click();
    showToast("Estado actualizado.");
  } catch (error) { showToast(error.message, "error"); }
  finally { btn.disabled = false; }
};

function puedeCancelar(r) {
  return sesion && (AUTH.esAdmin() || sesion.id === r.usuarioId);
}

function reserva(r) {
  const lab = labs.find(l => l.id === r.labId);
  const usuario = usuarios.find(u => u.id === r.usuarioId);
  return `<article class="reserva"><strong>${esc(r.horaInicio || "00:00")} – ${esc(r.horaFin || "23:59")}</strong>
    <div><h4>${esc(lab?.nombre)}</h4><p>${esc(r.motivo)}</p><small>${esc(usuario ? usuario.nombre + " " + usuario.apellido : r.usuarioId)} · ${esc(r.estado || "pendiente")}</small></div>
    ${puedeCancelar(r) ? `<button class="btn btn--sm" data-cancelar="${esc(r.id)}">Cancelar</button>` : ""}</article>`;
}

function fichaCalendario(r) {
  const clase = "semana-chip" + (r.estado === "pendiente" ? " semana-chip--pendiente" : "");
  const contenido = `${esc(r.horaInicio || "00:00")}–${esc(r.horaFin || "23:59")}<span>${esc(r.motivo)}</span>`;
  return puedeCancelar(r)
    ? `<button type="button" class="${clase}" data-cancelar="${esc(r.id)}" title="Cancelar reserva">${contenido}</button>`
    : `<div class="${clase} semana-chip--ajeno">${contenido}</div>`;
}

function calendario(dias) {
  const actual = hoy();
  const encabezados = dias.map(({dia, fecha}) => `<th scope="col" class="${fecha === actual ? "semana-th--hoy" : ""}">
    <span class="semana-dia">${dia.toLocaleDateString("es-CL", {weekday: "long"})}</span>
    <time class="semana-fecha" datetime="${fecha}">${dia.getDate()}</time></th>`);
  const filas = labs.map(lab => {
    const celdas = dias.map(({fecha, reservas}) => `<td class="${fecha === actual ? "semana-td--hoy" : ""}">
      ${reservas.filter(r => r.labId === lab.id).map(fichaCalendario).join("")}</td>`);
    return `<tr><th scope="row" class="semana-lab">${esc(lab.nombre)}</th>${celdas.join("")}</tr>`;
  });
  return `<div class="table-wrap"><table class="semana-tabla" aria-label="Reservas semanales por laboratorio">
    <thead><tr><th scope="col">Laboratorio</th>${encabezados.join("")}</tr></thead><tbody>${filas.join("")}</tbody></table></div>`;
}

function renderAgenda() {
  const dia = new Date(($("fecha-agenda").value || hoy()) + "T12:00:00");
  const semanal = modo === "semana";
  const mostrarCalendario = semanal && escritorio.matches;
  $("nav-semana").hidden = !mostrarCalendario;
  if (semanal) dia.setDate(dia.getDate() - (dia.getDay() + 6) % 7);
  const dias = [];
  for (let i = 0; i < (semanal ? 7 : 1); i++) {
    const fecha = fechaLocal(dia);
    const reservas = agenda.filter(r => r.fecha === fecha).sort((a,b) => (a.horaInicio || "").localeCompare(b.horaInicio || ""));
    dias.push({dia: new Date(dia), fecha, reservas});
    dia.setDate(dia.getDate() + 1);
  }
  if (mostrarCalendario) {
    const formato = new Intl.DateTimeFormat("es-CL", {day: "numeric", month: "short", year: "numeric"});
    $("semana-label").textContent = formato.formatRange(dias[0].dia, dias[6].dia);
    $("agenda").innerHTML = calendario(dias);
  } else {
    $("agenda").innerHTML = dias.map(({dia, reservas}) => `<section class="dia"><h3>${fechaLarga(dia)}</h3>${reservas.map(reserva).join("") || '<p class="vacio">Sin reservas para este día</p>'}</section>`).join("");
  }
  document.querySelectorAll("[data-modo]").forEach(btn => btn.setAttribute("aria-pressed", String(btn.dataset.modo === modo)));
}
escritorio.addEventListener("change", () => {
  modo = escritorio.matches ? "semana" : "dia";
  renderAgenda();
});
$("nav-semana").onclick = e => {
  const boton = e.target.closest("[data-semanas]");
  if (!boton) return;
  const fecha = new Date(($("fecha-agenda").value || hoy()) + "T12:00:00");
  fecha.setDate(fecha.getDate() + 7 * Number(boton.dataset.semanas));
  $("fecha-agenda").value = fechaLocal(fecha);
  renderAgenda();
};
document.querySelectorAll("[data-modo]").forEach(btn => { btn.onclick = () => { modo = btn.dataset.modo; renderAgenda(); }; });
$("fecha-agenda").onchange = () => { if (!$("fecha-agenda").value) $("fecha-agenda").value = hoy(); renderAgenda(); };
$("hoy").onclick = () => { $("fecha-agenda").value = hoy(); renderAgenda(); };
$("agenda").onclick = async e => {
  const id = e.target.closest("[data-cancelar]")?.dataset.cancelar;
  if (!id || !confirm("¿Cancelar esta reserva?")) return;
  try {
    await eliminarReserva(id);
    agenda = agenda.filter(r => r.id !== id);
    renderAgenda();
    indicadores();
    showToast("Reserva cancelada.");
  } catch (error) { showToast(error.message, "error"); }
};

$("btn-nueva-reserva").onclick = () => {
  $("res-error").textContent = "";
  $("res-fecha").min = hoy();
  $("res-fecha").value = $("fecha-agenda").value >= hoy() ? $("fecha-agenda").value : hoy();
  abrirModal("modal-reserva", "#btn-cerrar-reserva, #btn-cancelar-reserva");
};
$("form-reserva").onsubmit = async e => {
  e.preventDefault();
  const btn = $("btn-guardar-reserva");
  if (btn.disabled) return;
  const datos = {labId: Number($("res-lab").value), fecha: $("res-fecha").value, horaInicio: $("res-inicio").value,
    horaFin: $("res-fin").value, motivo: $("res-motivo").value.trim()};
  btn.disabled = true;
  try {
    if (!datos.labId || !datos.fecha || !datos.horaInicio || !datos.horaFin || !datos.motivo) throw new Error("Completa todos los campos.");
    if (datos.fecha < hoy()) throw new Error("Elige hoy o una fecha posterior.");
    if (datos.horaFin <= datos.horaInicio) throw new Error("La hora de fin debe ser posterior a la de inicio.");
    if (datos.motivo.length < 3) throw new Error("Describe la actividad con al menos tres caracteres.");
    const nueva = await crearReserva(datos);
    agenda.push(nueva);
    $("fecha-agenda").value = datos.fecha;
    if (!escritorio.matches) modo = "dia";
    renderAgenda();
    indicadores();
    $("btn-cerrar-reserva").click();
    $("res-motivo").value = "";
    showToast("Reserva agendada correctamente.");
  } catch (error) { $("res-error").textContent = error.message; }
  finally { btn.disabled = false; }
};
try {
  [labs, agenda, usuarios] = await Promise.all([cargarLaboratorios(), cargarAgenda(), cargarUsuarios()]);
  renderLabs();
  renderAgenda();
  indicadores();
} catch { showToast("No se pudieron cargar los datos de disponibilidad.", "error"); }
