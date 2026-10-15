import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-workspace-startup-'))
const profile = join(root, 'profile')
const workspace = process.env.WORKSPACE_STARTUP_ROOT || join(root, 'workspace')
const port = Number(process.env.CDP_PORT || 10460)
const executable = process.env.HORSEMD_TEST_EXECUTABLE
const options = {
  profileDir: profile,
  port,
  ...(executable ? { executable, entrypoint: null } : {})
}
const smoke = join(root, 'smoke.md')
const initial = '# Startup regression\n\nThis document remains editable while the workspace watcher initializes.\n'
const marker = '启动期间编辑验证'
const paths = [smoke]
let app
const report = { workspace, profile, executable: executable || 'built Electron', ipcMs: [], errors: [] }
const limited = (promise, message, timeout = 3000) => {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout) })
  ]).finally(() => clearTimeout(timer))
}
const waitFor = async (check, message, timeout = 12000) => {
  const deadline = performance.now() + timeout
  while (performance.now() < deadline) {
    const result = await limited(check(), message)
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}
const isEditable = () => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  return editor?.dataset.horsemdReady === 'true' && editor.contentEditable === 'true'
    && editor.textContent.includes('Startup regression')
})()`)

try {
  await fs.writeFile(smoke, initial)
  if (!process.env.WORKSPACE_STARTUP_ROOT) {
    await fs.mkdir(workspace)
    for (let dir = 0; dir < 30; dir += 1) {
      const folder = join(workspace, `data-${dir}`)
      await fs.mkdir(folder)
      await Promise.all(Array.from({ length: 50 }, (_, file) => fs.writeFile(join(folder, `${file}.bin`), 'data')))
    }
  }
  if (process.env.WORKSPACE_STARTUP_SESSION) {
    const session = JSON.parse(await fs.readFile(process.env.WORKSPACE_STARTUP_SESSION, 'utf8'))
    for (const [index, path] of (session.openPaths || []).slice(0, 3).entries()) {
      const copy = join(root, `restored-${index}.md`)
      await fs.copyFile(path, copy)
      paths.push(copy)
    }
  }
  report.restoredDocuments = paths.length

  app = await launchBuiltElectron(options)
  await waitFor(() => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')]
    .find((node) => node.dataset.horsemdReady === 'true')`), 'Seed profile did not finish onboarding')
  await sleep(700)
  await app.evaluate(`(() => {
    localStorage.setItem('horsemd.onboarded.v1', '1')
    localStorage.setItem('horsemd.settings.v1', JSON.stringify({ restoreSession: true }))
    localStorage.setItem('minimd.session.v1', JSON.stringify({
      folderRoots: ${JSON.stringify([workspace])},
      openPaths: ${JSON.stringify(paths)},
      activePath: ${JSON.stringify(smoke)},
      sidebarOpen: false,
      lang: 'zh'
    }))
  })()`)
  // Chromium batches localStorage disk commits. Windows SIGTERM force-kills
  // Electron, so allow that batch to persist before the cold-start measurement.
  await sleep(6000)
  await stopBuiltElectron(app)

  const start = performance.now()
  app = await launchBuiltElectron({ ...options, cleanProfile: false })
  app.child.stderr.on('data', (data) => {
    const text = String(data)
    if (/watch:start error|Workspace watcher exited|Cannot find module|ERR_WORKER/.test(text)) report.errors.push(text)
  })
  await waitFor(isEditable, 'Restored editor did not become editable during workspace startup')
  report.editorReadyMs = Math.round(performance.now() - start)
  assert(report.editorReadyMs < 10000, `Startup still stalls: ${report.editorReadyMs}ms`)
  report.nativeFocus = await app.evaluate('document.hasFocus()')
  assert.equal(report.nativeFocus, false, 'Background startup test took native focus')

  // Exercise real main-process IPC throughout the worker's initialization.
  for (let index = 0; index < 40; index += 1) {
    const before = performance.now()
    await limited(app.evaluate('window.api.windowIsMaximized()'), 'Window IPC stalled during workspace initialization')
    report.ipcMs.push(Math.round(performance.now() - before))
    await sleep(100)
  }
  report.maxIpcMs = Math.max(...report.ipcMs)
  assert(report.maxIpcMs < 1000, `Window IPC stalled for ${report.maxIpcMs}ms`)

  // Prove the worker entry and shared chunks load from the packaged app, not
  // just that a broken/missing worker leaves the window responsive.
  const contractRoot = join(root, 'watch-contract')
  await fs.mkdir(contractRoot)
  await app.evaluate(`(() => {
    window.__startupWatchChanges = []
    window.api.onWatchChanged((path) => window.__startupWatchChanges.push(path))
    return window.api.watchStart(${JSON.stringify(contractRoot)})
  })()`)
  let notified = false
  for (let index = 0; index < 30; index += 1) {
    await fs.writeFile(join(contractRoot, `new-${index}.md`), '# worker contract\n')
    await sleep(250)
    notified = await app.evaluate(`window.__startupWatchChanges.includes(${JSON.stringify(contractRoot)})`)
    if (notified) break
  }
  assert(notified, 'Workspace worker did not report a new document from the built/packaged app')
  await app.evaluate(`window.api.watchStop(${JSON.stringify(contractRoot)})`)
  report.workspaceNotifications = true

  await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const paragraph = [...editor.querySelectorAll('p')].at(-1)
    editor.focus()
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    range.collapse(false)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  })()`)
  await typeTextLikeUser(app.send, marker)
  await waitFor(() => app.evaluate('!!document.querySelector(".hm-save-fab")'), 'Startup edit was not marked dirty')
  await app.evaluate('document.querySelector(".hm-save-fab").click()')
  await waitFor(async () => (await fs.readFile(smoke, 'utf8')).includes(marker), 'Startup edit did not save')
  const saved = await fs.readFile(smoke, 'utf8')
  assert.equal(saved, initial.replace('initializes.', `initializes.${marker}`), 'Startup edit changed unrelated source bytes')
  await stopBuiltElectron(app)

  app = await launchBuiltElectron({ ...options, cleanProfile: false })
  await waitFor(isEditable, 'Saved editor did not restore after full restart')
  assert(await app.evaluate(`document.querySelector('.ProseMirror')?.textContent.includes(${JSON.stringify(marker)})`),
    'Saved startup edit was lost on restart')
  assert.equal(await fs.readFile(smoke, 'utf8'), saved, 'Restart changed the saved file')
  report.savedAndReopened = true
  assert.equal(report.errors.length, 0, 'Packaged workspace worker failed to load')
  console.log(`PASS workspace startup: editor ready ${report.editorReadyMs}ms; max window IPC ${report.maxIpcMs}ms; per-character edit, save and restart passed`)
} finally {
  await stopBuiltElectron(app)
  const output = process.env.WORKSPACE_STARTUP_REPORT || join(root, 'report.json')
  await fs.mkdir(dirname(output), { recursive: true })
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n')
  console.log(`Workspace startup report: ${output}`)
}
