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
  entrypoint = 'out/main/index.cjs'
}) {
  if (cleanProfile && profileDir) await rm(profileDir, { recursive: true, force: true })
  const child = spawn(executable, [
    ...(profileDir ? [`--user-data-dir=${profileDir}`] : []),
    `--remote-debugging-port=${port}`,
    ...(entrypoint ? [entrypoint] : []),
    ...appArgs
  ], {
    cwd,
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

export async function stopBuiltElectron(app, { removeProfile = false } = {}) {
  try {
    app?.ws?.close()
  } catch {}
  if (app?.child && app.child.exitCode == null) {
    app.child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolve) => app.child.once('exit', resolve)),
      sleep(3000).then(() => {
        if (app.child.exitCode == null) app.child.kill('SIGKILL')
      })
    ])
  }
  if (removeProfile && app?.profileDir) {
    await rm(app.profileDir, { recursive: true, force: true })
  }
}
