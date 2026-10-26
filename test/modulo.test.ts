import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import * as app from "../src/tools/oc.ts"
import * as modulo from "../modulo/tools/oc.ts"
import { generarModulo } from "../scripts/modulo.ts"

test("modulo/ usa las mismas piezas que la aplicación", async () => {
  const { agent, skill } = await generarModulo(process.cwd())
  assert.equal(await readFile("modulo/agent.md", "utf8"), agent, "corre npm run modulo")
  assert.equal(await readFile("modulo/skill/ordenes-compra/SKILL.md", "utf8"), skill, "corre npm run modulo")
  assert.deepEqual(Object.keys(modulo).sort(), Object.keys(app).sort())
  assert.equal(modulo.crear, app.crear)
})
