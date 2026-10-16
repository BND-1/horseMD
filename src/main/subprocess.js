import { spawn } from 'node:child_process'

const DEFAULT_OUTPUT_LIMIT = 64 * 1024

const appendLimited = (chunks, size, chunk, limit) => {
  if (size >= limit) return size
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  const take = Math.min(bytes.length, limit - size)
  if (take > 0) chunks.push(bytes.subarray(0, take))
  return size + take
}

export function runSubprocess({
  executable,
  args = [],
  input = null,
  cwd,
  env,
  timeoutMs = 120000,
  outputLimit = DEFAULT_OUTPUT_LIMIT
}) {
  if (!executable || !Array.isArray(args)) return Promise.reject(new Error('Invalid subprocess request'))

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args.map(String), {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const stdout = []
    const stderr = []
    let stdoutSize = 0
    let stderrSize = 0
    let timedOut = false
    let settled = false
    let forceKillTimer = null

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
      forceKillTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
      }, 2000)
      forceKillTimer.unref?.()
    }, Math.max(100, Number(timeoutMs) || 120000))

    child.stdout.on('data', (chunk) => {
      stdoutSize = appendLimited(stdout, stdoutSize, chunk, outputLimit)
    })
    child.stderr.on('data', (chunk) => {
      stderrSize = appendLimited(stderr, stderrSize, chunk, outputLimit)
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      resolve({
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      })
    })

    if (input == null) {
      child.stdin.end()
      return
    }
    child.stdin.on('error', () => {})
    child.stdin.end(String(input), 'utf8')
  })
}
