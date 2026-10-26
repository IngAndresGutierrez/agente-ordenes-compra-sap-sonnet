// SAP simulado sobre archivos: out/sap/ordenes.jsonl, numeración desde 4500000001.
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { leerMaestros } from "../oc/fuentes.ts"
import type { OrdenCompra } from "../oc/schemas.ts"
import { normalizarNit } from "../oc/textos.ts"
import type { SapAdapter } from "./adapter.ts"

const PRIMER_NUMERO = 4500000001

type Registro = { numero_oc: string; fecha: string; orden: OrdenCompra }

export class SapMock implements SapAdapter {
  private readonly archivo: string
  // Serializa escrituras para que dos peticiones simultáneas no reciban el mismo número.
  private cola: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly root: string,
    private readonly hoy: () => string = () => new Date().toISOString().slice(0, 10),
  ) {
    this.archivo = join(root, "out/sap/ordenes.jsonl")
  }

  private async registros(): Promise<Registro[]> {
    try {
      const texto = await readFile(this.archivo, "utf8")
      return texto.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Registro)
    } catch {
      return []
    }
  }

  async consultarProveedor(nit: string) {
    const { proveedores } = await leerMaestros(this.root)
    const p = proveedores.find((x) => normalizarNit(x.nit) === normalizarNit(nit))
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async buscarOrdenPorReferencia(solicitud_id: string) {
    const r = (await this.registros()).find((x) => x.orden.referencia.solicitud_id === solicitud_id)
    return r ? { numero_oc: r.numero_oc } : null
  }

  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const tarea = this.cola.then(async () => {
      const regs = await this.registros()
      const numero_oc = String(PRIMER_NUMERO + regs.length)
      const fecha = this.hoy()
      await mkdir(dirname(this.archivo), { recursive: true })
      await appendFile(this.archivo, `${JSON.stringify({ numero_oc, fecha, orden })}\n`)
      return { numero_oc, fecha }
    })
    this.cola = tarea.catch(() => undefined)
    return tarea
  }
}
