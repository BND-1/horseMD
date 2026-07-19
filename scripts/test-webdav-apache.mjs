import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WebDavProvider } from '../src/main/sync/webdav-provider.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

async function waitForServer(endpoint, child, output, errorLog) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null) {
      const log = await readFile(errorLog, 'utf8').catch(() => '')
      throw new Error(`Apache DAV 启动失败：${output.join('')}${log}`)
    }
    try {
      const response = await fetch(endpoint, { method: 'PROPFIND', headers: { Depth: '0' } })
      if ([200, 207].includes(response.status)) return
    } catch {}
    await sleep(150)
  }
  throw new Error(`Apache DAV 未在预期时间内启动：${output.join('')}`)
}

async function stop(child) {
  if (!child || child.exitCode != null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(3000).then(() => child.exitCode == null && child.kill('SIGKILL'))
  ])
}

const root = await mkdtemp(join(tmpdir(), 'horsemd-webdav-apache-'))
const documentRoot = join(root, 'documents')
const logs = join(root, 'logs')
const port = await freePort()
const configPath = join(root, 'httpd.conf')
const endpoint = `http://127.0.0.1:${port}/`
const output = []
let apache = null

try {
  await mkdir(documentRoot, { recursive: true })
  await mkdir(logs, { recursive: true })
  await writeFile(configPath, `
ServerRoot "${root}"
Listen 127.0.0.1:${port}
ServerName 127.0.0.1
PidFile "${join(root, 'httpd.pid')}"
ErrorLog "${join(logs, 'error.log')}"
LogLevel warn
LoadModule mpm_prefork_module /usr/libexec/apache2/mod_mpm_prefork.so
LoadModule unixd_module /usr/libexec/apache2/mod_unixd.so
LoadModule authn_core_module /usr/libexec/apache2/mod_authn_core.so
LoadModule authz_core_module /usr/libexec/apache2/mod_authz_core.so
LoadModule mime_module /usr/libexec/apache2/mod_mime.so
LoadModule dav_module /usr/libexec/apache2/mod_dav.so
LoadModule dav_fs_module /usr/libexec/apache2/mod_dav_fs.so
DAVLockDB "${join(root, 'dav-lock')}"
DocumentRoot "${documentRoot}"
<Directory "${documentRoot}">
  Require all granted
  DAV On
  Options Indexes
</Directory>
`, 'utf8')
  apache = spawn('/usr/sbin/httpd', ['-X', '-f', configPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  apache.stdout.on('data', (chunk) => output.push(chunk.toString()))
  apache.stderr.on('data', (chunk) => output.push(chunk.toString()))
  await waitForServer(endpoint, apache, output, join(logs, 'error.log'))

  const provider = new WebDavProvider({ endpoint, username: 'ignored', password: 'ignored', allowInsecure: true, request: fetch })
  await provider.testConnection()
  const created = await provider.put('nested/note.md', Buffer.from('# DAV\n'), { createOnly: true })
  assert.ok(created.revision)
  assert.equal((await provider.get('nested/note.md')).bytes.toString(), '# DAV\n')
  assert.equal((await provider.list('nested')).some((entry) => entry.href.endsWith('/nested/note.md')), true)
  const updated = await provider.put('nested/note.md', Buffer.from('# Updated\n'), { revision: created.revision })
  assert.notEqual(updated.revision, created.revision)
  await provider.delete('nested/note.md', { revision: updated.revision })
  assert.equal(await provider.get('nested/note.md'), null)
} finally {
  await stop(apache)
  await rm(root, { recursive: true, force: true })
}

console.log('PASS WebDAV provider: real Apache DAV transfer, list, conditional update and delete')
