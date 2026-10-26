import Anthropic from "@anthropic-ai/sdk"
import type { ToolSpec } from "../tools/registro.ts"
import { LlmError, type LlmAdapter, type Mensaje, type Respuesta } from "./adapter.ts"

type Effort = "low" | "medium" | "high" | "xhigh" | "max"

export class AnthropicAdapter implements LlmAdapter {
  readonly provider = "anthropic"
  private readonly client: Anthropic

  constructor(
    readonly model: string,
    private readonly opciones: { timeoutMs: number; maxTokens: number; effort: Effort },
  ) {
    // La clave se lee de ANTHROPIC_API_KEY dentro del SDK; nunca pasa por este código.
    this.client = new Anthropic({ timeout: opciones.timeoutMs, maxRetries: 1 })
  }

  async enviar(system: string, mensajes: Mensaje[], herramientas: ToolSpec[]): Promise<Respuesta> {
    let res: Anthropic.Beta.BetaMessage
    try {
      res = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: this.opciones.maxTokens,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: herramientas.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
        })),
        messages: aMensajesAnthropic(mensajes),
        output_config: { effort: this.opciones.effort },
        // Si un clasificador rechaza la petición, Anthropic la reintenta en el modelo recomendado.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      })
    } catch (e) {
      throw new LlmError(describirError(e))
    }

    const toolCalls = res.content
      .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }))
    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
    const stop =
      res.stop_reason === "tool_use" ? "tool_use"
      : res.stop_reason === "max_tokens" ? "max_tokens"
      : res.stop_reason === "refusal" ? "refusal"
      : "end"
    return { text, toolCalls, raw: res.content, stop, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens } }
  }
}

function aMensajesAnthropic(mensajes: Mensaje[]): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = []
  const pushUser = (content: Anthropic.Beta.BetaContentBlockParam[]) => {
    const prev = out.at(-1)
    // La API exige alternancia; si quedan dos turnos de usuario seguidos (p. ej. tras un error), se fusionan.
    if (prev?.role === "user" && Array.isArray(prev.content)) prev.content.push(...content)
    else out.push({ role: "user", content })
  }
  for (const m of mensajes) {
    if (m.role === "user") pushUser([{ type: "text", text: m.text }])
    else if (m.role === "tool") {
      pushUser(m.results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.callId, content: r.content, is_error: r.isError })))
    } else {
      const content = (m.raw as Anthropic.Beta.BetaContentBlockParam[] | undefined) ?? [{ type: "text" as const, text: m.text || "(sin texto)" }]
      out.push({ role: "assistant", content })
    }
  }
  return out
}

function describirError(e: unknown): string {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return "El modelo tardó demasiado en responder (timeout). Intenta de nuevo."
  if (e instanceof Anthropic.AuthenticationError) return "El servidor no tiene una clave válida del proveedor LLM."
  if (e instanceof Anthropic.RateLimitError) return "El proveedor LLM está limitando las peticiones. Espera un momento e intenta de nuevo."
  if (e instanceof Anthropic.APIConnectionError) return "No hay conexión con el proveedor LLM."
  if (e instanceof Anthropic.APIError) return `El proveedor LLM respondió con error ${e.status ?? ""}.`.trim()
  return "Error inesperado al llamar al modelo."
}
