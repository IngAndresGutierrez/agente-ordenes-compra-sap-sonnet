// Herramientas del agente. Cada export se expone al modelo como oc_<export>.
// Ninguna lanza: todas devuelven { ok: true, data } o { ok: false, error }.
// Los valores siempre se recalculan desde los fixtures; lo que mande el modelo nunca es fuente de verdad.
import { isDeepStrictEqual } from "node:util"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { validar as aplicarControles, type Validacion } from "../oc/controles.ts"
import { pdfEvidencia, sha256, textoEvidencia } from "../oc/evidencia.ts"
import { FuenteError, leerAprobacionRaw, leerMaestros, leerPaquete, normalizarCaso } from "../oc/fuentes.ts"
import { construirPayload } from "../oc/payload.ts"
import { registrarControl } from "../oc/registro.ts"
import type { OrdenCompra, Paquete } from "../oc/schemas.ts"
import { SapMock } from "../sap/mock.ts"
import { fallo, ok, type ToolCtx, type ToolDef } from "./tipos.ts"

const caso = z.string().describe('Carpeta del caso en fixtures/reto-03/solicitudes/, ej. "sol-004" (también acepta "SOL-2026-004")')

const sapPorRaiz = new Map<string, SapMock>()
const sap = (root: string) => {
  let s = sapPorRaiz.get(root)
  if (!s) sapPorRaiz.set(root, (s = new SapMock(root)))
  return s
}

