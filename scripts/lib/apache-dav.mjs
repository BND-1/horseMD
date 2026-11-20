// A real WebDAV server for sync tests: Apache httpd + mod_dav (macOS
// /usr/sbin/httpd; Linux apache2), several processes, its own process group.
// Returns null when Apache / mod_dav is not installed.
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import net from 'node:net'
import { join, relative } from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => resolve(port))
  })
})

// `port`: fixed (a phone reaches it through adb reverse), else a free one.
// `host`: the address to listen on (another machine's test reaches the mini
// through its Tailscale address); 127.0.0.1 by default.
export async function startApacheDav(root, { port: fixedPort = 0, host = '127.0.0.1' } = {}) {
  const httpd = ['/usr/sbin/httpd', '/usr/sbin/apache2'].find((path) => existsSync(path))
  const modules = ['/usr/libexec/apache2', '/usr/lib/apache2/modules'].find((path) => existsSync(join(path, 'mod_dav.so')))
  if (!httpd || !modules) return null
  const documentRoot = join(root, 'dav-documents')
  await fs.mkdir(documentRoot, { recursive: true })
  const port = fixedPort || await freePort()
  const configPath = join(root, 'httpd.conf')
  const mpm = existsSync(join(modules, 'mod_mpm_prefork.so')) ? `LoadModule mpm_prefork_module ${modules}/mod_mpm_prefork.so` : ''
  await fs.writeFile(configPath, `
ServerRoot "${root}"
Listen ${host}:${port}
ServerName ${host}
# Several processes: with -X (one connection at a time) a kept-alive idle
# connection held every next request for seconds.
StartServers 4
MinSpareServers 4
MaxSpareServers 8
PidFile "${join(root, 'httpd.pid')}"
ErrorLog "${join(root, 'error.log')}"
LogLevel warn
${mpm}
LoadModule unixd_module ${modules}/mod_unixd.so
LoadModule authn_core_module ${modules}/mod_authn_core.so
LoadModule authz_core_module ${modules}/mod_authz_core.so
LoadModule mime_module ${modules}/mod_mime.so
LoadModule log_config_module ${modules}/mod_log_config.so
CustomLog "${join(root, 'access.log')}" "%P %{remote}p %r %>s %D"
LoadModule dav_module ${modules}/mod_dav.so
LoadModule dav_fs_module ${modules}/mod_dav_fs.so
DAVLockDB "${join(root, 'dav-lock')}"
DocumentRoot "${documentRoot}"
<Directory "${documentRoot}">
  Require all granted
  DAV On
  Options Indexes
</Directory>
`, 'utf8')
  const child = spawn(httpd, ['-DFOREGROUND', '-f', configPath], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const endpoint = `http://${host}:${port}/`
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Apache failed: ${await fs.readFile(join(root, 'error.log'), 'utf8').catch(() => '')}`)
    try {
      const response = await fetch(endpoint, { method: 'PROPFIND', headers: { Depth: '0' } })
      if ([200, 207].includes(response.status)) break
    } catch {}
    await sleep(150)
  }
  const files = async () => {
    const out = new Map()
    const walk = async (dir) => {
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        const path = join(dir, item.name)
        if (item.isDirectory()) await walk(path)
        else out.set(relative(documentRoot, path).split('\\').join('/'), await fs.readFile(path))
      }
    }
    await walk(documentRoot)
    return out
  }
  return {
    kind: 'webdav',
    connection: { type: 'webdav', name: 'Apache DAV', endpoint, username: '', password: '', allowInsecure: true },
    files,
    // Everything a server keeps, folder names included.
    names: async () => {
      const out = []
      const walk = async (dir) => {
        for (const item of await fs.readdir(dir, { withFileTypes: true })) {
          out.push(relative(documentRoot, join(dir, item.name)))
          if (item.isDirectory()) await walk(join(dir, item.name))
        }
      }
      await walk(documentRoot)
      return out
    },
    remove: (key) => fs.rm(join(documentRoot, key), { recursive: true, force: true }),
    write: async (key, bytes) => { await fs.mkdir(join(documentRoot, key, '..'), { recursive: true }); await fs.writeFile(join(documentRoot, key), bytes) },
    accessLog: () => fs.readFile(join(root, 'access.log'), 'utf8').catch(() => ''),
    stop: async () => {
      // Its own process group (detached): Apache signals its whole group.
      try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3000)])
    }
  }
}


// The same inspection helpers over the WebDAV protocol itself, for a server
// on another machine (Windows runs against the mini's Apache).
export function remoteDav(endpoint) {
  const base = new URL(endpoint.endsWith('/') ? endpoint : `${endpoint}/`)
  const basePath = decodeURIComponent(base.pathname)
  const url = (path, dir = false) => new URL(path.split('/').filter(Boolean).map(encodeURIComponent).join('/') + (dir && path ? '/' : ''), base)
  const children = async (path) => {
    const response = await fetch(url(path, true), { method: 'PROPFIND', headers: { Depth: '1', 'Content-Type': 'application/xml' } })
    if (response.status === 404) return []
    if (response.status !== 207) throw new Error(`PROPFIND ${path}: HTTP ${response.status}`)
    const xml = await response.text()
    const out = []
    for (const block of xml.split(/<(?:\w+:)?response[\s>]/).slice(1)) {
      const href = /<(?:\w+:)?href>([^<]*)</.exec(block)?.[1]
      if (!href) continue
      const name = decodeURIComponent(new URL(href, base).pathname).slice(basePath.length).replace(/\/$/, '')
      if (name === path) continue
      out.push({ name, dir: /<(?:\w+:)?collection\s*\/>/.test(block) })
    }
    return out
  }
  const walk = async (path = '', out = []) => {
    for (const entry of await children(path)) {
      out.push(entry)
      if (entry.dir) await walk(entry.name, out)
    }
    return out
  }
  return {
    kind: 'webdav',
    connection: { type: 'webdav', name: 'Remote DAV', endpoint: base.toString(), username: '', password: '', allowInsecure: true },
    names: async () => (await walk()).map((entry) => entry.name),
    files: async () => {
      const out = new Map()
      for (const entry of await walk()) {
        if (!entry.dir) out.set(entry.name, Buffer.from(await (await fetch(url(entry.name))).arrayBuffer()))
      }
      return out
    },
    remove: async (key) => {
      const dir = (await children(key.split('/').slice(0, -1).join('/'))).find((entry) => entry.name === key)?.dir
      const response = await fetch(url(key, dir), { method: 'DELETE' })
      if (![200, 204, 404].includes(response.status)) throw new Error(`DELETE ${key}: HTTP ${response.status}`)
    },
    write: async (key, bytes) => {
      const parts = key.split('/')
      for (let i = 1; i < parts.length; i += 1) await fetch(url(parts.slice(0, i).join('/'), true), { method: 'MKCOL' })
      const response = await fetch(url(key), { method: 'PUT', body: bytes })
      if (![200, 201, 204].includes(response.status)) throw new Error(`PUT ${key}: HTTP ${response.status}`)
    },
    stop: async () => {}
  }
}
