// Registros de auditoría: out/control.csv (cada intento de crear OC) y out/log.jsonl (cada herramienta).
import { appendFile, mkdir, stat } from "node:fs/promises"
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
