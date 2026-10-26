// In-app update (#164): check → download (progress, SHA-256 checked against
// the release's SHA256SUMS.txt) → install on restart.
//
// Only assets of the release this process fetched itself are downloaded —
// the renderer never passes a URL. Requests go through Chromium's network
// stack (net.request, as sync does: Node's fetch can abort an unsigned app
// under launchd). Install happens in 'will-quit', so the normal quit path
// runs first: the renderer's unsaved-changes confirm can cancel it.
//   Windows: the NSIS installer, `--updated /S --force-run` (silent, same
//            folder, starts HorseMD again) — what electron-updater runs.
//   macOS:   a detached shell script waits for this process to exit, swaps
//            the .app from the release zip in, clears quarantine and opens
//            it. (Squirrel.Mac requires a signed app; HorseMD is unsigned.)
// See update-core.js for which asset / mode a platform gets.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createElectronRequest } from './sync/electron-request.js'
import {
  compareVersions,
  macBundlePath,
  macBundleReplaceable,
  parseChecksums,
  pickUpdateAsset,
  plistVersion
} from './update-core.js'

const execFileAsync = promisify(execFile)
// Tests point this at a local server (scripts/test-update-ui.mjs).
const TEST_FEED = process.env.HORSEMD_TEST_UPDATE_FEED || ''
const FEED = TEST_FEED || 'https://api.github.com/repos/BND-1/horseMD/releases/latest'
// Release assets are downloaded over HTTPS only (a test feed may serve them
// from 127.0.0.1).
const allowedUrl = (url) => /^https:\/\//.test(url) || (Boolean(TEST_FEED) && /^http:\/\/127\.0\.0\.1[:/]/.test(url))
const RELEASES_PAGE = 'https://github.com/BND-1/horseMD/releases'
const STALL_MS = 60000
// Packaged: package.json's version (app.getVersion()). Unpackaged (dev,
// tests): app.getVersion() is Electron's own, so the build-time define.
/* global __APP_VERSION__ */
const currentVersion = (app) => (app.isPackaged || typeof __APP_VERSION__ === 'undefined' ? app.getVersion() : __APP_VERSION__)
const PROGRESS_EVERY_MS = 200

function linuxPackage() {
  try {
    if (fs.existsSync('/var/lib/dpkg/info/horse.list')) return 'deb'
    if (fs.readdirSync('/var/lib/pacman/local').some((name) => /^horse-\d/.test(name))) return 'pacman'
  } catch { /* not that kind of system */ }
  return null
}

