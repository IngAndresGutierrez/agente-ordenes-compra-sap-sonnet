// Front del chat: historial, llamadas a herramientas visibles, confirmación resaltada y hoja de la OC.
const $ = (s) => document.querySelector(s)
const store = {
  get: (k) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch { /* sin almacenamiento */ } },
  del: (k) => { try { localStorage.removeItem(k) } catch { /* sin almacenamiento */ } },
}

let sessionId = store.get("oc.session") ?? crypto.randomUUID()
store.set("oc.session", sessionId)
let accessKey = store.get("oc.key") ?? ""
const ordenes = new Map() // caso → { validacion, payload, creada, error }
let casoActivo = null

const fmt = (n) => typeof n === "number" ? n.toLocaleString("es-CO") : n

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
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")

function markdown(md) {
  const lineas = md.replace(/\r/g, "").split("\n")
  const out = []
  for (let i = 0; i < lineas.length; ) {
    const l = lineas[i]
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const filas = []
      while (i < lineas.length && /^\s*\|.*\|\s*$/.test(lineas[i])) filas.push(lineas[i++])
      const celdas = (f) => f.trim().slice(1, -1).split("|").map((c) => c.trim())
      const cuerpo = filas.filter((f) => !/^\s*\|[\s:|-]+\|\s*$/.test(f))
      const [cab, ...resto] = cuerpo
      out.push(`<table><thead><tr>${celdas(cab).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${resto.map((f) => `<tr>${celdas(f).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`)
    } else if (/^#{1,6}\s/.test(l)) {
      out.push(`<h3>${inline(l.replace(/^#+\s*/, ""))}</h3>`); i++
    } else if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordenada = /^\s*\d+\./.test(l)
      const items = []
      while (i < lineas.length && /^\s*([-*]|\d+\.)\s+/.test(lineas[i])) items.push(lineas[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""))
      const tag = ordenada ? "ol" : "ul"
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${tag}>`)
    } else if (l.trim() === "" || /^-{3,}$/.test(l.trim())) {
      i++
    } else {
      const par = []
      while (i < lineas.length && lineas[i].trim() !== "" && !/^\s*(\||#|[-*]\s|\d+\.\s)/.test(lineas[i])) par.push(lineas[i++])
      if (par.length === 0) { out.push(`<p>${inline(lineas[i++])}</p>`); continue }
      out.push(`<p>${par.map(inline).join("<br>")}</p>`)
    }
  }
  return out.join("")
}

// ── Conversación ──
function nombreCorto(name) { return name.replace(/^oc_/, "") }

function renderTool(t) {
  const d = document.createElement("details")
  d.className = `tool${t.ok ? "" : " falla"}`
  const caso = t.input?.caso ? `(${esc(t.input.caso)})` : ""
  d.innerHTML = `<summary>${t.ok ? "✓" : "✗"} <b>${esc(t.name)}</b>${caso} — ${esc(t.resumen)}</summary>
    <pre>Argumentos:\n${esc(JSON.stringify(t.input, null, 2))}\n\nResultado:\n${esc(JSON.stringify(t.data, null, 2))}</pre>`
  return d
}

function agregarMensaje(m) {
  const li = document.createElement("li")
  li.className = `msg ${m.role}${m.needsConfirmation ? " confirmar" : ""}${m.error ? " error" : ""}`
  if (m.role === "user") {
    li.textContent = m.text
  } else {
    if (m.toolCalls?.length) {
      const box = document.createElement("div")
      box.className = "herramientas"
      m.toolCalls.forEach((t) => box.appendChild(renderTool(t)))
      li.appendChild(box)
    }
    if (m.needsConfirmation) {
      const e = document.createElement("span")
      e.className = "pregunta-etiqueta"
      e.textContent = "El agente necesita tu confirmación antes de crear la OC"
      li.appendChild(e)
    }
    const cuerpo = document.createElement("div")
    cuerpo.innerHTML = markdown(m.text)
    li.appendChild(cuerpo)
    if (m.needsConfirmation && m.activo) {
      const acc = document.createElement("div")
      acc.className = "acciones"
      acc.innerHTML = `<button class="si" type="button">Confirmar y crear la OC</button><button class="no" type="button">No crear todavía</button>`
      acc.querySelector(".si").onclick = () => enviar("Confirmo, crea la OC.")
      acc.querySelector(".no").onclick = () => enviar("No la crees todavía.")
      li.appendChild(acc)
    }
  }
  $("#mensajes").appendChild(li)
  li.scrollIntoView({ behavior: "smooth", block: "end" })
}

function absorber(toolCalls) {
  for (const t of toolCalls ?? []) {
    const caso = t.data?.caso ?? t.input?.caso
    if (!caso) continue
    const o = ordenes.get(caso) ?? {}
    if (t.name === "oc_validar" && t.ok) Object.assign(o, { validacion: t.data, error: null })
    if (t.name === "oc_construir_payload" && t.ok) o.payload = t.data
    if (t.name === "oc_crear" && t.ok) { o.creada = t.data; o.nuevo = true }
    if (t.name === "oc_crear" && !t.ok && t.data?.requiere_confirmacion) o.pendiente = true
    if (t.name === "oc_leer_paquete" && !t.ok) o.error = t.resumen
    ordenes.set(caso, o)
    casoActivo = caso
  }
  pintarHoja()
}

// ── Hoja de la OC ──
function pintarHoja() {
  const hoja = $("#hoja")
  const o = casoActivo && ordenes.get(casoActivo)
  if (!o) return
  const v = o.validacion
  const orden = o.payload?.orden
  const estado = o.creada ? "creada" : v && !v.apta ? "bloqueada" : v?.requiere_confirmacion ? "pendiente" : v ? "apta" : "leida"
  hoja.className = `hoja ${estado === "bloqueada" ? "bloqueada" : estado === "pendiente" ? "pendiente" : ""}`

  const sello = {
    creada: `<div class="sello creada${o.nuevo ? " nuevo" : ""}">OC ${esc(o.creada?.numero_oc)}<small>${o.creada?.idempotente ? "ya existía" : "creada en SAP"}${o.creada?.retroactiva ? " · retroactiva" : ""}</small></div>`,
    bloqueada: `<div class="sello bloqueada">Bloqueada<small>${esc(v?.bloqueos.map((b) => b.codigo).join(", "))}</small></div>`,
    pendiente: `<div class="sello">Por confirmar<small>${esc(v?.confirmaciones.map((c) => c.codigo).join(", "))}</small></div>`,
    apta: `<div class="sello">Apta</div>`,
    leida: "",
  }[estado]
  o.nuevo = false

  const pos = orden?.posiciones?.[0]
  const campos = orden ? [
    ["Proveedor", `${orden.proveedor.nombre} (SAP ${orden.proveedor.codigo_sap})`],
    ["NIT", orden.proveedor.nit],
    ["Descripción", pos.descripcion],
    ["Cantidad", `${fmt(pos.cantidad)} ${pos.unidad} × ${fmt(pos.precio_unitario)}`],
    ["Valor total", `${orden.moneda} ${fmt(o.payload.valor_total)}`],
    ["Centro / subárea", `${pos.centro_costo} · ${pos.subarea}`],
    ["IVA", pos.indicador_iva],
    ["Cond. de pago", orden.condiciones_pago],
    ["Aprobador", `${orden.aprobador.email} (${orden.aprobador.fecha_aprobacion})`],
    ["Cotización", orden.referencia.cotizacion_ref ?? "—"],
  ] : []

  const etiquetas = { ok: "Pasa", bloqueo: "Bloquea", confirmacion: "Confirmar", derivado: "Derivado" }
  hoja.innerHTML = `
    ${sello}
    <h2>Orden de compra</h2>
    <p class="ref">${esc(casoActivo)}${orden ? ` · ${esc(orden.referencia.solicitud_id)}` : ""}</p>
    ${o.error ? `<p>${esc(o.error)}</p>` : ""}
    ${campos.length ? `<dl class="campos">${campos.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join("")}</dl>` : ""}
    ${v ? `<ul class="controles">${v.controles.map((c) => `<li class="${c.estado}"><span class="cod">${esc(c.codigo)}</span><span><span class="estado">${etiquetas[c.estado]}</span> · ${esc(c.regla)}<br><span class="det">${esc(c.detalle)}</span></span></li>`).join("")}</ul>` : ""}
    <div class="enlaces">
      <a href="#" data-ruta="out/${esc(casoActivo)}/aprobacion.pdf">Evidencia PDF</a>
      <a href="#" data-ruta="out/${esc(casoActivo)}/trazabilidad.json">Trazabilidad</a>
      <a href="#" data-ruta="out/${esc(casoActivo)}/payload.json">Payload</a>
    </div>`
}

// ── Envío ──
let enviando = false
async function enviar(texto) {
  if (enviando || !texto.trim()) return
  enviando = true
  document.querySelectorAll(".acciones").forEach((a) => a.remove())
  agregarMensaje({ role: "user", text: texto })
  $("#texto").value = ""
  $("#enviar").disabled = true
  $("#pensando").hidden = false
  try {
    const res = await api("/api/chat", { method: "POST", body: JSON.stringify({ sessionId, message: texto }) })
    const r = await res.json()
    if (!res.ok) throw new Error(r.error ?? `Error ${res.status}`)
    absorber(r.toolCalls)
    agregarMensaje({ role: "assistant", text: r.reply, toolCalls: r.toolCalls, needsConfirmation: r.needsConfirmation, error: r.error, activo: true })
  } catch (e) {
    agregarMensaje({ role: "assistant", text: `No se pudo enviar el mensaje: ${e.message}. Revisa tu conexión e intenta de nuevo.`, error: true })
  } finally {
    enviando = false
    $("#enviar").disabled = false
    $("#pensando").hidden = true
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
  ordenes.clear(); casoActivo = null
  $("#mensajes").innerHTML = ""
  $("#hoja").className = "hoja vacia"
  $("#hoja").innerHTML = `<p class="vacia-texto">Aquí aparece la orden en revisión: los datos como quedarían en SAP, los diez controles y el resultado.</p>`
})

// ── Arranque ──
async function iniciar() {
  try {
    const h = await (await fetch("/api/health")).json()
    $("#estado-modelo").textContent = `Agente en línea · ${h.provider} / ${h.model}`
  } catch {
    $("#estado-modelo").textContent = "Sin conexión con el servidor"
  }

  const casos = await (await api("/api/casos")).json().catch(() => ({ casos: [] }))
  const ul = $("#lista-casos")
  for (const c of casos.casos ?? []) {
    const li = document.createElement("li")
    li.innerHTML = `<button type="button"><span class="id">${esc(c.caso)}</span> · ${esc(c.moneda)} ${fmt(c.valor)}<span class="desc">${esc(c.descripcion)}</span></button>`
    li.querySelector("button").onclick = () =>
      enviar(`Procesa la solicitud "${c.caso}". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.`)
    ul.appendChild(li)
  }

  const res = await api(`/api/sessions/${sessionId}`)
  if (res.ok) {
    const s = await res.json()
    s.historial.forEach((m, i) => {
      if (m.role === "assistant") absorber(m.toolCalls)
      agregarMensaje({ ...m, activo: i === s.historial.length - 1 })
    })
  }
}
iniciar()
