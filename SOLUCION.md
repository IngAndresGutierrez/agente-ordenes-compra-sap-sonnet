# SOLUCIÓN — Reto 03: agente de órdenes de compra SAP

## 1. Problema en una frase

La analista de compras digita a mano en SAP cada orden de compra y verifica de memoria quién puede aprobar qué y por cuánto. Eso cuesta tiempo, deja pasar errores de centro de costo que se corrigen en el cierre contable y no permite medir cuántas OC se crean después de la factura. Le duele a la analista (digitación), a contabilidad y auditoría (control) y a la dirección (no puede medir el desvío).

## 2. Arquitectura

```
┌──────────── web/ (HTML + JS) ───────────┐        ┌──────────────── src/server.ts (Hono) ────────────────┐
│ chat · llamadas a herramientas visibles  │ HTTP   │ /api/chat → agent/ciclo.ts                            │
│ confirmación resaltada (copia amarilla)  │──────▶ │   ├─ llm/adapter.ts  (interfaz)                       │
│ hoja de la OC: campos, RC1–RC10, sello   │◀────── │   │   └─ llm/anthropic.ts (implementación)            │
└──────────────────────────────────────────┘        │   └─ tools/registro.ts → tools/oc.ts (oc_*)           │
                                                    │          └─ oc/ (fuentes, controles, payload,         │
                                                    │             evidencia) + sap/mock.ts (SapAdapter)     │
                                                    └───────────────┬──────────────────────┬────────────────┘
                                                                    │                      │
                                                     fixtures/reto-03 (solo lectura)   out/ (escritura)
```

| Capa | Dónde vive | Qué cambia ahí |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Cómo conversa el agente, cuándo pregunta, qué nunca hace |
| Conocimiento | `src/knowledge/ordenes-compra.md` | El proceso y la matriz de controles explicada |
| Ejecución | `src/tools/oc.ts` + `src/oc/` | Reglas RC1–RC10, payload, evidencia, SAP |

El servidor solo une las piezas: un cambio de reglas de negocio toca `src/oc/controles.ts`, nunca `server.ts`. Las herramientas no importan nada del servidor; `demo.ts` y `modulo/` las usan directo.

## 3. Ciclo del agente

`src/agent/ciclo.ts`, función `turno()`:

1. Agrega el mensaje del usuario y llama al modelo con el system prompt (prompt + conocimiento) y las 5 herramientas.
2. Si el modelo pide herramientas, el registro (`tools/registro.ts`) valida los argumentos con zod, ejecuta, escribe una línea en `out/log.jsonl` y devuelve el JSON al modelo. Un argumento inválido vuelve al modelo como error, no como excepción.
3. Repite hasta que el modelo responde sin herramientas o hasta **`MAX_ITERACIONES` (25)**. Si llega al tope, responde con lo hecho y pide continuar.
4. Cada sesión acumula tokens. Al pasar **`MAX_TOKENS_SESION`**, el turno se rechaza con un mensaje claro.
5. Un error del proveedor (timeout, clave, rate limit) se traduce a un mensaje en español y la sesión sigue viva.

**Confirmación humana: la exige el diseño, no solo el prompt.**

- `oc_crear` sin `confirmado: true` no crea una OC que tenga confirmaciones pendientes.
- El modelo puede mandar `confirmado: true` por su cuenta, pero el servidor también calcula `confirmacionHumana`: solo es verdadero si el turno anterior dejó casos pendientes **y** el último mensaje del usuario es una afirmación explícita sin negación ("Confirmo", "sí, créala"; no "no la crees todavía"). Si el modelo intenta crear en el mismo turno en que preguntó, la herramienta lo rechaza (`test/oc.test.ts` lo cubre).
- `needsConfirmation` se calcula en el servidor a partir de los resultados de las herramientas, y el front pinta ese mensaje en amarillo con los botones "Confirmar y crear la OC" / "No crear todavía".

**El modelo no puede afirmar ni alterar valores (CA2).** Las herramientas solo necesitan `caso` y recalculan todo desde los fixtures. `paquete`, `derivados` y `payload` se aceptan por el contrato, pero no son fuente de verdad: si el modelo manda a `oc_crear` un payload distinto del validado, la OC no se crea.

## 4. Elección del modelo

