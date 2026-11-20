// A real MinIO server for sync tests, with the same inspection helpers as
// mock-s3-server.mjs (files / names / remove / write over the raw bucket).
// Returns null when the `minio` binary is not installed.
import { spawn, execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import net from 'node:net'
import { join } from 'node:path'
import { S3Provider } from '../../src/main/sync/s3-provider.js'

const accessKeyId = 'horsemd-test-access'
const secretAccessKey = 'horsemd-test-secret'
const bucket = 'horsemd-e2ee-test'
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

function installed() {
  try { execFileSync('minio', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
}

const decodeXml = (text) => text.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

export async function startMinio(root) {
  if (!installed()) return null
  const dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  const port = await freePort()
  const consolePort = await freePort()
  const endpoint = `http://127.0.0.1:${port}`
  const child = spawn('minio', ['server', dataDir, '--address', `127.0.0.1:${port}`, '--console-address', `127.0.0.1:${consolePort}`, '--quiet'], {
    env: { ...process.env, MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey },
    stdio: ['ignore', 'ignore', 'ignore']
  })
  const stop = async () => {
    if (child.exitCode != null) return
    child.kill('SIGTERM')
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3000).then(() => child.exitCode == null && child.kill('SIGKILL'))])
  }
  try {
    let up = false
    for (let attempt = 0; attempt < 100 && !up; attempt += 1) {
      if (child.exitCode != null) throw new Error('MinIO exited while starting')
      try { up = (await fetch(`${endpoint}/minio/health/live`)).ok } catch { /* not yet */ }
      if (!up) await sleep(150)
    }
    if (!up) throw new Error('MinIO did not start')
    const connection = { type: 's3', name: 'MinIO', endpoint, bucket, region: 'us-east-1', accessKeyId, secretAccessKey, allowInsecure: true }
    const raw = new S3Provider({ ...connection, request: fetch })
    const made = await raw.signedRequest('PUT')
    if (!made.ok) throw new Error(`create bucket: HTTP ${made.status}`)

    const keys = async () => {
      const out = []
      let token = null
      for (;;) {
        const response = await raw.signedRequest('GET', '', { bucketLevel: true, query: { 'list-type': '2', ...(token ? { 'continuation-token': token } : {}) } })
        if (!response.ok) throw new Error(`list: HTTP ${response.status}`)
        const xml = await response.text()
        for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) out.push(decodeXml(match[1]))
        const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)
        if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !next) break
        token = decodeXml(next[1])
      }
      return out
    }
    return {
      kind: 's3',
      connection,
      names: keys,
      files: async () => {
        const map = new Map()
        for (const key of await keys()) map.set(key, (await raw.get(key))?.bytes ?? Buffer.alloc(0))
        return map
      },
      remove: async (key) => { for (const name of await keys()) if (name === key || name.startsWith(key + '/')) await raw.delete(name) },
      write: async (key, bytes) => { await raw.put(key, Buffer.from(bytes)) },
      stop
    }
  } catch (error) {
    await stop()
    throw error
  }
}
