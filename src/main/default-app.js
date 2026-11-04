// Default Markdown editor (#170): Settings › 通用 › 默认打开方式.
//   defaultApp:get → { supported, isDefault, current, platform }
//   defaultApp:set → macOS: the system's own confirmation dialog, resolved
//                    with the new state once the user answers;
//                    Windows: the "Open with" dialog for a small HorseMD
//                    file — the user picks HorseMD (and 始终); HorseMD then
//                    receives that file, which we swallow (isProbeFile) and
//                    report as 'default-app:changed';
//                    Linux: xdg-mime default (no prompt).
// Nothing changes without the user's click (and, on macOS / Windows, the
// system's own confirmation). Pure parts: default-app-core.js.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import {
  LINUX_MIME_TYPES,
  MAC_DEFAULT_APP_SCRIPT,
  WINDOWS_QUERY_SCRIPT,
  desktopExecProgram,
  parseDesktopEntry,
  pickLinuxDesktopFile,
  windowsDefaultState
} from './default-app-core.js'
import { macBundlePath } from './update-core.js'

const execFileAsync = promisify(execFile)
// Tests: a JSON file standing in for the OS ({ isDefault, current });
// 'set' makes HorseMD the default there.
const TEST_STATE = process.env.HORSEMD_TEST_DEFAULT_APP || ''

const encodePowerShell = (script) => Buffer.from(script, 'utf16le').toString('base64')

async function windowsState(execPath) {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(WINDOWS_QUERY_SCRIPT)], { windowsHide: true, timeout: 15000, encoding: 'utf8' })
  return windowsDefaultState(stdout.trim(), execPath)
}

async function macState(bundle, mode) {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'horsemd-default-'))
  const script = join(dir, 'default-app.js')
  try {
    await fsp.writeFile(script, MAC_DEFAULT_APP_SCRIPT, 'utf8')
    const { stdout } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', script, mode, bundle], { timeout: mode === 'set' ? 200000 : 15000, encoding: 'utf8' })
    const data = JSON.parse(stdout.trim())
    return { isDefault: data.isDefault === true, current: String(data.current || '') }
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ---- Linux: our .desktop file (electron-builder names it after the package)

function linuxApplicationDirs() {
  const home = process.env.HOME || ''
  const dataHome = process.env.XDG_DATA_HOME || (home ? join(home, '.local/share') : '')
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean)
  return [dataHome, ...dataDirs].filter(Boolean).map((dir) => join(dir, 'applications'))
}

