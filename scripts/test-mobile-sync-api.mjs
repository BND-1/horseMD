// The phone's window.api offers every sync method the desktop preload does
// (Settings › 云同步 calls them by name on both). capacitor-api.js lists them
// one by one, in two branches (cloud sync on / off), and each must reach a
// method of platform/mobile-sync. 2026-11-20: 修改加密密码 and the unlock box
// said「当前平台暂不支持加密同步」on phones — both methods were missing.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const keys = (text) => new Set([...text.matchAll(/^\s*(sync[A-Z]\w*|onSyncProgress)\s*:/gm)].map((m) => m[1]))
const methods = (text) => new Set([...text.matchAll(/^\s*(?:async\s+)?(sync[A-Z]\w*)\s*[:(]/gm)].map((m) => m[1]))

const preload = keys(read('src/preload/index.js'))
const capacitor = read('src/renderer/src/platform/capacitor-api.js')
const block = capacitor.slice(capacitor.indexOf('const syncApi = () =>'), capacitor.indexOf('export function makeCapacitorApi'))
const [on, off] = block.split(/\n\s*:\s*\{/)
assert.ok(on && off, 'syncApi has its two branches')
const mobile = methods(read('src/renderer/src/platform/mobile-sync/index.js'))

assert.ok(preload.size > 10, `preload sync methods found: ${[...preload]}`)
for (const name of preload) {
  assert.ok(keys(on).has(name), `phone window.api (cloud sync on) lacks ${name}`)
  if (name !== 'onSyncProgress' && name !== 'syncControl' && name !== 'syncStatus') assert.ok(keys(off).has(name), `phone window.api (cloud sync off) lacks ${name}`)
  if (name !== 'onSyncProgress') assert.ok(mobile.has(name), `platform/mobile-sync lacks ${name}`)
}
console.log(`PASS mobile sync api: ${preload.size} desktop sync methods all on the phone`)
