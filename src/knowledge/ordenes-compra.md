# Proceso de órdenes de compra (OC) — Periferia IT Group

## Qué llega

Cada solicitud llega a compras por correo con tres piezas: la solicitud (Excel, normalizado a `solicitud.json`), la cotización del proveedor (texto) y el correo de aprobación del líder. A veces también llega la factura: si la factura es anterior a la solicitud, la OC es **retroactiva**.

## Qué se digita en SAP

Proveedor (código SAP), descripción (texto breve ≤ 40 caracteres), centro de costo y subárea, cantidad y precio unitario, indicador de IVA, condiciones de pago, aprobador y el correo de aprobación como PDF adjunto. Sociedad y organización de compras son siempre `1000`.

## Matriz de controles

| Código | Regla | Si falla |
|---|---|---|
| RC1 | El proveedor existe en el maestro (por NIT; sin NIT, por nombre) y está activo | Bloqueo: pedir la creación del proveedor en SAP |
| RC2 | Hay aprobación, dice "Aprobado" y viene de un aprobador del centro de costo | Bloqueo: pedir la aprobación al aprobador correcto |
| RC3 | El valor total no supera el tope del aprobador en ese centro | Bloqueo: escalar a un aprobador con tope suficiente |
| RC4 | La subárea pertenece al centro de costo | Bloqueo: pedir la subárea correcta |
| RC5 | Cotización y solicitud difieren como máximo 2 % (o no hay cotización) | Confirmación con ambos valores |
| RC6 | Falta el indicador de IVA → se toma el del proveedor | Confirmación del indicador derivado |
| RC7 | Faltan condiciones de pago → se toman las del proveedor | Solo se informa |
| RC8 | Factura anterior a la solicitud → OC retroactiva | Confirmación; queda `retroactiva = true` en `out/control.csv` |
| RC9 | La aprobación no es anterior a la solicitud | Confirmación |
| RC10 | Cantidad × valor unitario = valor total (± 1) | Bloqueo: pedir corrección al solicitante |

Un **bloqueo** impide crear la OC. Una **confirmación** permite crearla solo si la analista lo confirma de forma explícita. La OC se crea con el valor de la solicitud aprobada, no el de la cotización.

## Idempotencia y control

- Una solicitud produce como máximo una OC: si ya existe, se devuelve el mismo número.
- Cada intento (creada, existente, bloqueada o pendiente) queda en `out/control.csv`. Auditoría usa ese archivo para medir cuántas OC son retroactivas.
- Cada valor de la OC es trazable a su fuente en `out/<caso>/trazabilidad.json`.

## Por qué importa medir las retroactivas

Muchas OC se crean después de recibir la factura, saltándose la cotización. La dirección quiere saber cuántas son: el agente no las rechaza, las marca.
