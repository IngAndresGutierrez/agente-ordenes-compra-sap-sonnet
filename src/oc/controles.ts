// Matriz de controles RC1–RC10 (PRD §7.3). Función pura: paquete + maestros → resultado.
import type { Maestros, Proveedor } from "./fuentes.ts"
import type { Paquete } from "./schemas.ts"
import { normalizarNit, normalizarNombre } from "./textos.ts"

export const TOLERANCIA_COTIZACION = 0.02 // RC5: 2 %
export const TOLERANCIA_ARITMETICA = 1 // RC10: ± 1 unidad monetaria

export type EstadoControl = "ok" | "bloqueo" | "confirmacion" | "derivado"

export type Control = {
  codigo: string
  regla: string
  estado: EstadoControl
  detalle: string
  accion_sugerida?: string
}

export type Derivado = { campo: string; valor: string; fuente: string }

export type Validacion = {
  apta: boolean
  retroactiva: boolean
  controles: Control[]
  bloqueos: Control[]
  confirmaciones: Control[]
  derivados: Derivado[]
  proveedor: Proveedor | null
  fuente_proveedor: string | null
}

const fmt = (n: number) => n.toLocaleString("es-CO")

function buscarProveedor(p: Paquete, m: Maestros): { prov: Proveedor | null; via: string } {
  const nit = p.solicitud.proveedor_nit ?? p.cotizacion?.nit ?? null
  if (nit) {
    const prov = m.proveedores.find((x) => normalizarNit(x.nit) === normalizarNit(nit)) ?? null
    const origen = p.solicitud.proveedor_nit ? "solicitud" : "cotizacion"
    return { prov, via: `NIT ${nit} (${origen})` }
  }
  const nombre = normalizarNombre(p.solicitud.proveedor_nombre)
  const prov = m.proveedores.find((x) => normalizarNombre(x.nombre) === nombre) ?? null
  return { prov, via: `nombre "${p.solicitud.proveedor_nombre}"` }
}