- **Proveedor y modelo:** Anthropic, `claude-sonnet-5-5` con esfuerzo `medium`, configurable por variable de entorno (`LLM_MODEL`, `LLM_EFFORT`).
- **Por qué:** el trabajo difícil (controles, montos, payload) lo hacen herramientas deterministas; el modelo solo orquesta llamadas y explica resultados. Para eso Sonnet 5.5 basta: encadena herramientas, sigue la instrucción de no inventar valores y cuesta la mitad que Opus 5.5. Si en producción hiciera falta más criterio (por ejemplo, extraer cotizaciones de PDF reales), se cambia a `claude-opus-5-5` sin tocar código. Está activado `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`): si un clasificador rechaza la petición, la API la reintenta en el modelo recomendado.
- **Costo estimado por caso** (estimación, no medida en producción): un caso típico son ~6 llamadas al modelo. Cada llamada reenvía el system prompt, las herramientas y el historial (~4–10 k tokens de entrada) y genera ~0,5–1 k de salida, incluido el razonamiento. A $2 / $10 por millón de tokens, son unos **USD 0,07–0,12 por caso**. El system prompt va marcado para caché, lo que baja la entrada repetida a $0,20 por millón cuando supera el mínimo cacheable.
- **Control de gasto:** tope de iteraciones por turno, tope de tokens por sesión, tope de sesiones en memoria, mensajes de máximo 4.000 caracteres, una sola petición a la vez por sesión y `ACCESS_KEY` opcional para proteger el link.

## 5. Matriz de controles

Todas viven en una función pura, `validar(paquete, maestros)` en `src/oc/controles.ts`, que devuelve los 10 controles con estado `ok | bloqueo | confirmacion | derivado`, detalle y acción sugerida. La interfaz muestra la lista completa, no solo los que fallan.

| Código | Implementación | Tipo |
|---|---|---|
| RC1 | Busca por NIT normalizado (sin puntos ni DV): primero el de la solicitud y, si falta, el de la cotización. Sin NIT, busca por nombre normalizado (sin tildes ni S.A.S./Ltda.). Exige `activo`. | Bloqueo |
| RC2 | Aprobación presente, cuerpo con "aprobado/a" (palabra completa) y remitente en `aprobadores` del centro | Bloqueo |
| RC3 | `valor_total ≤ tope` del aprobador en ese centro. La acción sugerida nombra a quién escalar. | Bloqueo |
| RC4 | `subarea ∈ centro.subareas` | Bloqueo |
| RC5 | `|cot − sol| / sol ≤ 2 %`. Sin cotización, pide confirmación. | Confirmación |
| RC6 | Sin IVA, deriva `indicador_iva_default` y pide confirmación | Confirmación + derivado |
| RC7 | Sin condiciones de pago, deriva `condiciones_pago_default` | Derivado |
| RC8 | `factura.fecha < fecha_solicitud` → `retroactiva = true` | Confirmación |
| RC9 | `fecha_aprobación ≥ fecha_solicitud` (compara solo la fecha) | Confirmación |
| RC10 | `|cantidad × unitario − total| ≤ 1` | Bloqueo |

**La más difícil fue RC1/RC2.** RC1 porque `sol-006` no trae NIT en la solicitud: había que decidir si el NIT de la cotización vale como fuente. Decidí que sí, porque es un documento del mismo proveedor, y la trazabilidad dice de dónde salió. RC2/RC3 en `sol-003` falla doble: el aprobador es de otro centro y, además, ningún aprobador de CC-2020 tiene tope para 74 M. La acción sugerida debía decir eso y no solo "aprobador inválido".

## 6. Diseño del adaptador SAP real

**Opción elegida: OData `API_PURCHASEORDER_PROCESS_SRV` (S/4HANA) a través de SAP Integration Suite o BTP Destination.** Es la API estándar publicada, con contrato estable, CSRF y errores estructurados. Si el sistema es ECC, usaría `BAPI_PO_CREATE1` vía RFC expuesta por un middleware (SAP PO o Integration Suite), nunca RFC directa desde el agente.

**Mapeo del payload (7.4 → OData):**

| Payload | OData A_PurchaseOrder / A_PurchaseOrderItem |
|---|---|
| `sociedad` | `CompanyCode` |
| `organizacion_compras` | `PurchasingOrganization` (+ `PurchasingGroup` de configuración) |
| `proveedor.codigo_sap` | `Supplier` |
| `moneda` | `DocumentCurrency` |
| `condiciones_pago` | `PaymentTerms` |
| `referencia.solicitud_id` | `CorrespncExternalReference` (clave de idempotencia) |
| `posiciones[].numero` | `PurchaseOrderItem` |
| `posiciones[].descripcion` | `PurchaseOrderItemText` (40 caracteres) |
| `cantidad` / `unidad` | `OrderQuantity` / `PurchaseOrderQuantityUnit` (UN→EA, H→H, MES→MON según configuración) |
| `precio_unitario` | `NetPriceAmount` |
| `centro_costo` | `to_AccountAssignment.CostCenter` con `AccountAssignmentCategory = K` |
| `subarea` | Campo de imputación según configuración (orden interna, `WBSElement` o campo Z) |
| `indicador_iva` | `TaxCode` |
| `aprobador` + `evidencia_sha256` | Nota de cabecera y adjunto PDF vía `API_CV_ATTACHMENT_SRV` |
| `excepciones` | Texto de cabecera ("Excepciones confirmadas: RC5 por analista…") |

