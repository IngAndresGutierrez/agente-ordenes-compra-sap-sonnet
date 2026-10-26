// Verificación sin modelo: corre los 6 casos llamando directamente a las herramientas.
// Uso: npm run demo
import { rm } from "node:fs/promises"
import { listarCasos } from "./src/oc/fuentes.ts"
import { ejecutar } from "./src/tools/registro.ts"
import type { ToolCtx } from "./src/tools/tipos.ts"

const root = process.cwd()
const ctx: ToolCtx = { directory: root, sessionId: "demo", confirmacionHumana: true }

type Data = Record<string, unknown> & { codigo?: string }
const codigos = (xs: unknown) => (Array.isArray(xs) ? xs.map((x: Data) => x.codigo).join(", ") || "—" : "—")

async function llamar(name: string, input: Record<string, unknown>) {
  const r = await ejecutar(name, input, ctx)
  return { ...r, d: r.data as Data }
}

async function procesar(caso: string, opciones: { confirmado?: boolean; etiqueta?: string } = {}) {
  console.log(`\n━━ ${caso}${opciones.etiqueta ? ` · ${opciones.etiqueta}` : ""}`)
  const paquete = await llamar("oc_leer_paquete", { caso })
  if (!paquete.ok) return console.log(`  ✗ ${paquete.resumen}`)

  const v = await llamar("oc_validar", { caso })
  if (!v.ok) return console.log(`  ✗ ${v.resumen}`)
  console.log(`  apta: ${v.d.apta}   retroactiva: ${v.d.retroactiva}`)
  console.log(`  bloqueos: ${codigos(v.d.bloqueos)}   confirmaciones: ${codigos(v.d.confirmaciones)}`)

  if (v.d.apta) {
    const p = await llamar("oc_construir_payload", { caso })
    console.log(`  payload: ${p.ok ? `ok → ${p.d.ruta_trazabilidad}` : p.resumen}`)
    const e = await llamar("oc_generar_evidencia", { caso })
    console.log(`  evidencia: ${e.ok ? `${e.d.ruta_pdf} sha256=${String(e.d.sha256).slice(0, 16)}…` : e.resumen}`)
  }

  const c = await llamar("oc_crear", { caso, confirmado: opciones.confirmado })
  console.log(c.ok ? `  ✓ OC ${c.d.numero_oc}${c.d.idempotente ? " (idempotente: ya existía)" : ""}` : `  ✗ no creada → ${c.resumen}`)
}

await rm(`${root}/out`, { recursive: true, force: true })

for (const caso of await listarCasos(root)) await procesar(caso)

console.log("\n══ Segunda pasada: idempotencia y confirmaciones explícitas")
await procesar("sol-001", { etiqueta: "otra vez: debe devolver el mismo número" })
await procesar("sol-004", { confirmado: true, etiqueta: "la analista confirma la diferencia de valor" })
await procesar("sol-005", { confirmado: true, etiqueta: "la analista confirma la OC retroactiva" })
await procesar("sol-006", { confirmado: true, etiqueta: "la analista confirma el IVA derivado" })

console.log("\n══ Errores controlados")
await procesar("sol-999", { etiqueta: "caso inexistente" })

console.log("\nArchivos: out/sap/ordenes.jsonl · out/control.csv · out/log.jsonl · out/<caso>/")
