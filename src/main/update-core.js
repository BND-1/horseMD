// In-app update (#164), pure part — no Electron, locked by
// scripts/test-update-core.mjs.
//
// Which asset of a GitHub release this install should download, and what to
// do with it:
//   install  — replaced in place on restart (Windows: the NSIS installer run
//              silently; macOS: the .app from the zip swapped in by a script —
//              Squirrel.Mac needs a signed app, HorseMD is unsigned)
//   open     — downloaded and opened for the user (a macOS app that cannot be
//              replaced in place: not writable, or run from a disk image)
//   reveal   — downloaded and shown in the folder (Linux packages need the
//              administrator password to install)

const VERSION = String.raw`\d+\.\d+\.\d+`

export function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

// "hash  name" lines (sha256sum output), name → lower-case hex.
export function parseChecksums(text) {
  const sums = new Map()
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/)
    if (m) sums.set(m[2].trim(), m[1].toLowerCase())
  }
  return sums
}

// /Applications/HorseMD.app/Contents/MacOS/HorseMD → /Applications/HorseMD.app
export function macBundlePath(execPath) {
  const m = String(execPath || '').match(/^(.*?\.app)\/Contents\/MacOS\/[^/]+$/)
  return m ? m[1] : null
}

// A bundle macOS runs from a randomized read-only copy (Gatekeeper path
// translocation) or from a mounted disk image cannot be replaced in place.
export function macBundleReplaceable(bundle) {
  if (!bundle) return false
  return !/\/AppTranslocation\//.test(bundle) && !/^\/Volumes\//.test(bundle)
}

// platform / arch: process.platform / process.arch. linuxPackage: 'deb' |
// 'pacman' | null (how this copy was installed). macWritable: whether the
// .app (and its folder) can be replaced.
export function pickUpdateAsset({ assets = [], version, platform, arch, linuxPackage = null, macWritable = false }) {
  const v = String(version || '').replace(/^v/i, '').replace(/\./g, '\\.')
  const find = (re) => assets.find((asset) => re.test(asset?.name || ''))
  if (!new RegExp(`^${VERSION}$`).test(String(version || '').replace(/^v/i, ''))) return null
  if (platform === 'win32') {
    const asset = find(new RegExp(`^HorseMD-Setup-${v}\\.exe$`))
    return asset ? { asset, mode: 'install' } : null
  }
  if (platform === 'darwin') {
    const suffix = arch === 'arm64' ? '-arm64' : ''
    if (macWritable) {
      const zip = find(new RegExp(`^HorseMD-${v}${suffix}-mac\\.zip$`))
      if (zip) return { asset: zip, mode: 'install' }
    }
    const dmg = find(new RegExp(`^HorseMD-${v}${suffix}\\.dmg$`))
    return dmg ? { asset: dmg, mode: 'open' } : null
  }
  if (platform === 'linux' && arch === 'x64') {
    if (linuxPackage === 'deb') {
      const asset = find(new RegExp(`^horse_${v}_amd64\\.deb$`))
      return asset ? { asset, mode: 'reveal' } : null
    }
    if (linuxPackage === 'pacman') {
      const asset = find(new RegExp(`^horse-${v}-x86_64\\.pkg\\.tar\\.xz$`))
      return asset ? { asset, mode: 'reveal' } : null
    }
  }
  return null
}

// CFBundleShortVersionString of an Info.plist (XML, as electron-builder writes it).
export function plistVersion(xml) {
  const m = String(xml || '').match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)
  return m ? m[1].trim() : null
}

// Download sources for a release asset: GitHub itself, then public GitHub
// download mirrors. From mainland China github.com often runs at ~10–50 KB/s
// (a 130 MB installer: hours) while a mirror gives ~0.3–0.9 MB/s (measured
// 2026-10-26 on the Windows test PC). Mirrors only carry bytes: the SHA-256
// always comes from GitHub (the API's asset digest, else SHA256SUMS.txt
// fetched from github.com), so a bad mirror can waste a download, never
// install something else. Public mirrors come and go — several are tried.
export const DEFAULT_MIRRORS = ['https://ghfast.top/', 'https://gh-proxy.com/']
const GITHUB_DOWNLOAD = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//

export function downloadSources(url, mirrors = DEFAULT_MIRRORS, { anyUrl = false } = {}) {
  const sources = [{ url, via: 'direct' }]
  if (anyUrl || GITHUB_DOWNLOAD.test(url)) {
    for (const prefix of mirrors) sources.push({ url: prefix + url, via: hostOf(prefix) })
  }
  return sources
}

export function hostOf(url) {
  try { return new URL(url).host } catch { return String(url || '') }
}

// probes: [{ source, speed (bytes/s), ok }]. Fastest first; GitHub itself
// wins when it is at least DIRECT_SHARE of the best (one hop fewer, no third
// party). Sources whose probe failed stay at the end, as a last resort.
export const DIRECT_SHARE = 0.7
export function rankSources(probes) {
  const ok = probes.filter((p) => p.ok && p.speed > 0).sort((a, b) => b.speed - a.speed)
  const failed = probes.filter((p) => !(p.ok && p.speed > 0))
  const direct = ok.find((p) => p.source.via === 'direct')
  if (direct && ok.length && direct !== ok[0] && direct.speed >= ok[0].speed * DIRECT_SHARE) {
    ok.splice(ok.indexOf(direct), 1)
    ok.unshift(direct)
  }
  return [...ok, ...failed].map((p) => p.source)
}

// "sha256:<hex>" (GitHub's asset digest) → hex, else null.
export function digestSha256(digest) {
  const m = String(digest || '').match(/^sha256:([0-9a-fA-F]{64})$/)
  return m ? m[1].toLowerCase() : null
}
