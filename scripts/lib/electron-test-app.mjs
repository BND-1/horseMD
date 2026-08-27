import { rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import electronPath from 'electron'
import { connectCdp, sleep } from './cdp.mjs'

export async function launchBuiltElectron({
  profileDir,
  port,
  cleanProfile = true,
  cwd = process.cwd(),
  appArgs = [],
  executable = electronPath,
  entrypoint = 'out/main/index.cjs',
  background = true,
  env = process.env
}) {
  if (cleanProfile && profileDir) await rm(profileDir, { recursive: true, force: true })
  const child = spawn(executable, [
    ...(profileDir ? [`--user-data-dir=${profileDir}`] : []),
    `--remote-debugging-port=${port}`,
    ...(entrypoint ? [entrypoint] : []),
    ...(background ? ['--horsemd-test-background'] : []),
    ...appArgs
  ], {
    cwd,
    env,
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
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(profileDir, { recursive: true, force: true })
      return
    } catch (error) {
      if (!retryable.has(error?.code) || attempt === 5) throw error
      await sleep(80 * (attempt + 1))
    }
  }
}

export async function stopBuiltElectron(app, { removeProfile = false } = {}) {
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
  if (removeProfile && app?.profileDir) {
    await removeProfileWithRetry(app.profileDir)
  }
}
