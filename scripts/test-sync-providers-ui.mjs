// 云同步 › 云端连接 in the real app (SyncConnections.jsx):
//   - no connection: the service gallery (5 services, each with its own logo,
//     + 其他 WebDAV / S3);
//   - a service: what to prepare, only its fields, back to the gallery,
//     「使用完整设置」 switches to the full form prefilled;
//   - connections saved before services existed show as their service
//     (recognized by address); editing one that fits opens the service form,
//     one that does not (custom address) the full form — saved values
//     untouched;
//   - with real accounts (env only, never stored: HM_QINIU_AK/SK/BUCKET/REGION,
//     HM_CSTCLOUD_AK/SK/BUCKET): a wrong region / client is explained at its
//     field, the right one saves a card; connections.json gets `provider`.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-sync-providers-ui-'))
const profileDir = join(root, 'profile')
const port = 29860 + process.pid % 40
const env = process.env
const qiniu = env.HM_QINIU_AK && { ak: env.HM_QINIU_AK, sk: env.HM_QINIU_SK, bucket: env.HM_QINIU_BUCKET, region: env.HM_QINIU_REGION || 'cn-south-1' }
const cstcloud = env.HM_CSTCLOUD_AK && { ak: env.HM_CSTCLOUD_AK, sk: env.HM_CSTCLOUD_SK, bucket: env.HM_CSTCLOUD_BUCKET }
let app = null

const waitFor = async (check, message, attempts = 80) => {
  let last
  for (let i = 0; i < attempts; i += 1) { last = await check(); if (last) return last; await sleep(100) }
  throw new Error(`${message}: ${JSON.stringify(last)}`)
}
const openSync = () => app.evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const visible = (e) => e && e.getBoundingClientRect().width > 0
  const t0 = Date.now()
  while (!document.querySelector('.tabs, .welcome') && Date.now() - t0 < 15000) await sleep(100)
  ;[...document.querySelectorAll('button')].filter(visible).find((b) => /settings|设置/i.test(b.title || b.textContent || '')).click()
  await sleep(400)
  ;[...document.querySelectorAll('.settings-nav-item')].filter(visible).find((b) => /云同步|cloud sync/i.test(b.textContent || '')).click()
  await sleep(500)
  return true
})()`)
const state = () => app.evaluate(`(() => {
  const q = (s) => document.querySelector(s)
  const panel = q('.sync-provider-panel')
  return {
    gallery: !!q('.sync-provider-gallery'),
    tiles: [...document.querySelectorAll('.sync-provider-row:not(.generic)')].map((b) => b.dataset.provider),
    generic: [...document.querySelectorAll('.sync-provider-row.generic')].map((b) => b.dataset.provider),
    // Each service's own logo, loaded (a broken import shows nothing).
    logos: [...document.querySelectorAll('.sync-provider-row:not(.generic) .sync-provider-mark.logo img')].map((i) => i.complete && i.naturalWidth > 0 ? i.closest('[data-logo]').dataset.logo : 'broken'),
    addButton: !!q('[data-sync-add]'),
    panel: panel ? panel.querySelector('.sync-provider-panel-title strong')?.textContent : null,
    steps: panel ? panel.querySelectorAll('.sync-provider-prepare li').length : 0,
    fields: [...document.querySelectorAll('.sync-provider-form .sync-field-label, .sync-form .sync-field-label')].map((n) => n.textContent),
    values: Object.fromEntries([...document.querySelectorAll('.sync-provider-form input, .sync-provider-form select, .sync-form input')].map((n) => [n.id, n.value])),
    fullForm: !!q('.sync-form'),
    error: q('.sync-provider-error')?.textContent || '',
    invalid: [...document.querySelectorAll('.sync-field-invalid')].map((n) => n.querySelector('input, select')?.id),
    cards: [...document.querySelectorAll('.sync-connection-card')].map((c) => ({
      provider: c.dataset.connectionProvider,
      name: c.querySelector('.sync-connection-card-name')?.textContent,
      detail: c.querySelector('.sync-connection-card-detail')?.textContent
    })),
    notice: q('.sync-notice')?.textContent || ''
  }
})()`)
const click = (selector) => app.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) throw new Error('missing ' + ${JSON.stringify(selector)}); n.click(); return true })()`)
const fill = async (id, value) => {
  await app.evaluate(`(() => { const n = document.getElementById(${JSON.stringify(id)}); n.focus(); n.select() })()`)
  await typeTextLikeUser(app.send, value, { delayMs: 4 })
}
const choose = (id, value) => app.evaluate(`(() => {
  const n = document.getElementById(${JSON.stringify(id)})
  n.value = ${JSON.stringify(value)}
  n.dispatchEvent(new Event('change', { bubbles: true }))
  return n.value
})()`)
const saved = async () => JSON.parse(await readFile(join(profileDir, 'sync', 'connections.json'), 'utf8')).connections