export function validar(p: Paquete, m: Maestros): Validacion {
  const s = p.solicitud
  const controles: Control[] = []
  const derivados: Derivado[] = []
  const add = (c: Control) => controles.push(c)

  // RC1 — proveedor existe y está activo
  const { prov, via } = buscarProveedor(p, m)
  if (!prov) {
    add({
      codigo: "RC1",
      regla: "Proveedor existe en el maestro y está activo",
      estado: "bloqueo",
      detalle: `"${s.proveedor_nombre}" no existe en el maestro de proveedores (búsqueda por ${via}).`,
      accion_sugerida: "Pedir a compras la creación del proveedor en SAP (RUT, certificación bancaria) antes de reenviar la solicitud.",
    })
  } else if (!prov.activo) {
    add({
      codigo: "RC1",
      regla: "Proveedor existe en el maestro y está activo",
      estado: "bloqueo",
      detalle: `${prov.nombre} (SAP ${prov.codigo_sap}) está inactivo.`,
      accion_sugerida: "Reactivar el proveedor en SAP o cotizar con un proveedor activo.",
    })
  } else {
    add({
      codigo: "RC1",
      regla: "Proveedor existe en el maestro y está activo",
      estado: "ok",
      detalle: `${prov.nombre} → SAP ${prov.codigo_sap}, activo (por ${via}).`,
    })
  }

  // RC2 / RC3 — aprobación válida, de un aprobador del centro y dentro de su tope
  const centro = m.centros.find((c) => c.centro_costo === s.centro_costo) ?? null
  const ap = p.aprobacion
  const aprobador = centro && ap ? centro.aprobadores.find((a) => a.email.toLowerCase() === ap.de.toLowerCase()) : undefined
  const listaAprobadores = centro?.aprobadores.map((a) => `${a.email} (tope ${fmt(a.tope)})`).join(", ") ?? "—"

  if (!ap) {
    add({ codigo: "RC2", regla: "Aprobación existe, dice \"Aprobado\" y viene de un aprobador del centro", estado: "bloqueo", detalle: "No llegó el correo de aprobación del líder.", accion_sugerida: "Pedir al solicitante que reenvíe el correo de aprobación." })
  } else if (!centro) {
    add({ codigo: "RC2", regla: "Aprobación existe, dice \"Aprobado\" y viene de un aprobador del centro", estado: "bloqueo", detalle: `El centro de costo ${s.centro_costo} no existe en el maestro.`, accion_sugerida: "Pedir al solicitante el centro de costo correcto." })
  } else if (!ap.aprobado) {
    add({ codigo: "RC2", regla: "Aprobación existe, dice \"Aprobado\" y viene de un aprobador del centro", estado: "bloqueo", detalle: `El correo de ${ap.de} no contiene la palabra "Aprobado".`, accion_sugerida: "Pedir una aprobación explícita al líder." })
  } else if (!aprobador) {
    add({ codigo: "RC2", regla: "Aprobación existe, dice \"Aprobado\" y viene de un aprobador del centro", estado: "bloqueo", detalle: `${ap.de} no es aprobador de ${s.centro_costo} (${centro.nombre}). Aprobadores válidos: ${listaAprobadores}.`, accion_sugerida: `Solicitar la aprobación a un aprobador de ${s.centro_costo}.` })
  } else {
    add({ codigo: "RC2", regla: "Aprobación existe, dice \"Aprobado\" y viene de un aprobador del centro", estado: "ok", detalle: `${aprobador.nombre} (${aprobador.email}) es aprobador de ${s.centro_costo}.` })
  }

  if (aprobador) {
    add(
      s.valor_total <= aprobador.tope
        ? { codigo: "RC3", regla: "Valor dentro del tope del aprobador", estado: "ok", detalle: `${fmt(s.valor_total)} ≤ tope ${fmt(aprobador.tope)}.` }
        : { codigo: "RC3", regla: "Valor dentro del tope del aprobador", estado: "bloqueo", detalle: `${fmt(s.valor_total)} supera el tope de ${aprobador.email} (${fmt(aprobador.tope)}).`, accion_sugerida: escalamiento(centro?.aprobadores ?? [], s.valor_total, s.centro_costo) },
    )
  } else {
    add({ codigo: "RC3", regla: "Valor dentro del tope del aprobador", estado: "bloqueo", detalle: `No hay un aprobador válido de ${s.centro_costo} contra el cual medir ${fmt(s.valor_total)}.`, accion_sugerida: escalamiento(centro?.aprobadores ?? [], s.valor_total, s.centro_costo) })
  }

  // RC4 — subárea pertenece al centro
  add(
    centro && centro.subareas.includes(s.subarea)
      ? { codigo: "RC4", regla: "Subárea pertenece al centro de costo", estado: "ok", detalle: `${s.subarea} ∈ ${s.centro_costo}.` }
      : { codigo: "RC4", regla: "Subárea pertenece al centro de costo", estado: "bloqueo", detalle: `"${s.subarea}" no pertenece a ${s.centro_costo}${centro ? ` (válidas: ${centro.subareas.join(", ")})` : ""}.`, accion_sugerida: "Pedir al solicitante la subárea correcta." },
  )

  // RC5 — cotización vs solicitud ≤ 2 %
  if (!p.cotizacion) {
    add({ codigo: "RC5", regla: "Cotización coincide con la solicitud (±2 %)", estado: "confirmacion", detalle: "No llegó cotización; no se puede contrastar el valor.", accion_sugerida: "Confirmar crear la OC sin cotización o pedirla al proveedor." })
  } else {
    const dif = Math.abs(p.cotizacion.total - s.valor_total) / s.valor_total
    const pct = (dif * 100).toFixed(2)
    add(
      dif <= TOLERANCIA_COTIZACION
        ? { codigo: "RC5", regla: "Cotización coincide con la solicitud (±2 %)", estado: "ok", detalle: `Cotización ${fmt(p.cotizacion.total)} vs solicitud ${fmt(s.valor_total)} (dif. ${pct} %).` }
        : { codigo: "RC5", regla: "Cotización coincide con la solicitud (±2 %)", estado: "confirmacion", detalle: `Solicitud ${fmt(s.valor_total)} vs cotización ${fmt(p.cotizacion.total)}: diferencia ${pct} % (> 2 %).`, accion_sugerida: "Confirmar con qué valor se crea la OC (la OC usa el valor de la solicitud aprobada)." },
    )
  }

  // RC6 — indicador IVA
  if (s.indicador_iva) {
    add({ codigo: "RC6", regla: "Indicador de IVA informado", estado: "ok", detalle: `Indicador ${s.indicador_iva} viene en la solicitud.` })
  } else if (prov) {
    derivados.push({ campo: "indicador_iva", valor: prov.indicador_iva_default, fuente: "maestro.proveedores.indicador_iva_default" })
    const desc = m.indicadoresIva.find((i) => i.codigo === prov.indicador_iva_default)?.descripcion ?? ""
    add({ codigo: "RC6", regla: "Indicador de IVA informado", estado: "confirmacion", detalle: `La solicitud no trae IVA; se deriva ${prov.indicador_iva_default} (${desc}) del proveedor.`, accion_sugerida: `Confirmar el indicador ${prov.indicador_iva_default}.` })
  } else {
    add({ codigo: "RC6", regla: "Indicador de IVA informado", estado: "confirmacion", detalle: "La solicitud no trae IVA y no hay proveedor del cual derivarlo.", accion_sugerida: "Pedir el indicador de IVA al solicitante." })
  }

  // RC7 — condiciones de pago (solo informa)
  if (s.condiciones_pago) {
    add({ codigo: "RC7", regla: "Condiciones de pago informadas", estado: "ok", detalle: `${s.condiciones_pago} viene en la solicitud.` })
  } else if (prov) {
    derivados.push({ campo: "condiciones_pago", valor: prov.condiciones_pago_default, fuente: "maestro.proveedores.condiciones_pago_default" })
    const desc = m.condicionesPago.find((c) => c.codigo === prov.condiciones_pago_default)?.descripcion ?? ""
    add({ codigo: "RC7", regla: "Condiciones de pago informadas", estado: "derivado", detalle: `Se derivan ${prov.condiciones_pago_default} (${desc}) del proveedor.` })
  } else {
    add({ codigo: "RC7", regla: "Condiciones de pago informadas", estado: "derivado", detalle: "Sin condiciones de pago ni proveedor del cual derivarlas." })
  }

  // RC8 — factura anterior a la solicitud → retroactiva
  const retroactiva = p.factura !== null && p.factura.fecha < s.fecha_solicitud
  add(
    retroactiva && p.factura
      ? { codigo: "RC8", regla: "OC no es retroactiva (factura posterior a la solicitud)", estado: "confirmacion", detalle: `Factura ${p.factura.numero} del ${p.factura.fecha}, anterior a la solicitud del ${s.fecha_solicitud}: OC retroactiva.`, accion_sugerida: "Confirmar la creación; quedará marcada retroactiva = true en el log de control." }
      : { codigo: "RC8", regla: "OC no es retroactiva (factura posterior a la solicitud)", estado: "ok", detalle: p.factura ? `Factura ${p.factura.numero} del ${p.factura.fecha}, no anterior a la solicitud.` : "No hay factura adjunta." },
  )

  // RC9 — aprobación no anterior a la solicitud
  if (ap) {
    add(
      ap.fecha >= s.fecha_solicitud
        ? { codigo: "RC9", regla: "Aprobación posterior o igual a la solicitud", estado: "ok", detalle: `Aprobada el ${ap.fecha}, solicitud del ${s.fecha_solicitud}.` }
        : { codigo: "RC9", regla: "Aprobación posterior o igual a la solicitud", estado: "confirmacion", detalle: `La aprobación (${ap.fecha}) es anterior a la solicitud (${s.fecha_solicitud}).`, accion_sugerida: "Confirmar que la aprobación corresponde a esta solicitud." },
    )
  } else {
    add({ codigo: "RC9", regla: "Aprobación posterior o igual a la solicitud", estado: "bloqueo", detalle: "Sin aprobación no hay fecha que verificar.", accion_sugerida: "Pedir el correo de aprobación." })
  }

  // RC10 — cantidad × valor unitario = valor total (± 1)
  const calculado = s.cantidad * s.valor_unitario
  add(
    Math.abs(calculado - s.valor_total) <= TOLERANCIA_ARITMETICA
      ? { codigo: "RC10", regla: "Cantidad × valor unitario = valor total", estado: "ok", detalle: `${s.cantidad} × ${fmt(s.valor_unitario)} = ${fmt(calculado)}.` }
      : { codigo: "RC10", regla: "Cantidad × valor unitario = valor total", estado: "bloqueo", detalle: `${s.cantidad} × ${fmt(s.valor_unitario)} = ${fmt(calculado)} ≠ valor total ${fmt(s.valor_total)}.`, accion_sugerida: "Pedir al solicitante corregir cantidad, valor unitario o total." },
  )

  const bloqueos = controles.filter((c) => c.estado === "bloqueo")
  return {
    apta: bloqueos.length === 0,
    retroactiva,
    controles,
    bloqueos,
    confirmaciones: controles.filter((c) => c.estado === "confirmacion"),
    derivados,
    proveedor: prov && prov.activo ? prov : null,
    fuente_proveedor: prov ? `maestro.proveedores (por ${via})` : null,
  }
}

function escalamiento(aprobadores: { email: string; tope: number }[], valor: number, centro: string): string {
  const capaz = aprobadores.filter((a) => a.tope >= valor).sort((a, b) => a.tope - b.tope)[0]
  return capaz
    ? `Escalar la aprobación a ${capaz.email} (tope ${fmt(capaz.tope)}).`
    : `Ningún aprobador de ${centro} tiene tope para ${fmt(valor)}: escalar la aprobación a gerencia.`
}
