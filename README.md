# Reto 03 — Agente de órdenes de compra SAP

Agente conversacional que lee una solicitud de compra, la valida contra los maestros (controles RC1–RC10), arma la OC tal como quedaría en SAP, genera la evidencia de aprobación y la crea en un SAP simulado. Las excepciones se devuelven a la analista para que decida.

**Link de prueba:** https://reto-03-oc-production.up.railway.app (público, sin clave de acceso)

## Levantar en local

Requiere Node 20+.

```bash
cp .env.example .env          # y pon tu ANTHROPIC_API_KEY
npm install
npm run local                 # lee .env y levanta API + front en un solo proceso
```

Abre <http://localhost:3000>. El mismo proceso sirve la API y el front (`web/`).

## Verificación sin modelo

```bash
npm install && npm run demo     # corre los 6 casos llamando directo a las herramientas
npm test                        # controles por caso, idempotencia, confirmación humana, topes, módulo
npm run typecheck
```

`demo.ts` borra `out/` al iniciar, procesa `sol-001` a `sol-006`, repite `sol-001` para mostrar la idempotencia y confirma `sol-004`, `sol-005` y `sol-006` de forma explícita.

| Caso | Resultado esperado |
|---|---|
| sol-001 | OC creada sin intervención (4500000001) |
| sol-002 | Bloqueada · RC1 proveedor inexistente |
| sol-003 | Bloqueada · RC2 aprobador de otro centro, RC3 sin tope |
| sol-004 | Pide confirmar · RC5 cotización 6 % por encima |
| sol-005 | Pide confirmar · RC8 retroactiva, queda marcada en `control.csv` |
| sol-006 | Pide confirmar · RC6 IVA derivado del proveedor (RC7 condiciones derivadas) |

## Variables de entorno

| Variable | Default | Uso |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Obligatoria. Solo vive en el backend. |
| `LLM_MODEL` | `claude-sonnet-5-5` | Modelo. |
| `LLM_EFFORT` | `medium` | Esfuerzo de razonamiento. |
| `LLM_TIMEOUT_MS` | `90000` | Timeout por llamada al modelo. |
| `LLM_MAX_TOKENS` | `16000` | Tope de salida por respuesta. |
| `MAX_ITERACIONES` | `25` | Tope de ciclos herramienta → modelo por turno. |
| `MAX_TOKENS_SESION` | `200000` | Tope de tokens por sesión. |
| `ACCESS_KEY` | vacío | Si se define, la API exige el header `x-access-key` (el front la pide). |

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation, error?, tokensSesion }` |
| `GET` | `/api/sessions/:id` | Historial visible de la sesión, casos pendientes de confirmar y tokens usados |
| `GET` | `/api/health` | `{ ok, provider, model, protegido }` sin claves |
| `GET` | `/api/casos` | Solicitudes disponibles en la bandeja |
| `GET` | `/api/archivos?ruta=out/...` | Lectura de los archivos generados (solo dentro de `out/`) |
| `POST` | `/api/reiniciar` | Borra `out/` y las sesiones (para repetir la demo) |

## Desplegar

El `Dockerfile` sirve para Railway, Render o Fly.io. En Railway: `railway init && railway up`, y luego define `ANTHROPIC_API_KEY` (y opcionalmente `ACCESS_KEY`) en las variables del servicio. No uses funciones serverless (Vercel): el SAP simulado escribe en `out/` y las sesiones viven en memoria.

## Estructura

```
agent/prompt.md              comportamiento (system prompt)
src/knowledge/ordenes-compra.md  conocimiento del proceso
src/tools/oc.ts              herramientas oc_* (zod, nunca lanzan)
src/oc/                      dominio: lectura de fixtures, controles RC1–RC10, payload, evidencia
src/sap/adapter.ts, mock.ts  interfaz SapAdapter y SAP simulado sobre out/sap/
src/llm/adapter.ts           interfaz del proveedor LLM; anthropic.ts la implementa
src/agent/ciclo.ts           ciclo del agente, topes y confirmación humana
src/server.ts                API HTTP + front estático
web/                         chat
modulo/                      bonus: agente empaquetado (generado con npm run modulo)
demo.ts                      verificación sin modelo
```
