// Interfaz neutra del proveedor LLM. El ciclo del agente solo conoce estos tipos.
import type { ToolSpec } from "../tools/registro.ts"

export type ToolCall = { id: string; name: string; input: unknown }

export type Mensaje =
  | { role: "user"; text: string }
  /** raw: contenido nativo del proveedor, se reenvía intacto (p. ej. bloques de thinking). */
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: "tool"; results: { callId: string; content: string; isError: boolean }[] }

export type Respuesta = {
  text: string
  toolCalls: ToolCall[]
  raw: unknown
  stop: "end" | "tool_use" | "max_tokens" | "refusal"
  usage: { input: number; output: number }
}

export interface LlmAdapter {
  readonly provider: string
  readonly model: string
  enviar(system: string, mensajes: Mensaje[], herramientas: ToolSpec[]): Promise<Respuesta>
}

/** Error del proveedor con un mensaje que se puede mostrar en el chat. */
export class LlmError extends Error {}
