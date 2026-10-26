// Ciclo del agente: prompt → modelo → herramientas → … → respuesta, con topes y confirmación humana.
import { LlmError, type LlmAdapter, type Mensaje } from "../llm/adapter.ts"
import { normalizarCaso } from "../oc/fuentes.ts"
import { ejecutar, specs, type Ejecucion } from "../tools/registro.ts"

export type Limites = { maxIteraciones: number; maxTokensSesion: number }

export type LlamadaVisible = { name: string; input: unknown; ok: boolean; resumen: string; data: unknown }

export type Turno = { role: "user" | "assistant"; text: string; toolCalls: LlamadaVisible[]; needsConfirmation: boolean; error?: boolean }

export type Sesion = {
  id: string
  mensajes: Mensaje[]
  historial: Turno[]
  tokens: number
  /** Casos con confirmaciones pendientes que el agente preguntó en el turno anterior. */
  pendientes: Set<string>
}

export type RespuestaTurno = { reply: string; toolCalls: LlamadaVisible[]; needsConfirmation: boolean; error?: boolean }

// Límites de palabra Unicode: \b no reconoce letras con tilde ("sí", "créala").
const palabra = (alternativas: string) => new RegExp(`(?<!\\p{L})(${alternativas})(?!\\p{L})`, "iu")
const AFIRMATIVO = palabra("s[ií]|confirmo|confirmado|confirmada|adelante|procede|proceder|cr[eé]a(la|r)?|dale|ok|de acuerdo|autorizo|apruebo")
const NEGATIVO = palabra("no|todav[ií]a no|a[uú]n no|espera|cancela|detente")

/** Confirmación explícita: afirmativa y sin negación. La decide el servidor, no el modelo. */
export function esConfirmacion(texto: string): boolean {
  return AFIRMATIVO.test(texto) && !NEGATIVO.test(texto)
}

export function nuevaSesion(id: string): Sesion {
  return { id, mensajes: [], historial: [], tokens: 0, pendientes: new Set() }
}

export async function turno(
  s: Sesion,
  texto: string,
  deps: { llm: LlmAdapter; system: string; directory: string; limites: Limites },
): Promise<RespuestaTurno> {
  s.historial.push({ role: "user", text: texto, toolCalls: [], needsConfirmation: false })

  if (s.tokens >= deps.limites.maxTokensSesion) {
    return cerrar(s, `Esta sesión alcanzó su tope de ${deps.limites.maxTokensSesion.toLocaleString("es-CO")} tokens. Abre una sesión nueva para seguir.`, [], true)
  }

  const confirmacionHumana = s.pendientes.size > 0 && esConfirmacion(texto)
  const ctx = { directory: deps.directory, sessionId: s.id, confirmacionHumana }
  s.mensajes.push({ role: "user", text: texto })
  const visibles: LlamadaVisible[] = []

  for (let i = 0; i < deps.limites.maxIteraciones; i++) {
    let res
    try {
      res = await deps.llm.enviar(deps.system, s.mensajes, specs())
    } catch (e) {
      const msg = e instanceof LlmError ? e.message : "Error inesperado al llamar al modelo."
      return cerrar(s, `No pude completar la respuesta: ${msg} La sesión sigue activa.`, visibles, true)
    }
    s.tokens += res.usage.input + res.usage.output
    s.mensajes.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls, raw: res.raw })

    if (res.stop === "refusal") return cerrar(s, "El modelo declinó esta petición. Reformúlala o procesa el caso de nuevo.", visibles, true, false)
    if (res.toolCalls.length === 0) {
      const aviso = res.stop === "max_tokens" ? "\n\n(La respuesta se cortó por longitud.)" : ""
      return cerrar(s, (res.text || "(sin respuesta)") + aviso, visibles, false, false)
    }

    const ejecuciones: Ejecucion[] = []
    for (const call of res.toolCalls) ejecuciones.push(await ejecutar(call.name, call.input, ctx))
    s.mensajes.push({
      role: "tool",
      results: ejecuciones.map((e, k) => ({ callId: res.toolCalls[k].id, content: e.output, isError: !e.ok })),
    })
    for (const e of ejecuciones) {
      actualizarPendientes(s, e)
      visibles.push({ name: e.name, input: e.input, ok: e.ok, resumen: e.resumen, data: e.data })
    }
  }

  const tope = `Alcancé el tope de ${deps.limites.maxIteraciones} pasos en este turno. Lo hecho está en las llamadas de arriba; pídeme continuar para terminar lo que falta.`
  return cerrar(s, tope, visibles, false, true)
}

function actualizarPendientes(s: Sesion, e: Ejecucion): void {
  const input = e.input as { caso?: unknown }
  if (typeof input?.caso !== "string") return
  const caso = normalizarCaso(input.caso)
  const d = e.data as { requiere_confirmacion?: boolean; numero_oc?: string; apta?: boolean }
  if (e.name === "oc_crear" && e.ok) s.pendientes.delete(caso)
  else if (d?.requiere_confirmacion) s.pendientes.add(caso)
  else if (e.name === "oc_validar" && e.ok && !d?.requiere_confirmacion) s.pendientes.delete(caso)
}

function cerrar(s: Sesion, reply: string, toolCalls: LlamadaVisible[], error: boolean, agregarAlModelo = true): RespuestaTurno {
  // El texto de cierre del servidor también entra al historial del modelo para mantener la alternancia.
  if (agregarAlModelo) s.mensajes.push({ role: "assistant", text: reply, toolCalls: [] })
  const needsConfirmation = !error && s.pendientes.size > 0
  s.historial.push({ role: "assistant", text: reply, toolCalls, needsConfirmation, error })
  return { reply, toolCalls, needsConfirmation, error }
}
