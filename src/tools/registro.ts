// Convierte los módulos de herramientas en specs para el modelo y ejecuta llamadas con validación zod.
import { z } from "zod"
import { registrarLog } from "../oc/registro.ts"
import * as oc from "./oc.ts"
import type { ToolCtx, ToolDef } from "./tipos.ts"

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> }

type AnyTool = ToolDef<z.ZodRawShape>

/** Nombre visible para el modelo: <archivo>_<export>. */
const MODULOS: Record<string, Record<string, AnyTool>> = { oc: oc as unknown as Record<string, AnyTool> }

const tools = new Map<string, AnyTool>(
  Object.entries(MODULOS).flatMap(([archivo, mod]) =>
    Object.entries(mod).map(([exp, t]) => [`${archivo}_${exp}`, t] as const),
  ),
)

export function specs(): ToolSpec[] {
  return [...tools.entries()].map(([name, t]) => {
    const { $schema: _omit, ...inputSchema } = z.toJSONSchema(z.object(t.args)) as Record<string, unknown>
    return { name, description: t.description, inputSchema }
  })
}

export type Ejecucion = { name: string; input: unknown; output: string; ok: boolean; resumen: string; data: unknown }

export async function ejecutar(name: string, input: unknown, ctx: ToolCtx): Promise<Ejecucion> {
  const t = tools.get(name)
  let output: string
  if (!t) {
    output = JSON.stringify({ ok: false, error: `herramienta desconocida: ${name}` })
  } else {
    const parsed = z.object(t.args).safeParse(input)
    output = parsed.success
      ? await t.execute(parsed.data, ctx)
      : JSON.stringify({ ok: false, error: `argumentos inválidos: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` })
  }

  const r = JSON.parse(output) as { ok: boolean; data?: { resumen?: string; caso?: string }; error?: string }
  const resumen = r.ok ? (r.data?.resumen ?? "ok") : (r.error ?? "error")
  const caso = r.data?.caso ?? (typeof (input as { caso?: unknown })?.caso === "string" ? (input as { caso: string }).caso : null)
  await registrarLog(ctx.directory, { ts: new Date().toISOString(), sesion: ctx.sessionId, herramienta: name, caso, ok: r.ok, resumen }).catch(() => undefined)
  return { name, input, output, ok: r.ok, resumen, data: r.ok ? r.data : r }
}
