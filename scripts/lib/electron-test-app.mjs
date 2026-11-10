import { rename, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
// HM_TEST_APP_EXE=<installed HorseMD executable>: run the test against an
// installed app (e.g. on the Windows test PC, with only scripts/ copied over):
// no entry file, and the `electron` package is not needed.
const INSTALLED_APP = process.env.HM_TEST_APP_EXE || ''
const electronPath = INSTALLED_APP || (await import('electron')).default
import { connectCdp, sleep } from './cdp.mjs'

const assertTcpPortAvailable = (port, host = '127.0.0.1') => new Promise((resolve, reject) => {
  const server = createServer()
  server.unref()
  server.once('error', (error) => {
    if (error?.code === 'EADDRINUSE') {
      reject(new Error(`CDP port ${port} is already in use`))
      return
    }
    reject(error)
  })
  server.listen({ host, port, exclusive: true }, () => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
})

export async function launchBuiltElectron({
  profileDir,
  port,
  cleanProfile = true,
  cwd = process.cwd(),
  appArgs = [],
  executable = electronPath,
  entrypoint = INSTALLED_APP ? null : 'out/main/index.cjs',
  background = true,
  // Every test launch records the input trace (user rule): a failure must be
  // diagnosable from horsemd-input-trace-<pid>.jsonl in the user temp dir.
  inputTrace = process.env.HORSEMD_TEST_TRACE !== '0',
  env = process.env
}) {
  if (cleanProfile && profileDir) await rm(profileDir, { recursive: true, force: true })
  await assertTcpPortAvailable(port)
  const child = spawn(executable, [
    ...(profileDir ? [`--user-data-dir=${profileDir}`] : []),
    `--remote-debugging-port=${port}`,
    ...(entrypoint ? [entrypoint] : []),
    ...(background ? ['--horsemd-test-background'] : []),
    ...appArgs,
    ...(inputTrace && !appArgs.includes('--horsemd-input-trace') ? ['--horsemd-input-trace'] : [])
  ], {
    cwd,
    // The app records shell.openExternal / openPath instead of opening the
    // user's browser or apps (src/main/index.js).
    env: { ...env, HORSEMD_TEST_RUN: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  const cdp = await connectCdp({ port, attempts: 80, intervalMs: 250 })
  await sleep(800)
  return { ...cdp, child, profileDir, launched: true }
}

export async function connectOrLaunchBuiltElectron({
  profileDir,
  port,
  cleanProfile = true,
  cwd = process.cwd()
}) {
  try {
    const cdp = await connectCdp({ port, attempts: 4, intervalMs: 150 })
    return { ...cdp, child: null, profileDir, launched: false }
  } catch {
    return launchBuiltElectron({ profileDir, port, cleanProfile, cwd })
  }
}

const waitForChildExit = (child, timeoutMs) => new Promise((resolve) => {
  if (!child || child.exitCode != null || child.signalCode != null) {
    resolve(true)
    return
  }
  let timer = null
  const onExit = () => {
    if (timer) clearTimeout(timer)
    resolve(true)
  }
  timer = setTimeout(() => {
    child.off('exit', onExit)
    resolve(false)
  }, timeoutMs)
  child.once('exit', onExit)
})

const removeProfileWithRetry = async (profileDir) => {
  const retryable = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM'])
  // Windows: Electron's helper processes can hold profile files (e.g.
  // Dictionaries) for seconds after the main process exits. A temp profile
  // left behind is not a test failure (fuzz seed 766, 2026-11-05).
  for (let attempt = 0; attempt < 14; attempt += 1) {
    try {
      await rm(profileDir, { recursive: true, force: true })
      return
    } catch (error) {
      if (!retryable.has(error?.code)) throw error
      if (attempt === 13) { console.warn(`[electron-test-app] profile left behind (${error.code}): ${profileDir}`); return }
      await sleep(Math.min(1000, 80 * (attempt + 1)))
    }
  }
}

// HM_TEST_ORACLE=1: before closing, check what the user would see — the
// editor document against what its current source reads back as (the
// reprint's own comparison) and no rich/source warning toast. One
// `HM_ORACLE {…}` line per app; checks behaviour whatever the test asserts.
async function logOracle(app) {
  if (process.env.HM_TEST_ORACLE !== '1' || typeof app?.evaluate !== 'function') return
  try {
    await sleep(1500)
    const result = await Promise.race([app.evaluate(`(() => {
      const H = globalThis.__hmSourceReprintHarness
      const toasts = [...document.querySelectorAll('.hm-toast-msg, [class*="toast"]')].map((n) => n.textContent || '')
      const warning = toasts.some((t) => /不一致|无法安全|保存已暂停|Save paused/.test(t))
      if (!H) return JSON.stringify({ harness: false, warning })
      const doc = H.liveDoc(); const source = H.liveSource()
      const equivalent = typeof source === 'string' ? H.equivalent(source, doc) : null
      // The reprint's own comparison (empty container paragraphs, ordered
      // numbers relaxed: no Markdown for them).
      const reprintEquivalent = typeof source === 'string' && H.equivalentForReprint ? H.equivalentForReprint(source, doc) : null
      const detail = equivalent === true ? {} : { source: String(source).slice(0, 600), doc: JSON.stringify(doc.toJSON()).slice(0, 1500) }
      return JSON.stringify({ harness: true, warning, equivalent, reprintEquivalent, chars: source?.length ?? null, ...detail })
    })()`), sleep(5000).then(() => JSON.stringify({ timeout: true }))])
    console.log('HM_ORACLE ' + result)
  } catch (error) {
    console.log('HM_ORACLE ' + JSON.stringify({ error: String(error?.message || error).slice(0, 120) }))
  }
}

export async function stopBuiltElectron(app, { removeProfile = false } = {}) {
  await logOracle(app)
  try {
    app?.ws?.close()
  } catch {}
  if (app?.child && app.child.exitCode == null && app.child.signalCode == null) {
    app.child.kill('SIGTERM')
    const exited = await waitForChildExit(app.child, 3000)
    if (!exited && app.child.exitCode == null && app.child.signalCode == null) {
      app.child.kill('SIGKILL')
      await waitForChildExit(app.child, 2000)
    }
  }
  if (app?.profileDir && process.platform === 'win32') await waitForProfileReleased(app.profileDir)
  if (removeProfile && app?.profileDir) {
    await removeProfileWithRetry(app.profileDir)
  }
}

// Windows: Electron's helper processes keep files in the profile open for a
// while after the main process exits, so a test's own `rm(root)` right after
// failed with EBUSY (test-highlight-bold-ui, fuzz seed 766). Windows refuses
// to rename a folder while anything inside is open: wait until it can.
async function waitForProfileReleased(profileDir, timeoutMs = 10000) {
  const probe = `${profileDir}.hm-release-probe`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await rename(profileDir, probe)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      await sleep(150)
      continue
    }
    // Put it back (nothing holds it now, but retry rather than lose it).
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await rename(probe, profileDir); return } catch { await sleep(100) }
    }
    return
  }
}
