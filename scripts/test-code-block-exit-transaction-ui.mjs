import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import {
  assertHealthyCodeBlockExit,
  clearCodeBlockExitDiagnostics,
  focusCodeBlockEnd,
  openCodeBlockExitApp,
  pressCodeBlockExit,
  readCodeBlockExitDiagnostics,
  readCodeBlockExitStructure,
  saveCodeBlockExitFile,
  toggleSource,
  typeCodeExitText,
  visibleSource,
  waitFor,
  waitForExitParagraph
} from './lib/code-block-exit-test.mjs'

const root = `/tmp/horsemd-code-block-exit-${process.pid}`
const file = join(root, 'exit.md')
const port = Number(process.env.CDP_PORT || 14920 + (process.pid % 40))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const fixture = '\uFEFFbefore\r\n\r\n~~~js\r\nconsole.log(1)\r\n~~~\r\n\r\nafter\r\n'
const expectedSource = '\uFEFFbefore\n\n~~~js\nconsole.log(1)\n~~~\n\nXY\n\nafter\n'
const expectedDisk = expectedSource.replace(/\n/g, '\r\n')

let app = null
let completed = false
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  app = await openCodeBlockExitApp({
    file,
    profileDir: join(root, 'profile'),
    port,
    packagedAppPath
  })
  await clearCodeBlockExitDiagnostics(app)
  const initial = await focusCodeBlockEnd(app)
  assert.equal(initial?.text.trim(), 'console.log(1)')

  await pressCodeBlockExit(app, 5)
  await typeCodeExitText(app, 'XY', 5)
  await waitForExitParagraph(app, 'XY')
  await sleep(900)

  const structure = await readCodeBlockExitStructure(app)
  assert.deepEqual(structure.types, ['paragraph', 'code_block', 'paragraph', 'paragraph'])
  assert.deepEqual(structure.texts, ['before', 'console.log(1)', 'XY', 'after'])
  const state = await readCodeBlockExitDiagnostics(app)
  assertHealthyCodeBlockExit(state, 'rapid code-block exit')
  const proofs = state.preserve
    .filter((entry) => entry.reason === 'code-block-exit')
    .map((entry) => entry.integrityProof)
  assert.deepEqual(proofs.map((proof) => proof?.mode),
    ['pending-empty-paragraph', 'staged-text'])
  assert.equal(proofs[0].sourceUnchanged, true)
  assert.equal(proofs[1].finalText, 'XY')
  assert.equal(proofs[1].textStepCount, 2)
  assert.equal(proofs[1].transactionJournal?.baseOwner, 'transaction')
  assert.equal(proofs[1].transactionJournal?.baseFamily, 'code-block-exit')
  const publications = state.coordinator.filter((entry) =>
    entry.phase === 'published' && entry.family === 'code-block-exit'
  )
  assert.deepEqual(publications.map((entry) => entry.boundary), [
    'transaction-code-block-exit-forced-flush',
    'transaction-code-block-exit-markdown-updated'
  ])

  assert.equal(await toggleSource(app), true)
  let source = await waitFor(() => visibleSource(app), 'rapid source missing')
  assert.equal(source, expectedSource)
  await saveCodeBlockExitFile(app, file, expectedDisk, 'rapid code-block exit')
  await stopBuiltElectron(app, { removeProfile: true })
  app = null

  app = await openCodeBlockExitApp({
    file,
    profileDir: join(root, 'reopen-profile'),
    port: port + 1,
    packagedAppPath
  })
  assert.deepEqual(await readCodeBlockExitStructure(app), {
    types: ['paragraph', 'code_block', 'paragraph', 'paragraph'],
    texts: ['before', 'console.log(1)', 'XY', 'after']
  })
  assert.equal(await toggleSource(app), true)
  source = await waitFor(() => visibleSource(app), 'rapid cold source missing')
  assert.equal(source, expectedSource)
  assert.equal(await readFile(file, 'utf8'), expectedDisk)

  completed = true
  console.log('PASS transaction-owned code block exit UI: physical Mod-Enter + rapid XY publishes a forced pending checkpoint then provenance-bound staged text, with exact source/save/CRLF disk/cold reopen')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  if (completed) await rm(root, { recursive: true, force: true })
}
