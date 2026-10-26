// Registros de auditoría: out/control.csv (cada intento de crear OC) y out/log.jsonl (cada herramienta).
import { appendFile, mkdir, readFile, stat } from "node:fs/promises"
import { dirname, join } from "node:path"

export type FilaControl = {
  solicitud_id: string
  resultado: "creada" | "existente" | "bloqueada" | "pendiente_confirmacion" | "error"
  numero_oc: string
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
  ts: string
}

const COLUMNAS = ["solicitud_id", "resultado", "numero_oc", "retroactiva", "bloqueos", "confirmaciones", "ts"] as const

function celda(v: string): string {
  return /[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

async function existe(ruta: string): Promise<boolean> {
  try {
    await stat(ruta)
    return true
  } catch {
    return false
  }
}

export async function registrarControl(root: string, f: FilaControl): Promise<void> {
  const ruta = join(root, "out/control.csv")
  await mkdir(dirname(ruta), { recursive: true })
  if (!(await existe(ruta))) await appendFile(ruta, `${COLUMNAS.join(",")}\n`)
  const valores = [f.solicitud_id, f.resultado, f.numero_oc, String(f.retroactiva), f.bloqueos.join(";"), f.confirmaciones.join(";"), f.ts]
  await appendFile(ruta, `${valores.map(celda).join(",")}\n`)
}

export type EntradaLog = { ts: string; sesion: string; herramienta: string; caso: string | null; ok: boolean; resumen: string }

export async function registrarLog(root: string, e: EntradaLog): Promise<void> {
  const ruta = join(root, "out/log.jsonl")
  await mkdir(dirname(ruta), { recursive: true })
  await appendFile(ruta, `${JSON.stringify(e)}\n`)
}

/** Divide una línea CSV respetando comillas dobles (formato que escribe registrarControl). */
function partirCsv(linea: string): string[] {
  const celdas: string[] = []
  let actual = ""
  let enComillas = false
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i]
    if (enComillas && c === '"' && linea[i + 1] === '"') {
      actual += '"'
      i++
    } else if (c === '"') enComillas = !enComillas
    else if (c === "," && !enComillas) {
      celdas.push(actual)
      actual = ""
    } else actual += c
  }
  celdas.push(actual)
  return celdas
}

export async function leerControl(root: string): Promise<FilaControl[]> {
  let texto: string
  try {
    texto = await readFile(join(root, "out/control.csv"), "utf8")
  } catch {
    return []
  }
  return texto
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((l) => {
      const [solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts] = partirCsv(l)
      const lista = (s: string) => (s ? s.split(";") : [])
      return { solicitud_id, resultado: resultado as FilaControl["resultado"], numero_oc, retroactiva: retroactiva === "true", bloqueos: lista(bloqueos), confirmaciones: lista(confirmaciones), ts }
    })
}

export type ResumenControl = {
  totales: { intentos: number; creadas: number; bloqueadas: number; pendientes: number; retroactivas: number }
  /** Último estado conocido por solicitud: si alguna vez se creó la OC, gana "creada". */
  porSolicitud: Record<string, { resultado: FilaControl["resultado"]; numero_oc: string; retroactiva: boolean; bloqueos: string[]; confirmaciones: string[] }>
}

export function resumirControl(filas: FilaControl[]): ResumenControl {
  const porSolicitud: ResumenControl["porSolicitud"] = {}
  for (const f of filas) {
    const previo = porSolicitud[f.solicitud_id]
    const creada = (r?: string) => r === "creada" || r === "existente"
    if (previo && creada(previo.resultado) && !creada(f.resultado)) continue
    porSolicitud[f.solicitud_id] = { resultado: creada(f.resultado) ? "creada" : f.resultado, numero_oc: f.numero_oc || previo?.numero_oc || "", retroactiva: f.retroactiva, bloqueos: f.bloqueos, confirmaciones: f.confirmaciones }
  }
  const estados = Object.values(porSolicitud)
  return {
    totales: {
      intentos: filas.length,
      creadas: estados.filter((e) => e.resultado === "creada").length,
      bloqueadas: estados.filter((e) => e.resultado === "bloqueada").length,
      pendientes: estados.filter((e) => e.resultado === "pendiente_confirmacion").length,
      retroactivas: estados.filter((e) => e.resultado === "creada" && e.retroactiva).length,
    },
    porSolicitud,
  }
}
