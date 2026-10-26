// Construcción de la OC (PRD §7.4) con trazabilidad campo → fuente.
import type { Validacion } from "./controles.ts"
import { OrdenCompraSchema, type OrdenCompra, type Paquete } from "./schemas.ts"

export const LARGO_TEXTO_BREVE = 40 // límite SAP del texto breve de posición

export type Trazabilidad = Record<string, string>

export function inferirUnidad(descripcion: string): "UN" | "H" | "MES" {
  if (/\bhoras?\b/i.test(descripcion)) return "H"
  if (/\b(mensual|mensualidad|por mes)\b/i.test(descripcion)) return "MES"
  return "UN"
}

export function textoBreve(descripcion: string): string {
  const limpio = descripcion.replace(/\s+/g, " ").trim()
  return limpio.length <= LARGO_TEXTO_BREVE ? limpio : `${limpio.slice(0, LARGO_TEXTO_BREVE - 1).trimEnd()}…`
}

/** Valor resuelto desde la solicitud o, si falta, desde un derivado del maestro. */
function resolver(campo: string, valorSolicitud: string | undefined, v: Validacion): { valor: string; fuente: string } | null {
  if (valorSolicitud) return { valor: valorSolicitud, fuente: `solicitud.${campo}` }
  const d = v.derivados.find((x) => x.campo === campo)
  return d ? { valor: d.valor, fuente: `derivado (${d.fuente})` } : null
}

export function construirPayload(
  p: Paquete,
  v: Validacion,
  evidenciaSha: string,
  confirmadoPor: string | null,
): { orden: OrdenCompra; trazabilidad: Trazabilidad } | { error: string } {
  if (!v.apta || !v.proveedor) {
    return { error: `la OC no es apta: ${v.bloqueos.map((b) => `${b.codigo} ${b.detalle}`).join(" | ")}` }
  }
  if (!p.aprobacion) return { error: "no hay aprobación para referenciar en la OC" }
  const s = p.solicitud
  const iva = resolver("indicador_iva", s.indicador_iva, v)
  const pago = resolver("condiciones_pago", s.condiciones_pago, v)
  if (!iva || !pago) return { error: "no se pudo resolver el indicador de IVA o las condiciones de pago" }

  const orden: OrdenCompra = {
    referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo.id, cotizacion_ref: p.cotizacion?.referencia ?? null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: v.proveedor.codigo_sap, nit: v.proveedor.nit, nombre: v.proveedor.nombre },
    moneda: s.moneda,
    condiciones_pago: pago.valor,
    aprobador: { email: p.aprobacion.de, fecha_aprobacion: p.aprobacion.fecha, evidencia_sha256: evidenciaSha },
    posiciones: [
      {
        numero: 10,
        descripcion: textoBreve(s.descripcion),
        cantidad: s.cantidad,
        unidad: inferirUnidad(s.descripcion),
        precio_unitario: s.valor_unitario,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: iva.valor,
      },
    ],
    excepciones: v.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: confirmadoPor })),
  }

  const r = OrdenCompraSchema.safeParse(orden)
  if (!r.success) return { error: `payload inválido: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }

  const trazabilidad: Trazabilidad = {
    "referencia.solicitud_id": "solicitud.solicitud_id",
    "referencia.correo_id": "correo.id",
    "referencia.cotizacion_ref": p.cotizacion ? "cotizacion (encabezado COTIZACIÓN)" : "sin cotización",
    sociedad: "constante (sociedad 1000)",
    organizacion_compras: "constante (organización de compras 1000)",
    "proveedor.codigo_sap": v.fuente_proveedor ?? "maestro.proveedores",
    "proveedor.nit": "maestro.proveedores.nit",
    "proveedor.nombre": "maestro.proveedores.nombre",
    moneda: "solicitud.moneda",
    condiciones_pago: pago.fuente,
    "aprobador.email": "aprobacion.de",
    "aprobador.fecha_aprobacion": "aprobacion.fecha",
    "aprobador.evidencia_sha256": "derivado (sha256 de la evidencia de aprobación)",
    "posiciones[0].numero": "constante (primera posición = 10)",
    "posiciones[0].descripcion": `solicitud.descripcion (texto breve ≤ ${LARGO_TEXTO_BREVE})`,
    "posiciones[0].cantidad": "solicitud.cantidad",
    "posiciones[0].unidad": "derivado (inferido de solicitud.descripcion)",
    "posiciones[0].precio_unitario": "solicitud.valor_unitario",
    "posiciones[0].centro_costo": "solicitud.centro_costo",
    "posiciones[0].subarea": "solicitud.subarea",
    "posiciones[0].indicador_iva": iva.fuente,
    excepciones: "oc_validar (confirmaciones RC5/RC6/RC8/RC9)",
  }
  return { orden: r.data, trazabilidad }
}