async function seguro(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof FuenteError) return fallo(e.message)
    return fallo(`error interno: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function contexto(root: string, c: string): Promise<{ caso: string; paquete: Paquete; validacion: Validacion }> {
  const id = normalizarCaso(c)
  const paquete = await leerPaquete(root, id)
  const validacion = aplicarControles(paquete, await leerMaestros(root))
  return { caso: id, paquete, validacion }
}

async function escribirEvidencia(root: string, c: string): Promise<{ ruta: string; ruta_pdf: string; sha256: string }> {
  const raw = await leerAprobacionRaw(root, c)
  if (!raw) throw new FuenteError("no hay correo de aprobación: no se puede generar la evidencia. Pídelo al solicitante.")
  const contenido = textoEvidencia(raw)
  const hash = sha256(contenido)
  const dir = join(root, "out", c)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "aprobacion.txt"), `${contenido}\n\n---\nsha256: ${hash}\n`)
  await writeFile(join(dir, "aprobacion.pdf"), await pdfEvidencia(contenido, hash, c))
  return { ruta: `out/${c}/aprobacion.txt`, ruta_pdf: `out/${c}/aprobacion.pdf`, sha256: hash }
}

const codigos = (v: Validacion["controles"]) => v.map((c) => c.codigo)

export const leer_paquete: ToolDef<{ caso: typeof caso }> = {
  description: "Lee y normaliza el paquete de una solicitud (correo, solicitud, cotización, aprobación y factura si existe); los adjuntos ausentes llegan en null.",
  args: { caso },
  execute: (args, ctx) =>
    seguro(async () => {
      const id = normalizarCaso(args.caso)
      const p = await leerPaquete(ctx.directory, id)
      const falt = p.faltantes.length ? ` Faltan: ${p.faltantes.join(", ")}.` : ""
      return ok({ caso: id, ...p, resumen: `${p.solicitud.solicitud_id}: ${p.solicitud.descripcion}.${falt}` })
    }),
}

export const validar: ToolDef<{ caso: typeof caso; paquete: z.ZodOptional<z.ZodUnknown> }> = {
  description: "Aplica los controles RC1–RC10 contra los maestros y devuelve si la OC es apta, sus bloqueos, confirmaciones pendientes, valores derivados y si es retroactiva.",
  args: {
    caso,
    paquete: z.unknown().optional().describe("Opcional. Se ignora: el paquete se vuelve a leer de la fuente para que nadie pueda alterarlo."),
  },
  execute: (args, ctx) =>
    seguro(async () => {
      const { caso: id, validacion: v } = await contexto(ctx.directory, args.caso)
      const estado = !v.apta ? "bloqueada" : v.confirmaciones.length ? "requiere confirmación" : "apta"
      return ok({
        caso: id,
        apta: v.apta,
        retroactiva: v.retroactiva,
        requiere_confirmacion: v.apta && v.confirmaciones.length > 0,
        controles: v.controles,
        bloqueos: v.bloqueos,
        confirmaciones: v.confirmaciones,
        derivados: v.derivados,
        resumen: `${id}: ${estado}. Bloqueos [${codigos(v.bloqueos).join(", ")}], confirmaciones [${codigos(v.confirmaciones).join(", ")}].`,
      })
    }),
}

export const construir_payload: ToolDef<{ caso: typeof caso; paquete: z.ZodOptional<z.ZodUnknown>; derivados: z.ZodOptional<z.ZodUnknown> }> = {
  description: "Construye la OC exactamente como quedaría en SAP (validada con zod) y guarda la trazabilidad de cada campo; no crea nada.",
  args: {
    caso,
    paquete: z.unknown().optional().describe("Opcional. Se ignora: se recalcula desde la fuente."),
    derivados: z.unknown().optional().describe("Opcional. Se ignora: los derivados salen de oc_validar recalculado."),
  },
  execute: (args, ctx) =>
    seguro(async () => {
      const { caso: id, paquete, validacion: v } = await contexto(ctx.directory, args.caso)
      const raw = await leerAprobacionRaw(ctx.directory, id)
      const hash = raw ? sha256(textoEvidencia(raw)) : ""
      const r = construirPayload(paquete, v, hash, null)
      if ("error" in r) return fallo(r.error, { bloqueos: v.bloqueos })
      const dir = join(ctx.directory, "out", id)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, "trazabilidad.json"), JSON.stringify(r.trazabilidad, null, 2))
      await writeFile(join(dir, "payload.json"), JSON.stringify(r.orden, null, 2))
      return ok({
        caso: id,
        orden: r.orden,
        valor_total: paquete.solicitud.valor_total,
        trazabilidad: r.trazabilidad,
        ruta_trazabilidad: `out/${id}/trazabilidad.json`,
        confirmaciones_pendientes: v.confirmaciones,
        requiere_confirmacion: v.confirmaciones.length > 0,
        resumen: `${id}: OC lista para ${r.orden.proveedor.nombre} por ${paquete.solicitud.moneda} ${paquete.solicitud.valor_total.toLocaleString("es-CO")}.`,
      })
    }),
}

export const generar_evidencia: ToolDef<{ caso: typeof caso }> = {
  description: "Genera la evidencia del correo de aprobación (aprobacion.txt con sha256 y aprobacion.pdf) en out/<caso>/.",
  args: { caso },
  execute: (args, ctx) =>
    seguro(async () => {
      const id = normalizarCaso(args.caso)
      const e = await escribirEvidencia(ctx.directory, id)
      return ok({ caso: id, ...e, resumen: `Evidencia en ${e.ruta} y ${e.ruta_pdf} (sha256 ${e.sha256.slice(0, 12)}…).` })
    }),
}

export const crear: ToolDef<{ caso: typeof caso; payload: z.ZodOptional<z.ZodUnknown>; confirmado: z.ZodOptional<z.ZodBoolean> }> = {
  description: "Crea la OC en SAP (simulado) si es apta; con confirmaciones pendientes exige confirmado=true, que solo vale si el usuario acaba de confirmar. Es idempotente por solicitud.",
  args: {
    caso,
    payload: z.unknown().optional().describe("Opcional. Si se envía, debe ser idéntico al de oc_construir_payload; si difiere, no se crea."),
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente en su último mensaje."),
  },
  execute: (args, ctx) => seguro(() => crearOrden(args, ctx)),
}

async function crearOrden(args: { caso: string; payload?: unknown; confirmado?: boolean }, ctx: ToolCtx): Promise<string> {
  const { caso: id, paquete, validacion: v } = await contexto(ctx.directory, args.caso)
  const s = paquete.solicitud
  const fila = {
    solicitud_id: s.solicitud_id,
    retroactiva: v.retroactiva,
    bloqueos: codigos(v.bloqueos),
    confirmaciones: codigos(v.confirmaciones),
    ts: new Date().toISOString(),
  }

  const existente = await sap(ctx.directory).buscarOrdenPorReferencia(s.solicitud_id)
  if (existente) {
    await registrarControl(ctx.directory, { ...fila, resultado: "existente", numero_oc: existente.numero_oc })
    return ok({ caso: id, numero_oc: existente.numero_oc, idempotente: true, retroactiva: v.retroactiva, resumen: `${s.solicitud_id} ya tenía la OC ${existente.numero_oc}; no se creó otra.` })
  }

  if (!v.apta) {
    await registrarControl(ctx.directory, { ...fila, resultado: "bloqueada", numero_oc: "" })
    return fallo(`OC bloqueada: ${v.bloqueos.map((b) => `${b.codigo} ${b.detalle}`).join(" | ")}`, { bloqueos: v.bloqueos })
  }

  if (v.confirmaciones.length > 0 && !args.confirmado) {
    await registrarControl(ctx.directory, { ...fila, resultado: "pendiente_confirmacion", numero_oc: "" })
    return fallo(`requiere confirmación explícita: ${v.confirmaciones.map((c) => `${c.codigo} ${c.detalle}`).join(" | ")}`, { requiere_confirmacion: true, confirmaciones: v.confirmaciones })
  }
  if (v.confirmaciones.length > 0 && ctx.confirmacionHumana === false) {
    await registrarControl(ctx.directory, { ...fila, resultado: "pendiente_confirmacion", numero_oc: "" })
    return fallo("requiere confirmación explícita: el último mensaje del usuario no confirma la creación. Pregúntale antes de crear.", { requiere_confirmacion: true, confirmaciones: v.confirmaciones })
  }

  const evidencia = await escribirEvidencia(ctx.directory, id)
  const confirmadoPor = v.confirmaciones.length ? `analista (chat, sesión ${ctx.sessionId})` : null
  const r = construirPayload(paquete, v, evidencia.sha256, confirmadoPor)
  if ("error" in r) {
    await registrarControl(ctx.directory, { ...fila, resultado: "error", numero_oc: "" })
    return fallo(r.error)
  }
  if (args.payload !== undefined && !mismoPayload(args.payload, r.orden)) {
    await registrarControl(ctx.directory, { ...fila, resultado: "error", numero_oc: "" })
    return fallo("el payload enviado no coincide con el validado desde la fuente; no se crea la OC. Llama oc_crear sin payload.")
  }

  const creada = await sap(ctx.directory).crearOrden(r.orden)
  await writeFile(join(ctx.directory, "out", id, "orden.json"), JSON.stringify({ ...creada, orden: r.orden }, null, 2))
  await registrarControl(ctx.directory, { ...fila, resultado: "creada", numero_oc: creada.numero_oc })
  return ok({
    caso: id,
    ...creada,
    idempotente: false,
    retroactiva: v.retroactiva,
    evidencia: evidencia.ruta_pdf,
    excepciones: r.orden.excepciones,
    resumen: `OC ${creada.numero_oc} creada para ${s.solicitud_id}${v.retroactiva ? " (retroactiva)" : ""}.`,
  })
}

/** Compara ignorando confirmado_por, que el modelo no conoce de antemano. */
function mismoPayload(enviado: unknown, calculado: OrdenCompra): boolean {
  const sinConfirmador = (o: OrdenCompra) => ({ ...o, excepciones: o.excepciones.map(({ codigo, detalle }) => ({ codigo, detalle })) })
  const parsed = z.custom<OrdenCompra>((x) => typeof x === "object" && x !== null).safeParse(enviado)
  return parsed.success && isDeepStrictEqual(sinConfirmador(parsed.data), sinConfirmador(calculado))
}
