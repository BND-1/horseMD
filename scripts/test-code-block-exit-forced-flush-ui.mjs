import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import {
  assertHealthyCodeBlockExit,
  clearCodeBlockExitDiagnostics,
  focusCodeBlockEnd,
  focusExitParagraph,
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

const root = `/tmp/horsemd-code-block-exit-forced-flush-${process.pid}`
const file = join(root, 'forced-flush.md')
const port = Number(process.env.CDP_PORT || 15120 + (process.pid % 40))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const fixture = '\uFEFFbefore\r\n\r\n~~~js\r\nconsole.log(1)\r\n~~~\r\n\r\nafter\r\n'
const initialSource = '\uFEFFbefore\n\n~~~js\nconsole.log(1)\n~~~\n\nafter\n'
const finalSource = '\uFEFFbefore\n\n~~~js\nconsole.log(1)\n~~~\n\nXY\n\nafter\n'
const finalDisk = finalSource.replace(/\n/g, '\r\n')

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
  assert.equal((await focusCodeBlockEnd(app))?.text.trim(), 'console.log(1)')

  await pressCodeBlockExit(app, 0)
  assert.equal(await toggleSource(app), true)
  let source = await waitFor(() => visibleSource(app), 'forced source missing')
  assert.equal(source, initialSource)
  await sleep(400)

  const forced = await readCodeBlockExitDiagnostics(app)
  assertHealthyCodeBlockExit(forced, 'forced pending exit')
  const pendingProof = forced.preserve.find((entry) =>
    entry.reason === 'code-block-exit'
  )?.integrityProof
  assert.equal(pendingProof?.mode, 'pending-empty-paragraph')
  assert.equal(pendingProof?.sourceUnchanged, true)
  assert.equal(pendingProof?.textStepCount, 0)
  assert.deepEqual(forced.coordinator.filter((entry) =>
    entry.phase === 'published' && entry.family === 'code-block-exit'
  ).map((entry) => entry.boundary), [
    'transaction-code-block-exit-forced-flush'
  ])

  assert.equal(await toggleSource(app), true)
  await waitForExitParagraph(app, '')
  assert.equal((await focusExitParagraph(app))?.text, '')
  await clearCodeBlockExitDiagnostics(app)
  await typeCodeExitText(app, 'XY', 75)
  await waitForExitParagraph(app, 'XY')
  await sleep(900)

  const staged = await readCodeBlockExitDiagnostics(app)
  assertHealthyCodeBlockExit(staged, 'post-forced staged exit')
  const stagedProof = staged.preserve.find((entry) =>
    entry.reason === 'code-block-exit'
  )?.integrityProof
  assert.equal(stagedProof?.mode, 'staged-text')
  assert.equal(stagedProof?.finalText, 'XY')
  assert.equal(stagedProof?.textStepCount, 2)
  assert.equal(stagedProof?.transactionJournal?.baseOwner, 'transaction')
  assert.equal(stagedProof?.transactionJournal?.baseFamily, 'code-block-exit')
  assert.equal(stagedProof?.transactionJournal?.baseReason, 'code-block-exit')
  assert.deepEqual(staged.coordinator.filter((entry) =>
    entry.phase === 'published' && entry.family === 'code-block-exit'
  ).map((entry) => entry.boundary), [
    'transaction-code-block-exit-markdown-updated'
  ])

  assert.equal(await toggleSource(app), true)
  source = await waitFor(() => visibleSource(app), 'forced final source missing')
  assert.equal(source, finalSource)
  await saveCodeBlockExitFile(app, file, finalDisk, 'forced staged exit')
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
  source = await waitFor(() => visibleSource(app), 'forced cold source missing')
  assert.equal(source, finalSource)
  assert.equal(await readFile(file, 'utf8'), finalDisk)

  completed = true
  console.log('PASS forced-flush transaction-owned code block exit: immediate source toggle publishes the pending empty paragraph without changing source, staged provenance inserts XY, and source/save/CRLF disk/cold reopen remain exact')
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  if (completed) await rm(root, { recursive: true, force: true })
}
