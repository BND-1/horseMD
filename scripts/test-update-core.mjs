// In-app update (#164), pure part: which release asset each install gets and
// how it is installed, checksum parsing, version order, macOS bundle paths.
import assert from 'node:assert/strict'
import {
  compareVersions,
  macBundlePath,
  macBundleReplaceable,
  parseChecksums,
  pickUpdateAsset,
  plistVersion
} from '../src/main/update-core.js'

const names = [
  'horse-0.13.257-x86_64.pkg.tar.xz', 'HorseMD-0.13.257-android.apk',
  'HorseMD-0.13.257-arm64-mac.zip', 'HorseMD-0.13.257-arm64-mac.zip.blockmap', 'HorseMD-0.13.257-arm64.dmg',
  'HorseMD-0.13.257-mac.zip', 'HorseMD-0.13.257.dmg', 'HorseMD-Setup-0.13.257.exe', 'HorseMD-Setup-0.13.257.exe.blockmap',
  'horse_0.13.257_amd64.deb', 'latest.yml', 'latest-mac.yml', 'SHA256SUMS.txt'
]
const assets = names.map((name) => ({ name, url: `https://example.com/${name}`, size: 1 }))
const pick = (opts) => {
  const r = pickUpdateAsset({ assets, version: '0.13.257', ...opts })
  return r && [r.asset.name, r.mode]
}

assert.deepEqual(pick({ platform: 'win32', arch: 'x64' }), ['HorseMD-Setup-0.13.257.exe', 'install'])
assert.deepEqual(pick({ platform: 'win32', arch: 'arm64' }), ['HorseMD-Setup-0.13.257.exe', 'install'])
assert.deepEqual(pick({ platform: 'darwin', arch: 'arm64', macWritable: true }), ['HorseMD-0.13.257-arm64-mac.zip', 'install'])
assert.deepEqual(pick({ platform: 'darwin', arch: 'x64', macWritable: true }), ['HorseMD-0.13.257-mac.zip', 'install'])
// Not replaceable in place (read-only, disk image, translocated): the dmg is opened.
assert.deepEqual(pick({ platform: 'darwin', arch: 'arm64', macWritable: false }), ['HorseMD-0.13.257-arm64.dmg', 'open'])
assert.deepEqual(pick({ platform: 'darwin', arch: 'x64', macWritable: false }), ['HorseMD-0.13.257.dmg', 'open'])
assert.deepEqual(pick({ platform: 'linux', arch: 'x64', linuxPackage: 'deb' }), ['horse_0.13.257_amd64.deb', 'reveal'])
assert.deepEqual(pick({ platform: 'linux', arch: 'x64', linuxPackage: 'pacman' }), ['horse-0.13.257-x86_64.pkg.tar.xz', 'reveal'])
// No package for this install → GitHub only.
assert.equal(pick({ platform: 'linux', arch: 'x64', linuxPackage: null }), null)
assert.equal(pick({ platform: 'linux', arch: 'arm64', linuxPackage: 'deb' }), null)
assert.equal(pick({ platform: 'android', arch: 'arm64' }), null)
// Another version's assets, or a malformed version, never match.
assert.equal(pickUpdateAsset({ assets, version: '0.13.258', platform: 'win32', arch: 'x64' }), null)
assert.equal(pickUpdateAsset({ assets, version: '0.13.257.*', platform: 'win32', arch: 'x64' }), null)
assert.equal(pickUpdateAsset({ assets: [{ name: 'HorseMD-Setup-0x13x257.exe' }], version: '0.13.257', platform: 'win32', arch: 'x64' }), null)
assert.deepEqual(pickUpdateAsset({ assets, version: 'v0.13.257', platform: 'win32', arch: 'x64' })?.asset.name, 'HorseMD-Setup-0.13.257.exe')

const sums = parseChecksums('f005a52df1e370f21884b11c6782aa1cc1fdf8025095db38edc370fef4d410fc  horse-0.13.256-x86_64.pkg.tar.xz\r\n6197A8632EA972B1324281406F4BE386DAD60579E21BFC158DA7265C0D9E3C38 *HorseMD-Setup-0.13.256.exe\nnot a line\n')
assert.equal(sums.get('horse-0.13.256-x86_64.pkg.tar.xz'), 'f005a52df1e370f21884b11c6782aa1cc1fdf8025095db38edc370fef4d410fc')
assert.equal(sums.get('HorseMD-Setup-0.13.256.exe'), '6197a8632ea972b1324281406f4be386dad60579e21bfc158da7265c0d9e3c38')
assert.equal(sums.size, 2)

assert.equal(compareVersions('0.13.257', '0.13.256'), 1)
assert.equal(compareVersions('0.13.256', '0.13.256'), 0)
assert.equal(compareVersions('0.13.29', '0.13.256'), -1)
assert.equal(compareVersions('v1.0.0', '0.99.99'), 1)

assert.equal(macBundlePath('/Applications/HorseMD.app/Contents/MacOS/HorseMD'), '/Applications/HorseMD.app')
assert.equal(macBundlePath('/Users/a/My Apps/HorseMD.app/Contents/MacOS/HorseMD'), '/Users/a/My Apps/HorseMD.app')
assert.equal(macBundlePath('/usr/bin/node'), null)
assert.equal(macBundleReplaceable('/Applications/HorseMD.app'), true)
assert.equal(macBundleReplaceable('/Volumes/HorseMD 0.13.257/HorseMD.app'), false)
assert.equal(macBundleReplaceable('/private/var/folders/x/AppTranslocation/ABC/d/HorseMD.app'), false)

assert.equal(plistVersion('<dict><key>CFBundleShortVersionString</key>\n\t<string>0.13.257</string></dict>'), '0.13.257')
assert.equal(plistVersion('<dict></dict>'), null)

console.log('PASS update core: asset per platform / install mode, checksums, versions, macOS bundle paths')
