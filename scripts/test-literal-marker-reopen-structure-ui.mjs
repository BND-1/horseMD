// Verify what a literal `- - text` source row reopens as: if the parser nests
// it, emitting the unescaped literal marker corrupts the rich structure on
// reopen, and the `\-` escape is the correct authored spelling.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-literal-reopen-${process.pid}`
const file = join(root, 'literal.md')
const port = Number(process.env.CDP_PORT || 9831)
const fixture = '- - 测试\n'

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'p'), port, appArgs: [file] })
    await waitFor(() => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`), 'editor missing')
    await sleep(500)
    const structure = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const nestedLists = editor?.querySelectorAll('li li').length || 0
      const topLevelItems = editor?.querySelectorAll(':scope > ul > li, :scope > ol > li').length || 0
      const bodyText = editor?.textContent || ''
      return { nestedLists, topLevelItems, bodyText }
    })()`)
    console.log('reopen structure:', JSON.stringify(structure))
    assert.equal(structure.nestedLists, 0, `escaped-literal must reopen as one level (got nested ${structure.nestedLists})`)
    console.log('PASS literal marker reopen structure: unescaped source stays a single-level list')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
