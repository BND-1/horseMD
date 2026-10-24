// The user's command-line PATH for commands HorseMD runs on their behalf
// (the image-host upload command, issue #160).
//
// A macOS app started from Finder / the Dock (or a Linux app from the desktop
// menu) gets a bare PATH, /usr/bin:/bin:/usr/sbin:/sbin. Tools installed with
// Homebrew, npm (nvm / Volta / ~/.npm-global), pipx or ~/.local live outside
// it, and `picgo` is itself a `#!/usr/bin/env node` script, so even its full
// path fails without node on PATH. Like Typora and VS Code, read the PATH of
// the user's login shell once (`$SHELL -ilc`), and add common tool folders
// that exist. Windows apps inherit the user's PATH, so nothing changes there.
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { basename, delimiter, join } from 'node:path'

const MARK = '__HORSEMD_PATH__'

function commonDirs(home = homedir(), platform = process.platform) {
  const dirs = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin',
    join(home, '.local', 'bin'), join(home, 'bin'),
    join(home, '.npm-global', 'bin'), join(home, '.volta', 'bin'), join(home, '.bun', 'bin'),
    join(home, '.yarn', 'bin'), join(home, '.cargo', 'bin'),
    platform === 'darwin' ? join(home, 'Library', 'pnpm') : join(home, '.local', 'share', 'pnpm'),
    '/snap/bin'
  ]
  // nvm: every installed node's bin (newest name last is fine; PATH order
  // from the login shell already wins).
  try {
    const versions = join(home, '.nvm', 'versions', 'node')
    for (const name of readdirSync(versions)) dirs.push(join(versions, name, 'bin'))
  } catch { /* no nvm */ }
  return dirs.filter((dir) => existsSync(dir))
}

export function mergePath(...lists) {
  const seen = new Set()
  const out = []
  for (const list of lists) {
    for (const dir of String(list || '').split(delimiter)) {
      if (!dir || seen.has(dir)) continue
      seen.add(dir)
      out.push(dir)
    }
  }
  return out.join(delimiter)
}

// PATH printed by the login shell, or '' (timeout, no shell, odd output).
export function readLoginShellPath({ shell = process.env.SHELL, timeoutMs = 5000, env = process.env } = {}) {
  let account = ''
  try { account = userInfo().shell || '' } catch { /* no passwd entry */ }
  const candidate = shell || account || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  const fish = basename(candidate) === 'fish'
  // Markers: profile scripts may print banners around it.
  const script = fish
    ? `printf '${MARK}%s${MARK}' (string join : $PATH)`
    : `printf '${MARK}%s${MARK}' "$PATH"`
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (value) => { if (!done) { done = true; resolve(value) } }
    let child
    try {
      child = spawn(candidate, ['-ilc', script], {
        env: { ...env, HORSEMD_RESOLVING_SHELL_ENV: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: false
      })
    } catch {
      finish('')
      return
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } finish('') }, timeoutMs)
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => { clearTimeout(timer); finish('') })
    child.on('close', () => {
      clearTimeout(timer)
      const match = out.match(new RegExp(`${MARK}([^]*?)${MARK}`))
      finish(match ? match[1].trim() : '')
    })
  })
}

let cached = null

/** PATH for commands run for the user (cached; resolved once per launch). */
export function userCommandPath() {
  if (process.platform === 'win32') return Promise.resolve(process.env.PATH || '')
  cached ??= readLoginShellPath().then((login) => mergePath(login, process.env.PATH, commonDirs().join(delimiter)))
  return cached
}

/** Environment for a user command: process env with the user's PATH. */
export async function userCommandEnv() {
  return { ...process.env, PATH: await userCommandPath() }
}