**Credenciales:** usuario técnico de comunicación (Communication Arrangement) con OAuth2 client credentials. El secreto vive en el gestor de secretos del entorno (BTP Destination, Azure Key Vault o variables del servicio), lo lee solo el adaptador del backend y nunca pasa por el prompt, el modelo, el front ni los logs.

**Idempotencia y errores parciales:** antes de crear, `buscarOrdenPorReferencia` consulta por `CorrespncExternalReference = solicitud_id`. Si existe, devuelve ese número. Si un `POST` da timeout, no se reintenta a ciegas: se vuelve a consultar por referencia y solo se reintenta si no aparece. Si SAP crea la cabecera pero falla el adjunto (error parcial), la OC queda creada, se registra `resultado = creada_con_pendientes` en `control.csv` y se reintenta solo el adjunto. Los errores de negocio de SAP (`BAPIRET2` / mensajes OData) se traducen a lenguaje claro y no se reintentan.

**Plan B si la conexión no es viable:**

1. Generar la OC como archivo de carga masiva (plantilla LSMW / Migration Cockpit, o CSV para `ME21N` con eCATT) que la analista sube en un paso.
2. Mientras tanto, mostrar la OC en una vista "lista para pegar", con el mismo orden de campos que la pantalla de `ME21N`.

En ambos casos se conservan los controles, la evidencia, la trazabilidad y el log de control, que es donde está la mayor parte del ahorro y todo el control.

## 7. Lectura del proceso: OC retroactivas

Una OC creada después de la factura no es una orden de compra, es una legalización: el gasto ya ocurrió sin control previo, sin comparar cotizaciones y sin verificar que el aprobador tuviera autoridad sobre ese monto. `sol-005` lo muestra: la cotización es del 5 de agosto, la factura del 10 y la solicitud del 27; el aprobador escribe "ya llegó la factura, por favor crear la OC para poder radicarla".

Mi recomendación a la dirección:

1. **Medir primero.** El agente no rechaza las retroactivas: las crea solo con confirmación y las marca en `out/control.csv` (`retroactiva = true`). En un mes habrá una línea base por centro de costo y por aprobador.
2. **Hacer visible el costo.** Publicar mensualmente el porcentaje de OC retroactivas por área.
3. **Cambiar la regla, no a las personas.** Con la línea base, definir una política: por ejemplo, retroactivas por debajo de un monto se toleran con justificación, y por encima requieren aprobación de un nivel superior. Y algo concreto: que contabilidad no radique facturas sin número de OC previo (no PO, no pay), que es el control que corta el desvío en su origen.

## 8. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Las herramientas recalculan todo desde la fuente con solo `caso` | Que el modelo pase `paquete` / `payload` entre herramientas | Pasar los datos por el modelo permite que los altere (CA2) y gasta tokens. Se aceptan por contrato, pero se ignoran o se verifican. |
| Confirmación verificada por el servidor (`confirmacionHumana`) además del prompt | Confiar solo en el prompt | Un prompt se puede ignorar. Si la regla vive en el servidor, la herramienta rechaza la creación aunque el modelo lo intente. |
| Ciclo manual detrás de una interfaz propia `LlmAdapter` | El Tool Runner del SDK de Anthropic | El PRD pide que cambiar de proveedor no toque el ciclo. El Tool Runner acopla el ciclo al SDK. |
| Un solo proceso (Hono) que sirve API y front, desplegado como contenedor | Front en Vercel + backend serverless | El SAP simulado escribe en disco y las sesiones viven en memoria. En serverless se perderían entre invocaciones. |
| Front en HTML + JS sin framework | React + Vite | Sin paso de build, menos piezas para desplegar en 2 horas. La interfaz es un chat y un panel. |
| OC con el valor de la solicitud aprobada, no el de la cotización | Usar el total de la cotización | Lo aprobado es la solicitud. Una diferencia > 2 % la decide la analista (RC5). |

## 9. Supuestos

