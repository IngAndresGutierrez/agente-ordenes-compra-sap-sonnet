// Genera modulo/agent.md y modulo/skill/ordenes-compra/SKILL.md desde las mismas fuentes que usa el servidor.
// Uso: npm run modulo  (test/modulo.test.ts falla si quedan desincronizados)
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

export async function generarModulo(root: string): Promise<{ agent: string; skill: string }> {
  const prompt = await readFile(join(root, "agent/prompt.md"), "utf8")
  const conocimiento = await readFile(join(root, "src/knowledge/ordenes-compra.md"), "utf8")
  const agent = `---
description: Prepara y crea órdenes de compra en SAP validando la solicitud contra los maestros (RC1–RC10), con confirmación humana para excepciones.
mode: primary
permission:
  edit: deny
  bash: deny
---

${prompt}`
  const skill = `---
name: ordenes-compra
description: Proceso y matriz de controles RC1–RC10 para crear órdenes de compra en SAP desde una solicitud, una cotización y una aprobación.
---

${conocimiento}`
  return { agent, skill }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd()
  const { agent, skill } = await generarModulo(root)
  await mkdir(join(root, "modulo/skill/ordenes-compra"), { recursive: true })
  await writeFile(join(root, "modulo/agent.md"), agent)
  await writeFile(join(root, "modulo/skill/ordenes-compra/SKILL.md"), skill)
  console.log("modulo/agent.md y modulo/skill/ordenes-compra/SKILL.md generados")
}