function macWritable(bundle) {
  if (!macBundleReplaceable(bundle)) return false
  try {
    fs.accessSync(bundle, fs.constants.W_OK)
    fs.accessSync(dirname(bundle), fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

export function registerUpdater({ app, ipcMain, net, shell, sendToRenderer, requestQuit, log = null }) {
  const request = createElectronRequest(net)
  let release = null // the last release fetched by update:check
  let state = { status: 'idle' }
  let controller = null
  let cancelling = false
  let pendingInstall = null

  const publish = (next) => {
    state = next
    sendToRenderer?.('update:state', state)
  }
  const trace = (entry) => { try { log?.({ kind: 'update', ...entry }) } catch { /* never breaks */ } }

  const target = () => {
    if (!release) return null
    const bundle = process.platform === 'darwin' ? macBundlePath(process.execPath) : null
    return pickUpdateAsset({
      assets: release.assets,
      version: release.version,
      platform: process.platform,
      arch: process.arch,
      linuxPackage: process.platform === 'linux' ? linuxPackage() : null,
      macWritable: process.platform === 'darwin' && macWritable(bundle)
    })
  }

  async function fetchRelease() {
    const res = await request(FEED, {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HorseMD-Updater' },
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    release = {
      version: String(data.tag_name || '').replace(/^v/i, ''),
      url: data.html_url || RELEASES_PAGE,
      name: typeof data.name === 'string' ? data.name : '',
      notes: typeof data.body === 'string' ? data.body.slice(0, 4000) : '',
      assets: (Array.isArray(data.assets) ? data.assets : [])
        .filter((asset) => asset && typeof asset.name === 'string' && allowedUrl(String(asset.browser_download_url || '')))
        .map((asset) => ({ name: asset.name, url: asset.browser_download_url, size: Number(asset.size) || 0 }))
    }
    return release
  }

  // Check: same answer shape as before (notify-only callers keep working),
  // plus whether this install can download directly and how.
  ipcMain.handle('update:check', async () => {
    try {
      const r = await fetchRelease()
      const picked = target()
      return {
        ok: true,
        latest: r.version,
        current: currentVersion(app),
        url: r.url,
        name: r.name,
        notes: r.notes,
        download: picked ? { mode: picked.mode, size: picked.asset.size } : null
      }
    } catch {
      return { ok: false }
    }
  })

  ipcMain.handle('update:getState', () => state)

  async function readText(url, signal) {
    const res = await request(url, { method: 'GET', signal, headers: { 'User-Agent': 'HorseMD-Updater' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.text()
  }

  async function download() {
    if (state.status === 'downloading') return state
    if (state.status === 'ready' && state.version === release?.version) return state
    if (!release) await fetchRelease()
    if (compareVersions(release.version, currentVersion(app)) <= 0) throw new Error('已经是最新版本。')
    const picked = target()
    if (!picked) throw new Error('这个系统没有可以直接下载的安装包，请到 GitHub 下载。')
    const { asset, mode } = picked
    controller = new AbortController()
    cancelling = false
    const { signal } = controller
    const version = release.version
    publish({ status: 'downloading', version, mode, name: asset.name, received: 0, total: asset.size })
    trace({ step: 'download', version, asset: asset.name, mode })

    const sumsAsset = release.assets.find((item) => item.name === 'SHA256SUMS.txt')
    if (!sumsAsset) throw new Error('这个版本缺少校验文件（SHA256SUMS.txt），为安全起见不能直接下载。')
    const expected = parseChecksums(await readText(sumsAsset.url, signal)).get(asset.name)
    if (!expected) throw new Error(`校验文件里没有 ${asset.name}，为安全起见不能直接下载。`)

    // install: a private folder; open / reveal: the user's Downloads.
    const dir = mode === 'install' ? join(app.getPath('temp'), 'horsemd-update', version) : app.getPath('downloads')
    await fsp.mkdir(dir, { recursive: true })
    const file = join(dir, asset.name)
    const part = `${file}.part`
    const res = await request(asset.url, { method: 'GET', signal, headers: { 'User-Agent': 'HorseMD-Updater' } })
    if (!res.ok || !res.body) throw new Error(`下载失败（HTTP ${res.status}）。`)
    const total = Number(res.headers.get('content-length')) || asset.size
    const hash = createHash('sha256')
    const out = fs.createWriteStream(part)
    let received = 0
    let lastSent = 0
    let stall = null
    const armStall = () => {
      clearTimeout(stall)
      stall = setTimeout(() => controller?.abort(new Error('stall')), STALL_MS)
    }
    try {
      armStall()
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        armStall()
        hash.update(value)
        received += value.length
        if (!out.write(value)) await new Promise((resolve) => out.once('drain', resolve))
        const now = Date.now()
        if (now - lastSent >= PROGRESS_EVERY_MS) {
          lastSent = now
          publish({ ...state, received, total })
        }
      }
      await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())))
    } catch (error) {
      out.destroy()
      await fsp.rm(part, { force: true })
      if (signal.aborted && signal.reason?.message === 'stall') throw new Error('下载长时间没有进展，已停止。请检查网络后重试。')
      throw error
    } finally {
      clearTimeout(stall)
    }
    const got = hash.digest('hex')
    if (got !== expected) {
      await fsp.rm(part, { force: true })
      trace({ step: 'checksum-mismatch', asset: asset.name })
      throw new Error('下载的文件校验不一致，已删除。请重试，或到 GitHub 下载。')
    }
    await fsp.rm(file, { force: true })
    await fsp.rename(part, file)

    let installFrom = file
    if (process.platform === 'darwin' && mode === 'install') {
      const unpacked = join(dir, 'app')
      await fsp.rm(unpacked, { recursive: true, force: true })
      await fsp.mkdir(unpacked, { recursive: true })
      await execFileAsync('/usr/bin/ditto', ['-x', '-k', file, unpacked])
      const name = (await fsp.readdir(unpacked)).find((entry) => entry.endsWith('.app'))
      if (!name) throw new Error('更新包里没有找到 HorseMD.app。')
      installFrom = join(unpacked, name)
      const plist = await fsp.readFile(join(installFrom, 'Contents', 'Info.plist'), 'utf8')
      if (plistVersion(plist) !== version) throw new Error('更新包的版本号不对，已停止。')
    }
    controller = null
    trace({ step: 'ready', version, asset: asset.name })
    if (mode === 'open') shell.openPath(file)
    if (mode === 'reveal') shell.showItemInFolder(file)
    publish({ status: 'ready', version, mode, name: asset.name, received, total, file, installFrom })
    return state
  }

  ipcMain.handle('update:download', async () => {
    try {
      return await download()
    } catch (error) {
      controller = null
      if (cancelling) {
        cancelling = false
        publish({ status: 'idle' })
      } else {
        trace({ step: 'error', message: String(error?.message || error).slice(0, 300) })
        publish({ ...state, status: 'error', error: String(error?.message || error).replace(/^Error: /, '') })
      }
      return state
    }
  })

  ipcMain.handle('update:cancel', () => {
    if (state.status !== 'downloading') return state
    cancelling = true
    controller?.abort()
    return state
  })

  // Open / reveal what was downloaded (open / reveal modes, after the fact).
  ipcMain.handle('update:showFile', () => {
    if (state.status !== 'ready' || !state.file) return false
    if (state.mode === 'open') shell.openPath(state.file)
    else shell.showItemInFolder(state.file)
    return true
  })

  ipcMain.handle('update:install', () => {
    if (state.status !== 'ready' || state.mode !== 'install') return false
    // Never in a dev / test run: the "app" there is node_modules' Electron.
    if (!app.isPackaged) {
      trace({ step: 'install-refused-unpackaged' })
      return false
    }
    pendingInstall = { ...state }
    trace({ step: 'install-requested', version: state.version })
    requestQuit()
    return true
  })

  return {
    // The user kept the app open (unsaved-changes confirm cancelled).
    cancelPendingInstall() { pendingInstall = null },
    // 'will-quit': start the installer / swap script, detached.
    runPendingInstall() {
      const job = pendingInstall
      pendingInstall = null
      if (!job) return
      try {
        if (process.platform === 'win32') {
          spawn(job.installFrom, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
        } else if (process.platform === 'darwin') {
          const bundle = macBundlePath(process.execPath)
          const script = join(dirname(job.file), 'install.sh')
          fs.writeFileSync(script, MAC_SWAP_SCRIPT, { mode: 0o755 })
          spawn('/bin/sh', [script, String(process.pid), job.installFrom, bundle], { detached: true, stdio: 'ignore' }).unref()
        }
        trace({ step: 'install-started', version: job.version })
      } catch (error) {
        trace({ step: 'install-failed', message: String(error?.message || error) })
      }
    }
  }
}

// Waits for HorseMD to exit, swaps the bundle (the old one is kept until the
// new one is in place, and put back if the move fails), clears quarantine and
// opens the result.
const MAC_SWAP_SCRIPT = `#!/bin/sh
PID="$1"; NEW="$2"; DEST="$3"
i=0
while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 240 ]; do sleep 0.25; i=$((i + 1)); done
OLD="$DEST.horsemd-old-$$"
if mv "$DEST" "$OLD"; then
  if mv "$NEW" "$DEST"; then
    xattr -dr com.apple.quarantine "$DEST" 2>/dev/null
    rm -rf "$OLD"
  else
    mv "$OLD" "$DEST"
  fi
fi
open "$DEST"
`

export { RELEASES_PAGE }
