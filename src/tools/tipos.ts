import type { z } from "zod"

export type ToolCtx = {
  /** Raíz del proyecto; todas las rutas se resuelven desde aquí. */
  directory: string
  sessionId: string
  /**
   * true solo si el último mensaje del usuario es una confirmación explícita (lo decide el servidor,
   * no el modelo). demo.ts lo pasa en true para simular a la analista.
   */
  confirmacionHumana?: boolean
}

export type ToolDef<S extends z.ZodRawShape> = {
  description: string
  args: S
  execute(args: z.infer<z.ZodObject<S>>, ctx: ToolCtx): Promise<string>
}

export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: string; [extra: string]: unknown }

export const ok = <T>(data: T): string => JSON.stringify({ ok: true, data })
export const fallo = (error: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ok: false, error, ...extra })