function resolveProgram(program) {
  if (!program) return ''
  let file = program
  if (!program.includes('/')) {
    file = (process.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(delimiter).map((dir) => join(dir, program)).find((candidate) => fs.existsSync(candidate)) || ''
  }
  if (!file) return ''
  try { return fs.realpathSync(file) } catch { return resolve(file) }
}

function linuxDesktopId(execPath) {
  const real = resolveProgram(execPath) || execPath
  const candidates = []
  for (const dir of linuxApplicationDirs()) {
    let names = []
    try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.desktop')) } catch { continue }
    for (const name of names) {
      let text = ''
      try { text = fs.readFileSync(join(dir, name), 'utf8') } catch { continue }
      if (!/horse/i.test(text)) continue
      candidates.push({ id: name, text, programPath: resolveProgram(desktopExecProgram(parseDesktopEntry(text).Exec)) })
    }
  }
  return pickLinuxDesktopFile(candidates, real)
}

function linuxDesktopName(id) {
  for (const dir of linuxApplicationDirs()) {
    try { return parseDesktopEntry(fs.readFileSync(join(dir, id), 'utf8')).Name || id.replace(/\.desktop$/, '') } catch { /* next */ }
  }
  return id ? id.replace(/\.desktop$/, '') : ''
}

async function linuxState(ownId) {
  const { stdout } = await execFileAsync('xdg-mime', ['query', 'default', LINUX_MIME_TYPES[0]], { timeout: 10000, encoding: 'utf8' })
  const current = stdout.trim()
  return { isDefault: current === ownId, current: current === ownId ? '' : linuxDesktopName(current) }
}

export function registerDefaultApp({ app, ipcMain, sendToRenderer, log = null }) {
  const trace = (entry) => { try { log?.({ kind: 'default-app', ...entry }) } catch { /* never breaks */ } }
  const platform = process.platform
  let probeFile = ''
  let linuxId

  const supported = () => {
    if (TEST_STATE) return true
    // An unpackaged run is node_modules' Electron: never make it the default.
    if (!app.isPackaged) return false
    if (platform === 'darwin') return Boolean(macBundlePath(process.execPath))
    if (platform === 'linux') {
      if (linuxId === undefined) linuxId = linuxDesktopId(process.execPath)
      return Boolean(linuxId)
    }
    return platform === 'win32'
  }

  const readTestState = () => {
    try { return JSON.parse(fs.readFileSync(TEST_STATE, 'utf8')) } catch { return { isDefault: false, current: '' } }
  }

  async function getState() {
    if (!supported()) return { supported: false, platform }
    try {
      let state
      if (TEST_STATE) state = readTestState()
      else if (platform === 'darwin') state = await macState(macBundlePath(process.execPath), 'get')
      else if (platform === 'win32') state = await windowsState(process.execPath)
      else state = await linuxState(linuxId)
      return { supported: true, platform, isDefault: state.isDefault === true, current: String(state.current || '') }
    } catch (error) {
      trace({ step: 'get-failed', message: String(error?.message || error).slice(0, 300) })
      return { supported: true, platform, isDefault: false, current: '', error: true }
    }
  }

  // Windows: the file the "Open with" dialog is shown for. If the user picks
  // HorseMD, Windows opens it with us — that open is swallowed.
  async function windowsProbeFile() {
    const dir = join(app.getPath('temp'), 'HorseMD')
    await fsp.mkdir(dir, { recursive: true })
    const file = join(dir, 'HorseMD.md')
    await fsp.writeFile(file, '# HorseMD\n\n这个文件只用来设置 .md 文件的默认打开方式，可以关掉。\nThis file only sets the default app for .md files; you can close it.\n', 'utf8')
    return file
  }

  ipcMain.handle('defaultApp:get', () => getState())

  ipcMain.handle('defaultApp:set', async () => {
    if (!supported()) return { supported: false, platform }
    trace({ step: 'set', platform })
    try {
      if (TEST_STATE) {
        fs.writeFileSync(TEST_STATE, JSON.stringify({ isDefault: true, current: '' }))
      } else if (platform === 'darwin') {
        await macState(macBundlePath(process.execPath), 'set')
      } else if (platform === 'win32') {
        probeFile = await windowsProbeFile()
        // OpenAs_RunDLL takes the rest of the command line as the path.
        spawn('rundll32.exe', [`shell32.dll,OpenAs_RunDLL ${probeFile}`], { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true }).unref()
        return { ...(await getState()), pending: true }
      } else {
        await execFileAsync('xdg-mime', ['default', linuxId, ...LINUX_MIME_TYPES], { timeout: 10000 })
      }
    } catch (error) {
      trace({ step: 'set-failed', message: String(error?.message || error).slice(0, 300) })
    }
    const state = await getState()
    trace({ step: 'set-done', isDefault: state.isDefault })
    return state
  })

  return {
    // A launch / second-instance path that is the Windows probe file: the
    // user picked HorseMD in the "Open with" dialog. Not opened as a tab.
    isProbeFile(path) {
      if (!probeFile || !path) return false
      const same = platform === 'win32' ? resolve(path).toLowerCase() === resolve(probeFile).toLowerCase() : resolve(path) === resolve(probeFile)
      if (!same) return false
      trace({ step: 'probe-opened' })
      setTimeout(() => sendToRenderer?.('default-app:changed'), 300)
      return true
    }
  }
}
