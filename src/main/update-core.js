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
