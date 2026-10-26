// API HTTP + front estático. Un solo proceso para desplegar en Railway/Render.
import { randomUUID } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { extname, join, normalize, resolve, sep } from "node:path"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { Hono } from "hono"
import { z } from "zod"
import { nuevaSesion, turno, type Sesion } from "./agent/ciclo.ts"
import { AnthropicAdapter } from "./llm/anthropic.ts"
import { leerPaquete, listarCasos } from "./oc/fuentes.ts"

const ROOT = process.cwd()
const env = (k: string, d: string) => process.env[k] || d

const config = {
  port: Number(env("PORT", "3000")),
  model: env("LLM_MODEL", "claude-sonnet-5-5"),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).parse(env("LLM_EFFORT", "medium")),
  timeoutMs: Number(env("LLM_TIMEOUT_MS", "90000")),
  maxTokensRespuesta: Number(env("LLM_MAX_TOKENS", "16000")),
  maxIteraciones: Number(env("MAX_ITERACIONES", "25")),
  maxTokensSesion: Number(env("MAX_TOKENS_SESION", "200000")),
  maxSesiones: Number(env("MAX_SESIONES", "200")),
  accessKey: process.env.ACCESS_KEY ?? "",
}

const system = [
  await readFile(join(ROOT, "agent/prompt.md"), "utf8"),
  await readFile(join(ROOT, "src/knowledge/ordenes-compra.md"), "utf8"),
].join("\n\n")

const llm = new AnthropicAdapter(config.model, { timeoutMs: config.timeoutMs, maxTokens: config.maxTokensRespuesta, effort: config.effort })
const sesiones = new Map<string, Sesion>()
const ocupadas = new Set<string>()

const app = new Hono()

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health" || !config.accessKey) return next()
  if (c.req.header("x-access-key") !== config.accessKey) return c.json({ error: "Clave de acceso inválida." }, 401)
  return next()
})

app.get("/api/health", (c) => c.json({ ok: true, provider: llm.provider, model: llm.model, protegido: Boolean(config.accessKey) }))

app.get("/api/casos", async (c) => {
  const casos = await Promise.all(
    (await listarCasos(ROOT)).map(async (caso) => {
      try {
        const p = await leerPaquete(ROOT, caso)
        return { caso, solicitud_id: p.solicitud.solicitud_id, descripcion: p.solicitud.descripcion, valor: p.solicitud.valor_total, moneda: p.solicitud.moneda }
      } catch {
        return { caso, solicitud_id: caso, descripcion: "(paquete ilegible)", valor: 0, moneda: "" }
      }
    }),
  )
  return c.json({ casos })
})

const ChatBody = z.object({ sessionId: z.string().min(1).max(100).optional(), message: z.string().trim().min(1).max(4000) })

app.post("/api/chat", async (c) => {
  const body = ChatBody.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: "Envía { sessionId?, message } con un mensaje de hasta 4000 caracteres." }, 400)

  const id = body.data.sessionId ?? randomUUID()
  let s = sesiones.get(id)
  if (!s) {
    if (sesiones.size >= config.maxSesiones) sesiones.delete(sesiones.keys().next().value as string)
    s = nuevaSesion(id)
    sesiones.set(id, s)
  }
  if (ocupadas.has(id)) return c.json({ error: "Esta sesión ya está procesando un mensaje." }, 409)
  ocupadas.add(id)
  try {
    const r = await turno(s, body.data.message, {
      llm,
      system,
      directory: ROOT,
      limites: { maxIteraciones: config.maxIteraciones, maxTokensSesion: config.maxTokensSesion },
    })
    return c.json({ sessionId: id, ...r, tokensSesion: s.tokens })
  } finally {
    ocupadas.delete(id)
  }
})

app.get("/api/sessions/:id", (c) => {
  const s = sesiones.get(c.req.param("id"))
  if (!s) return c.json({ error: "Sesión no encontrada." }, 404)
  return c.json({ sessionId: s.id, tokens: s.tokens, pendientes: [...s.pendientes], historial: s.historial })
})

// Archivos generados en out/ (evidencia, trazabilidad, control.csv, ordenes.jsonl). Solo lectura.
const TIPOS: Record<string, string> = { ".pdf": "application/pdf", ".json": "application/json", ".jsonl": "text/plain", ".csv": "text/plain", ".txt": "text/plain" }
app.get("/api/archivos", async (c) => {
  const base = resolve(ROOT, "out")
  const ruta = resolve(ROOT, normalize(c.req.query("ruta") ?? ""))
  if (!ruta.startsWith(base + sep) || !TIPOS[extname(ruta)]) return c.json({ error: "Ruta no permitida." }, 400)
  try {
    return c.body(await readFile(ruta), 200, { "content-type": `${TIPOS[extname(ruta)]}; charset=utf-8` })
  } catch {
    return c.json({ error: "El archivo aún no existe." }, 404)
  }
})

app.post("/api/reiniciar", async (c) => {
  await rm(join(ROOT, "out"), { recursive: true, force: true })
  sesiones.clear()
  return c.json({ ok: true })
})

app.use("/*", serveStatic({ root: "./web" }))

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`OC agent en http://localhost:${info.port} · ${llm.provider}/${llm.model} · effort ${config.effort}`)
})
