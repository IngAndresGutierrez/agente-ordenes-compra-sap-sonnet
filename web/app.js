// Front del chat: bandeja con estados, flujo de pasos del agente, confirmación resaltada, hoja de la OC y registro de control.
const $ = (s) => document.querySelector(s)
const store = {
  get: (k) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch { /* sin almacenamiento */ } },
}

let sessionId = store.get("oc.session") ?? crypto.randomUUID()
store.set("oc.session", sessionId)
let accessKey = store.get("oc.key") ?? ""
let casos = []                  // bandeja: { caso, solicitud_id, descripcion, valor, moneda }
let control = { totales: {}, porSolicitud: {} }
const ordenes = new Map()       // caso → { paquete, validacion, payload, evidencia, creada, error }
let casoActivo = null
let casoProcesando = null
let enviando = false

const fmt = (n) => (typeof n === "number" ? n.toLocaleString("es-CO") : n ?? "")
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
const codigos = (xs) => (xs ?? []).map((x) => x.codigo ?? x).join(", ")

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", "x-access-key": accessKey, ...(opts.headers ?? {}) } })
  if (res.status === 401) {
    accessKey = prompt("Este enlace está protegido. Escribe la clave de acceso:") ?? ""
    store.set("oc.key", accessKey)
    if (accessKey) return api(path, opts)
  }
  return res
}

// ── Markdown mínimo y seguro (escapa primero, luego da formato) ──
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")