try {
  // Connections saved by an older version (no `provider`, no credentials
  // needed to show them).
  const legacy = [
    { id: 'old-q', type: 's3', name: '旧的七牛', endpoint: 'https://s3.cn-south-1.qiniucs.com', bucket: 'notes', region: 'cn-south-1', accessKeyId: 'AK1', userAgent: '', allowInsecure: false, credentialId: 's3:old-q' },
    { id: 'old-j', type: 'webdav', name: '坚果云备份', endpoint: 'https://dav.jianguoyun.com/dav/HorseMD/', username: 'me@x.cn', userAgent: '', allowInsecure: false, credentialId: 'webdav:old-j' }
  ]

  // 1. No connection: the gallery.
  app = await launchBuiltElectron({ profileDir, port, appArgs: ['--horsemd-input-trace'] })
  await openSync()
  let s = await waitFor(async () => { const v = await state(); return v.gallery && !v.logos.includes('broken') && v }, 'no gallery / logo not loaded')
  assert.deepEqual(s.tiles, ['jianguoyun', 'cstcloud', 'qiniu', 'r2', 'nextcloud'])
  assert.deepEqual(s.logos, s.tiles)
  assert.deepEqual(s.generic, ['webdav', 's3'])
  assert.equal(s.addButton, false)
  assert.deepEqual(s.cards, [])

  // 2. A service: steps, only its fields; back; 其他 S3 = the full form.
  await click('.sync-provider-row[data-provider="jianguoyun"]')
  s = await state()
  assert.equal(s.panel, '坚果云')
  assert.equal(s.steps, 3)
  assert.deepEqual(s.fields, ['连接名称', '坚果云账号', '应用密码'])
  assert.equal(s.values['syncp-jianguoyun-name'], '坚果云')
  await click('.sync-provider-panel-head .sync-icon-btn')
  assert.equal((await state()).gallery, true)
  await click('.sync-provider-row[data-provider="qiniu"]')
  s = await state()
  assert.deepEqual(s.fields, ['连接名称', '存储区域', '存储空间（Bucket）', 'AccessKey', 'SecretKey'])
  assert.equal(s.values['syncp-qiniu-qiniuRegion'], 'cn-east-1')
  // 使用完整设置 → the S3 form, prefilled from the service.
  await choose('syncp-qiniu-qiniuRegion', 'cn-north-1')
  await fill('syncp-qiniu-bucket', 'demo-bucket')
  await click('.sync-provider-full')
  s = await state()
  assert.equal(s.fullForm, true)
  assert.equal(s.values['sync-s3-endpoint'], 'https://s3.cn-north-1.qiniucs.com')
  assert.equal(s.values['sync-s3-region'], 'cn-north-1')
  assert.equal(s.values['sync-s3-bucket'], 'demo-bucket')
  await click('.sync-provider-panel-head .sync-icon-btn')
  await click('.sync-provider-row.generic[data-provider="webdav"]')
  s = await state()
  assert.equal(s.fullForm, true)
  assert.ok('sync-webdav-endpoint' in s.values)
  await stopBuiltElectron(app)
  app = null

  // 3. Older connections: shown as their services; edit = the matching form.
  await mkdir(join(profileDir, 'sync'), { recursive: true })
  await writeFile(join(profileDir, 'sync', 'connections.json'), JSON.stringify({ version: 1, connections: legacy }))
  app = await launchBuiltElectron({ profileDir, port, cleanProfile: false, appArgs: ['--horsemd-input-trace'] })
  await openSync()
  s = await waitFor(async () => { const v = await state(); return v.cards.length === 2 && v }, 'legacy connections not shown')
  assert.equal(s.gallery, false)
  assert.equal(s.addButton, true)
  assert.deepEqual(s.cards.map((c) => c.provider), ['qiniu', 'jianguoyun'])
  assert.match(s.cards[0].detail, /七牛云.*华南-广东.*notes/)
  // 七牛 fits its form: region select on cn-south-1, bucket filled.
  await click('[data-connection-provider="qiniu"] .sync-icon-btn[aria-label="编辑"]')
  s = await state()
  assert.equal(s.values['syncp-old-q-qiniuRegion'], 'cn-south-1')
  assert.equal(s.values['syncp-old-q-bucket'], 'notes')
  assert.equal(s.values['syncp-old-q-accessKeyId'], 'AK1')
  await click('[data-connection-provider="qiniu"] .sync-provider-actions [data-sync-cancel]')
  // 坚果云 with a sub-folder address: the full form, address unchanged.
  await click('[data-connection-provider="jianguoyun"] .sync-icon-btn[aria-label="编辑"]')
  s = await state()
  assert.equal(s.fullForm, true)
  assert.equal(s.values['sync-old-j-endpoint'], 'https://dav.jianguoyun.com/dav/HorseMD/')
  // Nothing was rewritten by opening them.
  assert.deepEqual(await saved(), legacy)
  await stopBuiltElectron(app)
  app = null

  // 4. Real accounts (optional): explain a wrong value, then save.
  if (qiniu || cstcloud) {
    await writeFile(join(profileDir, 'sync', 'connections.json'), JSON.stringify({ version: 1, connections: [] }))
    app = await launchBuiltElectron({ profileDir, port, cleanProfile: false, appArgs: ['--horsemd-input-trace'] })
    await openSync()
    await waitFor(async () => (await state()).gallery, 'no gallery')
    if (qiniu) {
      await click('.sync-provider-row[data-provider="qiniu"]')
      const wrong = qiniu.region === 'cn-east-1' ? 'cn-north-1' : 'cn-east-1'
      await choose('syncp-qiniu-qiniuRegion', wrong)
      await fill('syncp-qiniu-bucket', qiniu.bucket)
      await fill('syncp-qiniu-accessKeyId', qiniu.ak)
      await fill('syncp-qiniu-secretAccessKey', qiniu.sk)
      await click('.sync-provider-form [type="submit"]')
      s = await waitFor(async () => { const v = await state(); return v.error && v }, 'no error for a wrong region', 300)
      assert.match(s.error, /区域选得不对/)
      assert.deepEqual(s.invalid, ['syncp-qiniu-qiniuRegion'])
      await choose('syncp-qiniu-qiniuRegion', qiniu.region)
      await click('.sync-provider-form [type="submit"]')
      s = await waitFor(async () => { const v = await state(); return v.cards.length === 1 && v }, 'qiniu not saved', 300)
      assert.equal(s.cards[0].provider, 'qiniu')
      assert.match(s.notice, /已添加「七牛云」/)
      const entry = (await saved())[0]
      assert.equal(entry.provider, 'qiniu')
      assert.equal(entry.endpoint, `https://s3.${qiniu.region}.qiniucs.com`)
      assert.equal(entry.region, qiniu.region)
      assert.equal(JSON.stringify(await saved()).includes(qiniu.sk), false, 'secret written to connections.json')
    }
    if (cstcloud) {
      if (await app.evaluate("!!document.querySelector('[data-sync-add]')")) await click('[data-sync-add]')
      await click('.sync-provider-row[data-provider="cstcloud"]')
      await fill('syncp-cstcloud-bucket', cstcloud.bucket)
      await fill('syncp-cstcloud-accessKeyId', cstcloud.ak)
      await fill('syncp-cstcloud-secretAccessKey', cstcloud.sk)
      await fill('syncp-cstcloud-client', 'curl')
      await click('.sync-provider-form [type="submit"]')
      s = await waitFor(async () => { const v = await state(); return v.error && v }, 'no error for a wrong client', 300)
      assert.match(s.error, /客户端/)
      assert.ok(s.invalid.includes('syncp-cstcloud-client'))
      await fill('syncp-cstcloud-client', 'rclone')
      await click('.sync-provider-form [type="submit"]')
      s = await waitFor(async () => { const v = await state(); return v.cards.some((c) => c.provider === 'cstcloud') && v }, 'cstcloud not saved', 300)
      const entry = (await saved()).find((item) => item.provider === 'cstcloud')
      assert.equal(entry.endpoint, 'https://s3.cstcloud.cn')
      assert.equal(entry.userAgent, 'rclone')
    }
  }

  console.log(`PASS sync providers UI: gallery when empty (5 services + 其他 WebDAV / S3), service form (steps, its fields), back, full-form switch prefilled; older connections shown as their services, edit opens the fitting form, nothing rewritten${qiniu ? '; 七牛 real account: wrong region explained, saved with provider' : ''}${cstcloud ? '; 数据胶囊 real account: wrong client explained, saved with rclone' : ''}`)
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
