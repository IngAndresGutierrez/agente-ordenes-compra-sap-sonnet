import assert from "node:assert/strict"
import { mkdtemp, cp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"
import { esConfirmacion, nuevaSesion, turno } from "../src/agent/ciclo.ts"
import type { LlmAdapter, Mensaje, Respuesta } from "../src/llm/adapter.ts"
import { validar } from "../src/oc/controles.ts"
import { leerMaestros, leerPaquete } from "../src/oc/fuentes.ts"
import { leerControl, resumirControl } from "../src/oc/registro.ts"
import { ejecutar } from "../src/tools/registro.ts"

let root: string
before(async () => {
  root = await mkdtemp(join(tmpdir(), "oc-"))
  await cp(join(process.cwd(), "fixtures"), join(root, "fixtures"), { recursive: true })
})
after(() => rm(root, { recursive: true, force: true }))

const validarCaso = async (caso: string) => validar(await leerPaquete(root, caso), await leerMaestros(root))
const cods = (xs: { codigo: string }[]) => xs.map((x) => x.codigo)

describe("controles RC1–RC10 por caso", () => {
  test("sol-001 apta sin confirmaciones", async () => {
    const v = await validarCaso("sol-001")
    assert.equal(v.apta, true)
    assert.deepEqual(cods(v.confirmaciones), [])
  })
  test("sol-002 bloqueada por proveedor inexistente (RC1)", async () => {
    assert.deepEqual(cods((await validarCaso("sol-002")).bloqueos), ["RC1"])
  })
  test("sol-003 bloqueada por aprobador sin autoridad (RC2, RC3)", async () => {
    assert.deepEqual(cods((await validarCaso("sol-003")).bloqueos), ["RC2", "RC3"])
  })
  test("sol-004 pide confirmar la diferencia de cotización (RC5)", async () => {
    const v = await validarCaso("sol-004")
    assert.equal(v.apta, true)
    assert.deepEqual(cods(v.confirmaciones), ["RC5"])
  })
  test("sol-005 retroactiva con confirmación (RC8)", async () => {
    const v = await validarCaso("sol-005")
    assert.equal(v.retroactiva, true)
    assert.deepEqual(cods(v.confirmaciones), ["RC8"])
  })
  test("sol-006 deriva IVA (RC6) y condiciones de pago (RC7)", async () => {
    const v = await validarCaso("sol-006")
    assert.deepEqual(cods(v.confirmaciones), ["RC6"])
    assert.deepEqual(v.derivados.map((d) => `${d.campo}=${d.valor}`), ["indicador_iva=C1", "condiciones_pago=Z030"])
  })
})

describe("herramientas", () => {
  const ctx = () => ({ directory: root, sessionId: "t", confirmacionHumana: true })
  test("oc_crear es idempotente", async () => {
    const a = await ejecutar("oc_crear", { caso: "sol-001" }, ctx())
    const b = await ejecutar("oc_crear", { caso: "SOL-2026-001" }, ctx())
    assert.equal((a.data as { numero_oc: string }).numero_oc, (b.data as { numero_oc: string }).numero_oc)
    assert.equal((b.data as { idempotente: boolean }).idempotente, true)
  })
  test("oc_crear rechaza un payload alterado por el modelo", async () => {
    const p = await ejecutar("oc_construir_payload", { caso: "sol-006" }, ctx())
    const orden = structuredClone((p.data as { orden: { posiciones: { precio_unitario: number }[] } }).orden)
    orden.posiciones[0].precio_unitario = 1
    const r = await ejecutar("oc_crear", { caso: "sol-006", confirmado: true, payload: orden }, ctx())
    assert.equal(r.ok, false)
    assert.match(r.resumen, /no coincide/)
  })
  test("el resumen de control cuenta una OC por solicitud aunque se repita el intento", async () => {
    await ejecutar("oc_crear", { caso: "sol-002" }, ctx())
    const r = resumirControl(await leerControl(root))
    assert.equal(r.porSolicitud["SOL-2026-001"].resultado, "creada")
    assert.equal(r.porSolicitud["SOL-2026-002"].resultado, "bloqueada")
    assert.deepEqual(r.porSolicitud["SOL-2026-002"].bloqueos, ["RC1"])
    assert.equal(r.totales.creadas, 1)
    assert.equal(r.totales.bloqueadas, 1)
  })
  test("caso inexistente y argumentos inválidos no lanzan", async () => {
    assert.equal((await ejecutar("oc_leer_paquete", { caso: "sol-999" }, ctx())).ok, false)
    assert.equal((await ejecutar("oc_validar", { caso: 42 }, ctx())).ok, false)
    assert.equal((await ejecutar("oc_inexistente", {}, ctx())).ok, false)
  })
})

/** LLM guionado: cada enviar() devuelve la siguiente respuesta. */
class LlmGuion implements LlmAdapter {
  readonly provider = "guion"
  readonly model = "guion"
  vistos: Mensaje[][] = []
  constructor(private pasos: Partial<Respuesta>[]) {}
  async enviar(_s: string, m: Mensaje[]): Promise<Respuesta> {
    this.vistos.push(structuredClone(m))
    const p = this.pasos.shift() ?? { text: "fin" }
    return { text: "", toolCalls: [], raw: undefined, stop: p.toolCalls?.length ? "tool_use" : "end", usage: { input: 10, output: 10 }, ...p }
  }
}

describe("ciclo del agente", () => {
  const limites = { maxIteraciones: 25, maxTokensSesion: 100_000 }

  test("no deja crear con confirmado=true en el mismo turno; sí tras confirmación explícita", async () => {
    const s = nuevaSesion("c1")
    const llm = new LlmGuion([
      { toolCalls: [{ id: "1", name: "oc_validar", input: { caso: "sol-004" } }] },
      { toolCalls: [{ id: "2", name: "oc_crear", input: { caso: "sol-004", confirmado: true } }] },
      { text: "¿Confirmas crear la OC de sol-004 por COP 25.000.000?" },
      { toolCalls: [{ id: "3", name: "oc_crear", input: { caso: "sol-004", confirmado: true } }] },
      { text: "OC creada." },
    ])
    const deps = { llm, system: "", directory: root, limites }

    const t1 = await turno(s, "Procesa sol-004, no la crees sin mi confirmación", deps)
    assert.equal(t1.needsConfirmation, true)
    assert.equal(t1.toolCalls[1].ok, false, "oc_crear debe fallar sin confirmación humana")

    const t2 = await turno(s, "Confirmo, créala", deps)
    assert.equal(t2.toolCalls[0].ok, true)
    assert.equal(t2.needsConfirmation, false)
  })

  test("respeta el tope de iteraciones", async () => {
    const s = nuevaSesion("c2")
    const bucle = Array.from({ length: 10 }, (_, i) => ({ toolCalls: [{ id: String(i), name: "oc_leer_paquete", input: { caso: "sol-001" } }] }))
    const r = await turno(s, "hola", { llm: new LlmGuion(bucle), system: "", directory: root, limites: { ...limites, maxIteraciones: 3 } })
    assert.match(r.reply, /tope de 3 pasos/)
    assert.equal(r.toolCalls.length, 3)
  })

  test("un error del proveedor no mata la sesión", async () => {
    const s = nuevaSesion("c3")
    const llm: LlmAdapter = { provider: "x", model: "x", enviar: async () => { throw new Error("boom") } }
    const r = await turno(s, "hola", { llm, system: "", directory: root, limites })
    assert.equal(r.error, true)
    assert.match(r.reply, /La sesión sigue activa/)
  })

  test("detecta confirmaciones explícitas", () => {
    assert.equal(esConfirmacion("Confirmo"), true)
    assert.equal(esConfirmacion("sí, créala"), true)
    assert.equal(esConfirmacion("no la crees todavía"), false)
    assert.equal(esConfirmacion("muéstrame el payload"), false)
  })
})