- Las fechas se comparan como fecha calendario (`YYYY-MM-DD`), ignorando hora y zona.
- "Aprobado" se reconoce como palabra completa ("aprobado" o "aprobada", sin distinguir mayúsculas). "Aprobado por 25 millones" cuenta como aprobación.
- Si la solicitud no trae NIT, vale el NIT de la cotización antes de buscar por nombre.
- Sin aprobador válido del centro, RC3 también bloquea, porque no hay tope contra el cual medir.
- La unidad se infiere de la descripción: "hora/horas" → `H`, "mensual/por mes" → `MES`; lo demás → `UN`.
- La descripción se recorta a 40 caracteres (texto breve SAP) con "…", y la descripción completa queda en la trazabilidad.
- Cada solicitud tiene una sola posición (así son los fixtures).
- `confirmado_por` registra "analista (chat, sesión X)". Sin autenticación (no-objetivo) no hay identidad real.
- Una confirmación explícita cubre todos los casos pendientes de la sesión.
- El sha256 de la evidencia se calcula sobre el texto canónico del correo (encabezados + cuerpo).

## 10. Cobertura

| Historia | Estado | Qué falta para producción |
|---|---|---|
| HU-1 Leer el paquete | Hecho | Leer `.xlsx`, PDF y `.eml` reales (P1 opcional, no implementado) |
| HU-2 Validar contra maestros | Hecho (RC1–RC10) | Maestros consultados en SAP en tiempo real |
| HU-3 Construir el payload | Hecho, con zod y `trazabilidad.json` | Varias posiciones por OC |
| HU-4 Evidencia | Hecho: `.txt` con sha256 (P0) y `.pdf` (P1) | Adjuntarla a la OC real |
| HU-5 Crear en SAP simulado | Hecho: numeración, idempotencia, `control.csv` en cada intento | Adaptador real (§6) |
| HU-6 Manejo de errores | Hecho: nada lanza; caso inexistente, JSON malformado, monto no numérico y errores del LLM dan mensajes claros | — |
| Front, API, topes, log | Hecho | Autenticación por usuario |
| Bonus `modulo/` | Hecho: `agent.md` y `SKILL.md` generados de las mismas fuentes, y `tools/oc.ts` reexporta las mismas herramientas. `test/modulo.test.ts` falla si divergen. | — |
| `oc_leer_excel` | No hecho (P1 opcional) | — |

## 11. Uso de IA

- **Claude Code (Claude Opus 5.5)**, en sesión conmigo. Tareas: analizar los 3 PRD y elegir el reto, generar el scaffolding, escribir dominio, herramientas, ciclo, front, pruebas y estos documentos, y revisar la interfaz con capturas en navegador (Playwright).
- **Skills de Claude Code:** `claude-api` (forma actual del SDK, modelo, fallback, errores tipados) y `frontend-design` (dirección visual: la hoja de OC en papel carbón con copia amarilla y rosada, y un sello como único elemento llamativo).

Lo que descarté o corregí de lo que propuso:

- **El Tool Runner del SDK**, por la razón de §8.
- **"Dividir la compra"** como acción sugerida cuando ningún aprobador tiene tope. Fraccionar compras para evadir topes es justo lo que el control debe evitar. Lo cambié por escalar a gerencia.
- **La primera tipografía** (Atkinson Hyperlegible): dibuja los ceros con barra y los montos se leían mal en la captura. La cambié por Public Sans.
- **La detección de confirmaciones con `\b`**: las pruebas mostraron que no reconocía "sí, créala", porque `\b` no trata las letras con tilde como letras. La reemplacé por límites de palabra Unicode.

<!-- Completa con tu experiencia: qué más revisaste a mano y qué decidiste tú. -->

## 12. Riesgos de llevar esto a producción

| Riesgo | Mitigación |
|---|---|
| Conexión a SAP no viable a corto plazo | Plan B de §6 (carga masiva / OC lista para pegar). Los controles y el log siguen funcionando. |
| El modelo "arregla" un monto para que cuadre | Los montos salen de las herramientas, el payload se recalcula y se compara en `oc_crear`, y el prompt prohíbe afirmar valores propios. |
| Confirmación ambigua ("ok pero revisa el IVA") | Detección conservadora (cualquier negación anula). En producción: botón de confirmación firmado por usuario autenticado, en vez de interpretar texto. |
| Maestros desactualizados | Consultar proveedor y aprobadores en SAP/HR en tiempo real, con caché corta y fecha de consulta en la trazabilidad. |
| Correos de aprobación falsificables | Validar DKIM/SPF del correo original o mover la aprobación a un flujo con firma (workflow SAP o firma electrónica). |
| Estado en memoria y disco local | Sesiones y logs en almacenamiento persistente (Postgres/Blob). `control.csv` pasaría a una tabla consultable por auditoría. |
| Costo del LLM | Topes por turno y por sesión, caché del prompt, `LLM_MODEL` configurable, `ACCESS_KEY` y rate limit por IP en el borde. |
| Plantillas reales peores que los fixtures | Parser de cotizaciones con extracción por modelo + validación determinista. Si no cuadra, confirmación humana, nunca un valor inventado. |
