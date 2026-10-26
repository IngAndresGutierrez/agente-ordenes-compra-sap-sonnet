// Parsers deterministas para los adjuntos que llegan como texto (cotización y factura).
import type { Cotizacion, Factura } from "./schemas.ts"

/** "11.400.000" o "1.234,50" → número. null si no es un monto. */
export function parseMonto(raw: string): number | null {
  const limpio = raw.trim().replace(/\./g, "").replace(",", ".")
  const n = Number(limpio)
  return Number.isFinite(n) ? n : null
}

/** "900.555.111-2" → "900555111" (sin puntos ni dígito de verificación). */
export function normalizarNit(raw: string): string {
  return raw.split("-")[0].replace(/\D/g, "")
}

export function normalizarNombre(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(s\.?a\.?s|s\.?a|ltda|limitada)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

export function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

/** Fecha ISO con o sin hora → "YYYY-MM-DD". */
export function soloFecha(raw: string): string {
  return raw.slice(0, 10)
}

function capturar(texto: string, re: RegExp): string | null {
  return texto.match(re)?.[1]?.trim() ?? null
}

export function parseCotizacion(texto: string): Cotizacion | { error: string } {
  const proveedor = capturar(texto, /^Proveedor:\s*(.+)$/m)
  const totalMatch = texto.match(/^TOTAL[^:\n]*:\s*([A-Z]{3})\s*([\d.,]+)/m)
  if (!proveedor || !totalMatch) {
    return { error: "la cotización no tiene proveedor o TOTAL legibles" }
  }
  const total = parseMonto(totalMatch[2])
  if (total === null) return { error: `el total de la cotización no es numérico: "${totalMatch[2]}"` }

  const fecha = capturar(texto, /^Fecha:\s*(\d{4}-\d{2}-\d{2})/m)
  const nit = capturar(texto, /^NIT:\s*([\d.\-]+)/m)
  const diasValidez = capturar(texto, /^Validez[^:\n]*:\s*(\d+)\s*d[ií]as/im)

  return {
    referencia: capturar(texto, /COTIZACI[ÓO]N\s+(\S+)/),
    fecha,
    proveedor,
    nit: nit ? normalizarNit(nit) : null,
    total,
    moneda: totalMatch[1],
    validez_hasta: fecha && diasValidez ? sumarDias(fecha, Number(diasValidez)) : null,
    texto,
  }
}

export function parseFactura(texto: string): Factura | { error: string } {
  const numero = capturar(texto, /No\.\s*(\S+)/)
  const fecha = capturar(texto, /Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/i)
  const totalRaw = capturar(texto, /^TOTAL:\s*[A-Z]{3}\s*([\d.,]+)/m)
  const total = totalRaw ? parseMonto(totalRaw) : null
  if (!numero || !fecha || total === null) {
    return { error: "la factura no tiene número, fecha de emisión o total legibles" }
  }
  return { numero, fecha, total }
}
