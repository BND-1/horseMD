// Issue #160: macOS apps started from Finder / the Dock get a bare PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), so `picgo upload` (installed by npm under
// Homebrew / nvm / ~/.local, and itself a `#!/usr/bin/env node` script) failed
// with "picgo: command not found". The upload command must run with the
// user's login-shell PATH. Here: a stand-in uploader in a temp folder that is
// only on the PATH of a stand-in login shell (SHELL), and needs node, which
// is not on the app's bare PATH either.
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

if (process.platform === 'win32') { console.log('SKIP image host PATH: macOS/Linux only'); process.exit(0) }
const root = await mkdtemp(join(tmpdir(), 'horsemd-imghost-path-'))
let app = null
try {
  const bin = join(root, 'tools')
  await mkdir(bin)
  const tool = join(bin, 'hm-fake-picgo')
  await writeFile(tool, `#!/usr/bin/env node
console.log('[PicGo SUCCESS]:')
console.log('https://img.example.com/' + require('path').basename(process.argv[3] || ''))
`)
  await chmod(tool, 0o755)
  // The login shell's profile puts the tool folder and node on PATH.
  const shell = join(root, 'login-shell')
  await writeFile(shell, `#!/bin/sh\nPATH=${bin}:${dirname(process.execPath)}:/usr/bin:/bin\nexport PATH\nshift\nexec /bin/sh -c "$1"\n`)
  await chmod(shell, 0o755)
  app = await launchBuiltElectron({
    profileDir: join(root, 'profile'),
    port: 9473,
    // What Finder / the Dock hand to an app, plus the account's shell.
    env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: shell }
  })
  const result = await app.evaluate(`window.api.uploadImage('hm-fake-picgo upload', 'shot.png', new Uint8Array([137, 80, 78, 71]))`)
  console.log(result)
  assert.equal(result.ok, true, `upload failed: ${result.error}`)
  assert.equal(result.url, 'https://img.example.com/shot.png')
  // A command that really is missing says how to find its full path.
  const missing = await app.evaluate(`window.api.uploadImage('hm-no-such-uploader upload', 'a.png', new Uint8Array([1]))`)
  console.log(missing)
  assert.equal(missing.ok, false)
  assert.match(missing.error, /找不到命令「hm-no-such-uploader」.*which hm-no-such-uploader/)
} finally {
  if (app) await stopBuiltElectron(app)
  await rm(root, { recursive: true, force: true })
}
console.log('PASS image host PATH: the upload command runs with the login-shell PATH')
