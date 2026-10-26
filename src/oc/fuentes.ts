// Lectura de fixtures (solo lectura): paquete de cada solicitud y maestros.
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import {
  AprobacionRawSchema,
  CorreoSchema,
  SolicitudSchema,
  type AprobacionRaw,
  type Paquete,
} from "./schemas.ts"
import { parseCotizacion, parseFactura, soloFecha } from "./textos.ts"

const FIXTURES = "fixtures/reto-03"

const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
})
const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string(),
  subareas: z.array(z.string()),
  aprobadores: z.array(z.object({ email: z.string(), nombre: z.string(), tope: z.number() })),
})
const CodigoSchema = z.object({ codigo: z.string(), descripcion: z.string() })

export type Proveedor = z.infer<typeof ProveedorSchema>
export type CentroCosto = z.infer<typeof CentroCostoSchema>
export type Maestros = {
  proveedores: Proveedor[]
  centros: CentroCosto[]
  indicadoresIva: z.infer<typeof CodigoSchema>[]
  condicionesPago: z.infer<typeof CodigoSchema>[]
}

/** Error de lectura con un mensaje que se puede mostrar a la analista tal cual. */
export class FuenteError extends Error {}

async function leerTexto(ruta: string): Promise<string | null> {
  try {
    return await readFile(ruta, "utf8")
  } catch {
    return null
  }
}

async function leerJson<T>(ruta: string, schema: z.ZodType<T>, nombre: string): Promise<T | null> {
  const texto = await leerTexto(ruta)
  if (texto === null) return null
  let crudo: unknown
  try {
    crudo = JSON.parse(texto)
  } catch {
    throw new FuenteError(`${nombre} no es un JSON válido (archivo malformado)`)
  }
  const r = schema.safeParse(crudo)
  if (!r.success) {
    const detalle = r.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
    throw new FuenteError(`${nombre} tiene datos inválidos → ${detalle}`)
  }
  return r.data
}

/** Acepta "sol-004", "SOL-004", "SOL-2026-004" o "4". */
export function normalizarCaso(caso: string): string {
  const m = caso.trim().match(/(\d{1,3})\s*$/)
  return m ? `sol-${m[1].padStart(3, "0")}` : caso.trim().toLowerCase()
}

export async function listarCasos(root: string): Promise<string[]> {
  const dirs = await readdir(join(root, FIXTURES, "solicitudes"), { withFileTypes: true })
  return dirs.filter((d) => d.isDirectory()).map((d) => d.name).sort()
}

export async function leerAprobacionRaw(root: string, caso: string): Promise<AprobacionRaw | null> {
  return leerJson(join(root, FIXTURES, "solicitudes", caso, "aprobacion.json"), AprobacionRawSchema, "aprobacion.json")
}

export async function leerPaquete(root: string, caso: string): Promise<Paquete> {
  const dir = join(root, FIXTURES, "solicitudes", caso)
  const casos = await listarCasos(root)
  if (!casos.includes(caso)) {
    throw new FuenteError(`el caso "${caso}" no existe. Casos disponibles: ${casos.join(", ")}`)
  }

  const correo = await leerJson(join(dir, "correo.json"), CorreoSchema, "correo.json")
  const solicitud = await leerJson(join(dir, "solicitud.json"), SolicitudSchema, "solicitud.json")
  if (!solicitud) {
    throw new FuenteError("falta solicitud.json: sin el Excel de solicitud no hay datos para la OC")
  }
  const faltantes: string[] = []
  if (!correo) faltantes.push("correo")

  const cotTexto = await leerTexto(join(dir, "cotizacion.txt"))
  let cotizacion: Paquete["cotizacion"] = null
  if (cotTexto === null) faltantes.push("cotizacion")
  else {
    const c = parseCotizacion(cotTexto)
    if ("error" in c) throw new FuenteError(`cotizacion.txt: ${c.error}`)
    cotizacion = c
  }

  const aprobRaw = await leerAprobacionRaw(root, caso)
  if (!aprobRaw) faltantes.push("aprobacion")

  const facTexto = await leerTexto(join(dir, "factura.txt"))
  let factura: Paquete["factura"] = null
  if (facTexto !== null) {
    const f = parseFactura(facTexto)
    if ("error" in f) throw new FuenteError(`factura.txt: ${f.error}`)
    factura = f
  }

  return {
    correo: correo
      ? { id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha }
      : { id: `${caso}-sin-correo`, de: "", asunto: "", fecha: "" },
    solicitud,
    cotizacion,
    aprobacion: aprobRaw
      ? {
          de: aprobRaw.de,
          fecha: soloFecha(aprobRaw.fecha),
          aprobado: /\baprobad[oa]\b/i.test(aprobRaw.cuerpo),
          texto: aprobRaw.cuerpo,
        }
      : null,
    factura,
    faltantes,
  }
}

export async function leerMaestros(root: string): Promise<Maestros> {
  const dir = join(root, FIXTURES, "maestros")
  const req = async <T>(archivo: string, schema: z.ZodType<T>): Promise<T> => {
    const v = await leerJson(join(dir, archivo), schema, archivo)
    if (v === null) throw new FuenteError(`falta el maestro ${archivo}`)
    return v
  }
  return {
    proveedores: await req("proveedores.json", z.array(ProveedorSchema)),
    centros: await req("centros-costo.json", z.array(CentroCostoSchema)),
    indicadoresIva: await req("indicadores-iva.json", z.array(CodigoSchema)),
    condicionesPago: await req("condiciones-pago.json", z.array(CodigoSchema)),
  }
}
