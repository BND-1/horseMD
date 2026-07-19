import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { S3Provider } from '../src/main/sync/s3-provider.js'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const accessKeyId = 'horsemd-test-access'
const secretAccessKey = 'horsemd-test-secret'
const bucket = 'horsemd-sync-test'

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForMinio(endpoint, child) {
  let lastError = null
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null) throw new Error('MinIO 在启动时退出。')
    try {
      if ((await fetch(`${endpoint}/minio/health/live`)).ok) return
    } catch (error) {
      lastError = error
    }
    await sleep(150)
  }
  throw new Error(`MinIO 未在预期时间内启动：${lastError?.message || '未知错误'}`)
}

async function stop(child) {
  if (!child || child.exitCode != null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(3000).then(() => child.exitCode == null && child.kill('SIGKILL'))
  ])
}

const root = await mkdtemp(join(tmpdir(), 'horsemd-s3-electron-'))
const dataDir = join(root, 'minio')
const localA = join(root, 'a')
const localB = join(root, 'b')
const port = await freePort()
const consolePort = await freePort()
const endpoint = `http://127.0.0.1:${port}`
const minio = spawn('minio', ['server', dataDir, '--address', `127.0.0.1:${port}`, '--console-address', `127.0.0.1:${consolePort}`, '--quiet'], {
  env: { ...process.env, MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey },
  stdio: ['ignore', 'ignore', 'ignore']
})
const invoke = (app, expression) => app.evaluate(`(async () => ${expression})()`)
const connectionConfig = {
  name: 'Local MinIO',
  endpoint,
  bucket,
  region: 'us-east-1',
  accessKeyId,
  secretAccessKey,
  allowInsecure: true
}

try {
  await waitForMinio(endpoint, minio)
  const bootstrap = new S3Provider({ ...connectionConfig, request: fetch })
  assert.equal((await bootstrap.signedRequest('PUT')).ok, true)
  await bootstrap.testConnection()
  const direct = new S3Provider({ ...connectionConfig, prefix: 'HorseMD/bootstrap-check', request: fetch })
  await direct.put('check.txt', Buffer.from('check'), { createOnly: true })
  assert.equal((await direct.get('check.txt')).bytes.toString(), 'check')
  await direct.put('中文 文件.md', Buffer.from('unicode'), { createOnly: true })
  assert.equal((await direct.get('中文 文件.md')).bytes.toString(), 'unicode')
  await direct.put('括号(测试).md', Buffer.from('reserved'), { createOnly: true })
  assert.equal((await direct.get('括号(测试).md')).bytes.toString(), 'reserved')
  await mkdir(localA, { recursive: true })
  await mkdir(localB, { recursive: true })
  await writeFile(join(localA, 'note.md'), '# From MinIO A\n', 'utf8')
  await writeFile(join(localA, '括号(测试).md'), '# Signed path\n', 'utf8')

  let app = await launchBuiltElectron({ profileDir: join(root, 'profile-a'), port: 9474, appArgs: [localA] })
  let workspaceId
  try {
    await invoke(app, `window.api.syncAdoptWorkspace(${JSON.stringify(localA)})`)
    const connection = await invoke(app, `window.api.syncAddS3Connection(${JSON.stringify(connectionConfig)})`)
    const updated = await invoke(app, `window.api.syncUpdateConnection(${JSON.stringify(connection.id)}, ${JSON.stringify({ ...connectionConfig, name: 'Renamed local MinIO', secretAccessKey: '' })})`)
    assert.equal(updated.name, 'Renamed local MinIO')
    assert.equal(updated.secretAccessKey, undefined)
    await invoke(app, `window.api.syncBindWorkspaceConnection(${JSON.stringify(localA)}, ${JSON.stringify(connection.id)})`)
    assert.equal((await invoke(app, `window.api.syncPreview(${JSON.stringify(localA)})`)).summary.upload, 2)
    await invoke(app, `window.api.syncRun(${JSON.stringify(localA)})`)
    workspaceId = JSON.parse(await readFile(join(localA, '.horsemd', 'workspace.json'))).workspaceId
  } finally {
    await stopBuiltElectron(app)
  }

  app = await launchBuiltElectron({ profileDir: join(root, 'profile-b'), port: 9474, appArgs: [localB] })
  try {
    await invoke(app, `window.api.syncAdoptWorkspace(${JSON.stringify(localB)})`)
    const connection = await invoke(app, `window.api.syncAddS3Connection(${JSON.stringify(connectionConfig)})`)
    const remote = await invoke(app, `window.api.syncListRemoteWorkspaces(${JSON.stringify(connection.id)})`)
    assert.equal(remote.some((item) => item.workspaceId === workspaceId), true)
    await invoke(app, `window.api.syncJoinWorkspace(${JSON.stringify(localB)}, ${JSON.stringify(connection.id)}, ${JSON.stringify(workspaceId)})`)
    assert.equal((await invoke(app, `window.api.syncPreview(${JSON.stringify(localB)})`)).summary.download, 2)
    await invoke(app, `window.api.syncRun(${JSON.stringify(localB)})`)
    assert.equal(await readFile(join(localB, 'note.md'), 'utf8'), '# From MinIO A\n')
    assert.equal(await readFile(join(localB, '括号(测试).md'), 'utf8'), '# Signed path\n')

    const remoteStorage = new S3Provider({ ...connectionConfig, prefix: `HorseMD/${workspaceId}`, request: fetch })
    await remoteStorage.delete('.horsemd/manifest.json')
    const reset = await invoke(app, `window.api.syncPreview(${JSON.stringify(localB)})`)
    assert.equal(reset.status, 'remote-reset')
    await assert.rejects(invoke(app, `window.api.syncRun(${JSON.stringify(localB)})`), /不会自动删除本地文件/)
    assert.equal((await invoke(app, `window.api.syncPreview(${JSON.stringify(localB)}, 'push')`)).status, 'ready')
    await invoke(app, `window.api.syncRun(${JSON.stringify(localB)}, 'push')`)
    assert.ok(await remoteStorage.get('.horsemd/manifest.json'))
  } finally {
    await stopBuiltElectron(app)
  }
} finally {
  await stop(minio)
  await rm(root, { recursive: true, force: true })
}

console.log('PASS Electron S3 sync: real MinIO, IPC, remote discovery and second-device download')
