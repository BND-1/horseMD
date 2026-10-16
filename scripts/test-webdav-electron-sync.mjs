import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

function startWebDav() {
  const objects = new Map()
  let revision = 0
  const server = http.createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.replace(/^\/dav\/?/, ''))
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const reply = (status, headers = {}, value = '') => res.writeHead(status, headers).end(value)
    if (req.method === 'PROPFIND') {
      const entry = objects.get(path)
      const etag = entry?.revision || 'root'
      const prefix = path.split('/').filter(Boolean)
      const children = [...objects.keys()]
        .map((key) => key.split('/'))
        .filter((parts) => prefix.every((part, index) => parts[index] === part))
        .filter((parts) => parts.length === prefix.length + 3 && parts.at(-2) === '.horsemd' && parts.at(-1) === 'manifest.json')
        .map((parts) => parts[prefix.length])
      const responseXml = (href) => `<d:response><d:href>/dav/${href}</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop><d:getetag>"${etag}"</d:getetag><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`
      return reply(207, { 'content-type': 'application/xml' }, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${responseXml(encodeURIComponent(path))}${children.map((id) => responseXml(`${path}/${id}`)).join('')}</d:multistatus>`)
    }
    if (req.method === 'MKCOL') return reply(201)
    if (req.method === 'GET') {
      const entry = objects.get(path)
      return entry ? reply(200, { etag: `"${entry.revision}"` }, entry.bytes) : reply(404)
    }
    if (req.method === 'PUT') {
      const old = objects.get(path)
      if (req.headers['if-none-match'] === '*' && old) return reply(412)
      if (req.headers['if-match'] && (!old || req.headers['if-match'] !== `"${old.revision}"`)) return reply(412)
      const entry = { bytes: body, revision: String(++revision) }
      objects.set(path, entry)
      return reply(old ? 204 : 201, { etag: `"${entry.revision}"` })
    }
    if (req.method === 'DELETE') { objects.delete(path); return reply(204) }
    return reply(405)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, objects, endpoint: `http://127.0.0.1:${server.address().port}/dav/` })))
}

const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-webdav-electron-'))
const localA = join(root, 'a')
const localB = join(root, 'b')
const localLegacy = join(root, 'legacy')
const webdav = await startWebDav()
const invoke = (app, expression) => app.evaluate(`(async () => ${expression})()`)

async function openSyncSettings(app) {
  await app.evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const visible = (element) => Boolean(element && element.getClientRects().length && getComputedStyle(element).display !== 'none')
    const settings = [...document.querySelectorAll('button')].find((button) => visible(button) && /settings|设置/i.test(button.title || button.textContent || ''))
    if (!settings) throw new Error('Missing Settings entry')
    settings.click()
    await sleep(250)
    const sync = [...document.querySelectorAll('.settings-nav-item')].find((button) => visible(button) && /cloud sync|云同步/i.test(button.textContent || ''))
    if (!sync) throw new Error('Missing Cloud sync navigation item')
    sync.click()
    await sleep(900)
  })()`)
}

try {
  await fs.mkdir(localA, { recursive: true }); await fs.mkdir(localB, { recursive: true }); await fs.mkdir(localLegacy, { recursive: true })
  await fs.writeFile(join(localA, 'note.md'), '# From A\n')
let app = await launchBuiltElectron({ profileDir: join(root, 'profile-a'), port: 9472, appArgs: [localA] })
  let connection
  let workspaceId
  try {
    await invoke(app, `window.api.syncAdoptWorkspace(${JSON.stringify(localA)})`)
    connection = await invoke(app, `window.api.syncAddWebDavConnection(${JSON.stringify({ name: 'Test DAV', endpoint: webdav.endpoint, username: 'test', password: 'pass', allowInsecure: true })})`)
    const updated = await invoke(app, `window.api.syncUpdateConnection(${JSON.stringify(connection.id)}, ${JSON.stringify({ name: 'Renamed DAV', endpoint: webdav.endpoint, username: 'test', password: '', allowInsecure: true })})`)
    assert.equal(updated.name, 'Renamed DAV')
    assert.equal(updated.password, undefined)
    await invoke(app, `window.api.syncBindWorkspaceConnection(${JSON.stringify(localA)}, ${JSON.stringify(connection.id)})`)
    const preview = await invoke(app, `window.api.syncPreview(${JSON.stringify(localA)})`)
    assert.equal(preview.summary.upload, 1)
    await stopBuiltElectron(app)
    app = await launchBuiltElectron({ profileDir: join(root, 'profile-a'), port: 9472, cleanProfile: false, appArgs: [localA] })
    await openSyncSettings(app)
    const previewUi = await app.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const button = [...document.querySelectorAll('.sync-folder-row button')]
        .find((item) => /view preview|查看预览/i.test(item.title || ''))
      if (!button) throw new Error('Missing sync preview icon action: ' + [...document.querySelectorAll('.sync-folder-row button')].map((item) => item.title || item.textContent).join(' | '))
      button.click()
      await sleep(250)
      const panel = document.querySelector('.sync-plan-preview')
      const changes = document.querySelector('.sync-preview-changes')
      return {
        panel: Boolean(panel),
        modal: Boolean(document.querySelector('.sync-preview[role="dialog"]')),
        position: panel ? getComputedStyle(panel).position : '',
        maxHeight: changes ? getComputedStyle(changes).maxHeight : '',
        icons: [...document.querySelectorAll('.sync-folder-row .sync-icon-btn')].map((item) => item.title)
      }
    })()`)
    assert.equal(previewUi.panel, true)
    assert.equal(previewUi.modal, false)
    assert.notEqual(previewUi.position, 'fixed')
    assert.equal(previewUi.maxHeight, '240px')
    assert.equal(previewUi.icons.some((title) => /two-way sync|双向同步/i.test(title)), true)
    assert.equal(previewUi.icons.some((title) => /upload local|上传本地/i.test(title)), true)
    await invoke(app, `window.api.syncRun(${JSON.stringify(localA)})`)
    workspaceId = JSON.parse(await fs.readFile(join(localA, '.horsemd', 'workspace.json'))).workspaceId
    assert.equal(webdav.objects.get(`HorseMD/${workspaceId}/note.md`).bytes.toString(), '# From A\n')
  } finally { await stopBuiltElectron(app) }

  app = await launchBuiltElectron({ profileDir: join(root, 'profile-b'), port: 9472, appArgs: [localB] })
  try {
    await invoke(app, `window.api.syncAdoptWorkspace(${JSON.stringify(localB)})`)
    const secondConnection = await invoke(app, `window.api.syncAddWebDavConnection(${JSON.stringify({ name: 'Test DAV', endpoint: webdav.endpoint, username: 'test', password: 'pass', allowInsecure: true })})`)
    const remoteWorkspaces = await invoke(app, `window.api.syncListRemoteWorkspaces(${JSON.stringify(secondConnection.id)})`)
    assert.equal(remoteWorkspaces.some((item) => item.workspaceId === workspaceId), true)
    await invoke(app, `window.api.syncJoinWorkspace(${JSON.stringify(localB)}, ${JSON.stringify(secondConnection.id)}, ${JSON.stringify(workspaceId)})`)
    const preview = await invoke(app, `window.api.syncPreview(${JSON.stringify(localB)})`)
    assert.equal(preview.summary.download, 1)
    await invoke(app, `window.api.syncRun(${JSON.stringify(localB)})`)
    assert.equal(await fs.readFile(join(localB, 'note.md'), 'utf8'), '# From A\n')
    webdav.objects.delete(`HorseMD/${workspaceId}/.horsemd/manifest.json`)
    const reset = await invoke(app, `window.api.syncPreview(${JSON.stringify(localB)})`)
    assert.equal(reset.status, 'remote-reset')
    await assert.rejects(invoke(app, `window.api.syncRun(${JSON.stringify(localB)})`), /不会自动删除本地文件/)
    await invoke(app, `window.api.syncRun(${JSON.stringify(localB)}, 'push')`)
    assert.ok(webdav.objects.get(`HorseMD/${workspaceId}/.horsemd/manifest.json`))
    await assert.rejects(
      invoke(app, `window.api.syncRemoveConnection(${JSON.stringify(secondConnection.id)})`),
      /仍在使用这个连接/
    )
    await invoke(app, `window.api.syncRemoveWorkspace(${JSON.stringify(localB)})`)
    assert.equal(await invoke(app, `window.api.syncRemoveConnection(${JSON.stringify(secondConnection.id)})`), true)
  } finally { await stopBuiltElectron(app) }

  const legacyWorkspaceId = randomUUID()
  webdav.objects.set(`HorseMD/v1/workspaces/${legacyWorkspaceId}/legacy.md`, { bytes: Buffer.from('# Legacy\n'), revision: 'legacy-file' })
  webdav.objects.set(`HorseMD/v1/workspaces/${legacyWorkspaceId}/.horsemd/manifest.json`, {
    bytes: Buffer.from(JSON.stringify({ version: 1, workspaceId: legacyWorkspaceId, files: { 'legacy.md': { sha256: '75d932ed7ed851a78fcf0f4bce2095b216e81ca15fb3a07ae3e4ab5f791e4e53' } }, tombstones: {} })),
    revision: 'legacy-manifest'
  })

  app = await launchBuiltElectron({ profileDir: join(root, 'profile-legacy'), port: 9472, appArgs: [localLegacy] })
  try {
    await invoke(app, `window.api.syncAdoptWorkspace(${JSON.stringify(localLegacy)})`)
    const legacyConnection = await invoke(app, `window.api.syncAddWebDavConnection(${JSON.stringify({ name: 'Test DAV', endpoint: webdav.endpoint, username: 'test', password: 'pass', allowInsecure: true })})`)
    const remoteWorkspaces = await invoke(app, `window.api.syncListRemoteWorkspaces(${JSON.stringify(legacyConnection.id)})`)
    assert.equal(remoteWorkspaces.some((item) => item.workspaceId === legacyWorkspaceId), true)
    await invoke(app, `window.api.syncJoinWorkspace(${JSON.stringify(localLegacy)}, ${JSON.stringify(legacyConnection.id)}, ${JSON.stringify(legacyWorkspaceId)})`)
    assert.equal((await invoke(app, `window.api.syncPreview(${JSON.stringify(localLegacy)})`)).summary.download, 1)
    await invoke(app, `window.api.syncRun(${JSON.stringify(localLegacy)})`)
    assert.equal(await fs.readFile(join(localLegacy, 'legacy.md'), 'utf8'), '# Legacy\n')
  } finally { await stopBuiltElectron(app) }
} finally {
  await new Promise((resolve) => webdav.server.close(resolve))
  await fs.rm(root, { recursive: true, force: true })
}

console.log('PASS Electron WebDAV sync: IPC, safe credentials, net.fetch, remote join, download and connection removal guard')
