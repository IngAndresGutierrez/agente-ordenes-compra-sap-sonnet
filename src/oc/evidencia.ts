// Evidencia de aprobación: texto canónico del correo + sha256 (P0) y PDF (P1).
import { createHash } from "node:crypto"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import type { AprobacionRaw } from "./schemas.ts"

/** Texto canónico del correo. El sha256 se calcula sobre exactamente este contenido. */
export function textoEvidencia(a: AprobacionRaw): string {
  return [
    `De: ${a.de}`,
    `Para: ${a.para ?? ""}`,
    ...(a.cc?.length ? [`CC: ${a.cc.join(", ")}`] : []),
    `Fecha: ${a.fecha}`,
    `Asunto: ${a.asunto}`,
    "",
    a.cuerpo,
  ].join("\n")
}

export function sha256(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex")
}

export async function pdfEvidencia(contenido: string, hash: string, caso: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(`Evidencia de aprobación ${caso}`)
  // Fecha fija: el PDF debe ser reproducible para el mismo correo.
  doc.setCreationDate(new Date(0))
  doc.setModificationDate(new Date(0))
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const page = doc.addPage([595, 842])
  let y = 790
  page.drawText("Evidencia de aprobación de orden de compra", { x: 50, y, size: 15, font: bold })
  y -= 20
  page.drawText(`Caso ${caso}`, { x: 50, y, size: 10, font, color: rgb(0.35, 0.35, 0.4) })
  y -= 30
  for (const linea of contenido.split("\n")) {
    for (const trozo of partir(linea, 90)) {
      page.drawText(trozo, { x: 50, y, size: 11, font })
      y -= 16
    }
  }
  y -= 20
  page.drawText("SHA-256 del contenido:", { x: 50, y, size: 9, font: bold })
  page.drawText(hash, { x: 50, y: y - 14, size: 8, font })
  return doc.save()
}

function partir(linea: string, ancho: number): string[] {
  if (linea.length <= ancho) return [linea]
  const partes: string[] = []
  for (let i = 0; i < linea.length; i += ancho) partes.push(linea.slice(i, i + ancho))
  return partes
}