function markdown(md) {
  const lineas = md.replace(/\r/g, "").split("\n")
  const out = []
  const esTabla = (l) => /^\s*\|.*\|\s*$/.test(l)
  const esLista = (l) => /^\s*([-*]|\d+\.)\s+/.test(l)
  for (let i = 0; i < lineas.length; ) {
    const l = lineas[i]
    if (esTabla(l)) {
      const filas = []
      while (i < lineas.length && esTabla(lineas[i])) filas.push(lineas[i++])
      const celdas = (f) => f.trim().slice(1, -1).split("|").map((c) => c.trim())
      const [cab, ...resto] = filas.filter((f) => !/^\s*\|[\s:|-]+\|\s*$/.test(f))
      out.push(`<table><thead><tr>${celdas(cab).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${resto.map((f) => `<tr>${celdas(f).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`)
    } else if (/^#{1,6}\s/.test(l)) {
      out.push(`<h3>${inline(l.replace(/^#+\s*/, ""))}</h3>`); i++
    } else if (esLista(l)) {
      const tag = /^\s*\d+\./.test(l) ? "ol" : "ul"
      const items = []
      while (i < lineas.length && esLista(lineas[i])) items.push(lineas[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""))
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${tag}>`)
    } else if (l.trim() === "" || /^-{3,}$/.test(l.trim())) {
      i++
    } else {
      const par = []
      while (i < lineas.length && lineas[i].trim() !== "" && !esTabla(lineas[i]) && !esLista(lineas[i]) && !/^#{1,6}\s/.test(lineas[i])) par.push(lineas[i++])
      out.push(`<p>${par.map(inline).join("<br>")}</p>`)
    }
  }
  return out.join("")
}

// ── Estado por solicitud: combina lo visto en esta sesión con el registro de control del servidor ──
function estadoDe(caso) {
  const info = casos.find((c) => c.caso === caso)
  const srv = info && control.porSolicitud[info.solicitud_id]
  const o = ordenes.get(caso)
  if (caso === casoProcesando) return { clase: "procesando", texto: "Procesando…" }
  if (o?.creada || srv?.resultado === "creada") return { clase: "creada", texto: `OC ${o?.creada?.numero_oc ?? srv.numero_oc}` }
  const v = o?.validacion
  if (v && !v.apta) return { clase: "bloqueada", texto: `Bloqueada · ${codigos(v.bloqueos)}` }
  if (v?.requiere_confirmacion) return { clase: "pendiente", texto: `Por confirmar · ${codigos(v.confirmaciones)}` }
  if (v) return { clase: "apta", texto: "Apta" }
  if (srv?.resultado === "bloqueada") return { clase: "bloqueada", texto: `Bloqueada · ${srv.bloqueos.join(", ")}` }
  if (srv?.resultado === "pendiente_confirmacion") return { clase: "pendiente", texto: `Por confirmar · ${srv.confirmaciones.join(", ")}` }
  if (o?.error) return { clase: "bloqueada", texto: "Error" }
  return { clase: "", texto: "Sin procesar" }
}

function pintarBandeja() {
  const ul = $("#lista-casos")
  ul.innerHTML = ""
  for (const c of casos) {
    const e = estadoDe(c.caso)
    const li = document.createElement("li")
    li.innerHTML = `<button type="button" class="caso ${e.clase}" aria-current="${c.caso === casoActivo}">
      <span class="cabeza"><span class="id">${esc(c.caso)}</span><span class="pill">${esc(e.texto)}</span></span>
      <span class="desc">${esc(c.descripcion)}</span>
      <span class="valor">${esc(c.moneda)} ${fmt(c.valor)}</span></button>`
    li.querySelector("button").onclick = () => abrirCaso(c.caso)
    ul.appendChild(li)
  }
  pintarControl()
}

function abrirCaso(caso) {
  const o = ordenes.get(caso)
  if (o?.validacion || o?.creada) {
    casoActivo = caso
    pintarHoja()
    pintarBandeja()
    return
  }
  casoProcesando = caso
  enviar(`Procesa la solicitud "${caso}". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.`)
}

function esRetroactiva(caso) {
  const info = casos.find((c) => c.caso === caso)
  const o = ordenes.get(caso)
  return Boolean(o?.creada?.retroactiva ?? (info && control.porSolicitud[info.solicitud_id]?.retroactiva))
}

/** Los contadores cuentan solicitudes según su estado en la bandeja; control.csv cuenta intentos. */
function pintarControl() {
  const estados = casos.map((c) => ({ caso: c.caso, clase: estadoDe(c.caso).clase }))
  const contar = (clase) => estados.filter((e) => e.clase === clase).length
  const t = {
    creadas: contar("creada"),
    bloqueadas: contar("bloqueada"),
    pendientes: contar("pendiente"),
    retroactivas: estados.filter((e) => e.clase === "creada" && esRetroactiva(e.caso)).length,
  }
  const items = [["creadas", "Creadas"], ["bloqueadas", "Bloqueadas"], ["pendientes", "Por confirmar"], ["retroactivas", "Retroactivas"]]
  $("#contadores").innerHTML = items.map(([k, l]) => `<div class="${k}"><dt>${l}</dt><dd>${t[k]}</dd></div>`).join("")
  const intentos = control.totales?.intentos ?? 0
  $("#intentos").textContent = intentos
    ? `${intentos} intento${intentos === 1 ? "" : "s"} de crear OC en control.csv`
    : "Aún no hay intentos de crear OC en control.csv"
}

async function refrescarControl() {
  const res = await api("/api/control").catch(() => null)
  if (res?.ok) control = await res.json()
  pintarControl()
  pintarBandeja()
}

// ── Flujo de pasos del agente (llamadas a herramientas en lenguaje claro) ──
const TITULOS = {
  oc_leer_paquete: "Leer el paquete",
  oc_validar: "Validar controles",
  oc_construir_payload: "Armar la OC",
  oc_generar_evidencia: "Generar evidencia",
  oc_crear: "Crear en SAP",
}

function describirPaso(t) {
  const d = t.data ?? {}
  if (t.name === "oc_validar" && t.ok) {
    const pasan = d.controles.filter((c) => c.estado === "ok" || c.estado === "derivado").length
    const partes = [`${pasan} de ${d.controles.length} pasan`]
    if (d.bloqueos.length) partes.push(`bloquea ${codigos(d.bloqueos)}`)
    if (d.confirmaciones.length) partes.push(`por confirmar ${codigos(d.confirmaciones)}`)
    return { estado: !d.apta ? "bloqueo" : d.requiere_confirmacion ? "alerta" : "ok", texto: partes.join(" · ") }
  }
  if (t.name === "oc_leer_paquete" && t.ok) {
    const falt = d.faltantes?.length ? ` · faltan: ${d.faltantes.join(", ")}` : ""
    return { estado: "ok", texto: `${d.solicitud.solicitud_id} · ${d.solicitud.descripcion}${falt}` }
  }
  if (t.name === "oc_construir_payload" && t.ok) return { estado: "ok", texto: `${d.orden.proveedor.nombre} · ${d.orden.moneda} ${fmt(d.valor_total)}` }
  if (t.name === "oc_generar_evidencia" && t.ok) return { estado: "ok", texto: `PDF con sha256 ${String(d.sha256).slice(0, 10)}…` }
  if (t.name === "oc_crear" && t.ok) return { estado: "ok", texto: d.idempotente ? `Ya existía la OC ${d.numero_oc}; no se duplicó` : `OC ${d.numero_oc} creada${d.retroactiva ? " · marcada retroactiva" : ""}` }
  if (t.name === "oc_crear" && d.requiere_confirmacion) return { estado: "alerta", texto: "Esperando tu confirmación" }
  if (d.bloqueos?.length) return { estado: "bloqueo", texto: `No se puede: bloquea ${codigos(d.bloqueos)}` }
  return { estado: t.ok ? "ok" : "error", texto: t.resumen }
}

function renderPasos(toolCalls) {
  const ol = document.createElement("ol")
  ol.className = "pasos"
  ol.setAttribute("aria-label", "Pasos que ejecutó el agente")
  const iconos = { ok: "✓", alerta: "!", bloqueo: "✕", error: "✕" }
  for (const t of toolCalls) {
    const p = describirPaso(t)
    const caso = t.data?.caso ?? t.input?.caso ?? ""
    const li = document.createElement("li")
    li.innerHTML = `<details class="paso ${p.estado}"><summary>
        <span class="icono" aria-label="${p.estado}">${iconos[p.estado]}</span>
        <span class="titulo">${esc(TITULOS[t.name] ?? t.name)}</span>
        <span class="caso-ref">${esc(caso)}</span>
        <span class="detalle">${esc(p.texto)}</span></summary>
      <pre>Herramienta: ${esc(t.name)}\n\nArgumentos:\n${esc(JSON.stringify(t.input, null, 2))}\n\nResultado:\n${esc(JSON.stringify(t.data, null, 2))}</pre></details>`
    ol.appendChild(li)
  }
  return ol
}

// ── Confirmación: lista lo pendiente con los datos de las herramientas, no del texto del modelo ──
function pendientes() {
  return [...ordenes.entries()].filter(([, o]) => o.validacion?.requiere_confirmacion && !o.creada)
}

function accionesConfirmar(contenedor) {
  const p = pendientes()
  const destino = p.length === 1 ? ` de ${p[0][0]}` : "s pendientes"
  const acc = document.createElement("div")
  acc.className = "acciones"
  acc.innerHTML = `<button class="si" type="button">Confirmar y crear la OC${p.length > 1 ? "s" : ""}</button><button class="no" type="button">No crear todavía</button>`
  acc.querySelector(".si").onclick = () => enviar(`Confirmo, crea la OC${destino}.`)
  acc.querySelector(".no").onclick = () => enviar("No la crees todavía.")
  contenedor.appendChild(acc)
}

function renderCallout() {
  const box = document.createElement("div")
  box.className = "callout"
  const items = pendientes().flatMap(([caso, o]) => o.validacion.confirmaciones.map((c) => `<li><strong>${esc(caso)} · ${esc(c.codigo)}</strong> ${esc(c.detalle)}</li>`))
  box.innerHTML = `<strong>Esperando tu confirmación antes de crear la OC</strong>${items.length ? `<ul>${items.join("")}</ul>` : ""}`
  accionesConfirmar(box)
  return box
}

// ── Mensajes ──
function agregarMensaje(m) {
  $("#bienvenida").hidden = true
  const li = document.createElement("li")
  li.className = `msg ${m.role}${m.error ? " error" : ""}`
  if (m.role === "user") {
    li.textContent = m.text
  } else {
    if (m.toolCalls?.length) li.appendChild(renderPasos(m.toolCalls))
    const cuerpo = document.createElement("div")
    cuerpo.innerHTML = markdown(m.text)
    li.appendChild(cuerpo)
    if (m.needsConfirmation && m.activo) li.appendChild(renderCallout())
  }
  $("#mensajes").appendChild(li)
  li.scrollIntoView({ behavior: "smooth", block: "nearest" })
}

function absorber(toolCalls) {
  for (const t of toolCalls ?? []) {
    const caso = t.data?.caso ?? (typeof t.input?.caso === "string" ? t.input.caso : null)
    if (!caso) continue
    const o = ordenes.get(caso) ?? {}
    if (t.name === "oc_leer_paquete") Object.assign(o, t.ok ? { paquete: t.data, error: null } : { error: t.resumen })
    if (t.name === "oc_validar" && t.ok) o.validacion = t.data
    if (t.name === "oc_construir_payload" && t.ok) o.payload = t.data
    if (t.name === "oc_generar_evidencia" && t.ok) o.evidencia = t.data
    if (t.name === "oc_crear" && t.ok) { o.creada = t.data; o.nuevo = true }
    ordenes.set(caso, o)
    casoActivo = caso
  }
  pintarHoja()
  pintarBandeja()
}

// ── Hoja de la OC ──
const HOJA_VACIA = `<p>Aquí verás la orden en revisión: los datos como quedarían en SAP, el estado de los 10 controles y el resultado.</p>`

function pintarHoja() {
  const hoja = $("#hoja")
  const o = casoActivo && ordenes.get(casoActivo)
  if (!o) { hoja.className = "hoja vacia"; hoja.innerHTML = HOJA_VACIA; return }
  const v = o.validacion
  const e = estadoDe(casoActivo)
  hoja.className = `hoja ${e.clase === "bloqueada" ? "bloqueada" : e.clase === "pendiente" ? "pendiente" : ""}`

  const sello = {
    creada: `<div class="sello creada${o.nuevo ? " nuevo" : ""}">OC ${esc(o.creada?.numero_oc ?? "")}<small>${o.creada?.idempotente ? "ya existía" : "creada en SAP"}${o.creada?.retroactiva ? " · retroactiva" : ""}</small></div>`,
    bloqueada: `<div class="sello bloqueada">Bloqueada<small>${esc(codigos(v?.bloqueos))}</small></div>`,
    pendiente: `<div class="sello pendiente">Por confirmar<small>${esc(codigos(v?.confirmaciones))}</small></div>`,
    apta: `<div class="sello">Apta</div>`,
  }[e.clase] ?? ""
  o.nuevo = false

  const s = o.paquete?.solicitud
  const orden = o.payload?.orden
  const pos = orden?.posiciones?.[0]
  const campos = orden
    ? [
        ["Proveedor", `${esc(orden.proveedor.nombre)}<span class="sub">SAP ${esc(orden.proveedor.codigo_sap)} · NIT ${esc(orden.proveedor.nit)}</span>`],
        ["Descripción", esc(pos.descripcion)],
        ["Cantidad", `<span class="codigo">${fmt(pos.cantidad)} ${esc(pos.unidad)} × ${fmt(pos.precio_unitario)}</span>`],
        ["Valor total", `<span class="total">${esc(orden.moneda)} ${fmt(o.payload.valor_total)}</span>`],
        ["Centro", `<span class="codigo">${esc(pos.centro_costo)}</span> · ${esc(pos.subarea)}`],
        ["IVA / pago", `<span class="codigo">${esc(pos.indicador_iva)} · ${esc(orden.condiciones_pago)}</span>`],
        ["Aprobador", `${esc(orden.aprobador.email)}<span class="sub">${esc(orden.aprobador.fecha_aprobacion)}</span>`],
        ["Cotización", `<span class="codigo">${esc(orden.referencia.cotizacion_ref ?? "—")}</span>`],
      ]
    : s
      ? [
          ["Proveedor", `${esc(s.proveedor_nombre)}${s.proveedor_nit ? `<span class="sub">NIT ${esc(s.proveedor_nit)}</span>` : ""}`],
          ["Descripción", esc(s.descripcion)],
          ["Valor total", `<span class="total">${esc(s.moneda)} ${fmt(s.valor_total)}</span>`],
          ["Centro", `<span class="codigo">${esc(s.centro_costo)}</span> · ${esc(s.subarea)}`],
          ["Aprobación", esc(o.paquete.aprobacion?.de ?? "sin aprobación")],
        ]
      : []

  const etiquetas = { ok: "pasa", bloqueo: "bloquea", confirmacion: "por confirmar", derivado: "derivado" }
  const incidencias = (v?.controles ?? []).filter((c) => c.estado !== "ok")
  const confirmable = v?.requiere_confirmacion && !o.creada && !enviando

  hoja.innerHTML = `
    ${sello}
    <h2>Orden de compra</h2>
    <p class="ref">${esc(casoActivo)}${s ? ` · ${esc(s.solicitud_id)}` : ""}</p>
    ${o.error ? `<p>${esc(o.error)}</p>` : ""}
    ${campos.length ? `<dl class="campos">${campos.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join("")}</dl>` : ""}
    ${v ? `
      <ol class="rc-grid" aria-label="Estado de los 10 controles">${v.controles.map((c) => `<li class="${c.estado}" title="${esc(`${c.regla}: ${c.detalle}`)}">${esc(c.codigo)}</li>`).join("")}</ol>
      <p class="leyenda">Verde pasa · ámbar por confirmar · rojo bloquea · azul derivado del maestro</p>
      ${incidencias.length ? `<div class="incidencias">${incidencias.map((c) => `
        <div class="incidencia ${c.estado}"><strong>${esc(c.codigo)} · ${esc(c.regla)}</strong>
          <p>${esc(c.detalle)}</p>${o.creada && c.estado === "confirmacion" ? `<p class="hacer">Confirmada por la analista; quedó registrada en la OC.</p>` : c.accion_sugerida ? `<p class="hacer">Qué hacer: ${esc(c.accion_sugerida)}</p>` : ""}</div>`).join("")}</div>` : ""}
      <details class="todos"><summary>Ver el detalle de los 10 controles</summary><ol>${v.controles.map((c) => `<li><span class="cod">${esc(c.codigo)}</span><strong>${etiquetas[c.estado]}</strong> · ${esc(c.detalle)}</li>`).join("")}</ol></details>` : ""}
    <div class="acciones-hoja"></div>
    <div class="enlaces">
      ${o.evidencia || o.creada ? `<a href="#" data-ruta="out/${esc(casoActivo)}/aprobacion.pdf">Evidencia PDF</a>` : ""}
      ${o.payload ? `<a href="#" data-ruta="out/${esc(casoActivo)}/payload.json">Payload</a><a href="#" data-ruta="out/${esc(casoActivo)}/trazabilidad.json">Trazabilidad</a>` : ""}
    </div>`
  if (confirmable) accionesConfirmar(hoja.querySelector(".acciones-hoja"))
}

// ── Envío ──
async function enviar(texto) {
  if (enviando || !texto.trim()) return
  enviando = true
  document.querySelectorAll(".callout .acciones, .acciones-hoja .acciones").forEach((a) => a.remove())
  agregarMensaje({ role: "user", text: texto })
  $("#texto").value = ""
  $("#enviar").disabled = true
  $("#pensando").hidden = false
  pintarBandeja()
  try {
    const res = await api("/api/chat", { method: "POST", body: JSON.stringify({ sessionId, message: texto }) })
    const r = await res.json()
    if (!res.ok) throw new Error(r.error ?? `Error ${res.status}`)
    casoProcesando = null
    absorber(r.toolCalls)
    agregarMensaje({ role: "assistant", text: r.reply, toolCalls: r.toolCalls, needsConfirmation: r.needsConfirmation, error: r.error, activo: true })
  } catch (e) {
    agregarMensaje({ role: "assistant", text: `No se pudo enviar el mensaje: ${e.message}. Revisa tu conexión e intenta de nuevo.`, error: true })
  } finally {
    enviando = false
    casoProcesando = null
    $("#enviar").disabled = false
    $("#pensando").hidden = true
    pintarHoja()
    await refrescarControl()
    $("#texto").focus()
  }
}

$("#form").addEventListener("submit", (e) => { e.preventDefault(); enviar($("#texto").value) })
$("#texto").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar($("#texto").value) }
})

document.addEventListener("click", async (e) => {
  const a = e.target.closest("a[data-ruta]")
  if (!a) return
  e.preventDefault()
  const ventana = window.open("", "_blank")
  const res = await api(`/api/archivos?ruta=${encodeURIComponent(a.dataset.ruta)}`, { headers: { "content-type": "" } })
  if (!res.ok) { ventana?.close(); alert((await res.json()).error ?? "No disponible"); return }
  const url = URL.createObjectURL(await res.blob())
  if (ventana) ventana.location = url
})

$("#reiniciar").addEventListener("click", async () => {
  if (!confirm("Esto borra las OC creadas, los registros y la conversación. ¿Reiniciar la demo?")) return
  await api("/api/reiniciar", { method: "POST" })
  sessionId = crypto.randomUUID()
  store.set("oc.session", sessionId)
  ordenes.clear()
  casoActivo = null
  $("#mensajes").innerHTML = ""
  $("#bienvenida").hidden = false
  pintarHoja()
  await refrescarControl()
})

// ── Arranque ──
async function iniciar() {
  pintarHoja()
  try {
    const h = await (await fetch("/api/health")).json()
    $("#estado-modelo").textContent = `Agente en línea · ${h.model}`
  } catch {
    $("#estado-modelo").textContent = "Sin conexión con el servidor"
  }
  casos = (await (await api("/api/casos")).json().catch(() => ({ casos: [] }))).casos ?? []

  const res = await api(`/api/sessions/${sessionId}`)
  if (res.ok) {
    const s = await res.json()
    s.historial.forEach((m) => { if (m.role === "assistant") absorber(m.toolCalls) })
    s.historial.forEach((m, i) => agregarMensaje({ ...m, activo: i === s.historial.length - 1 }))
  }
  await refrescarControl()
}
iniciar()
