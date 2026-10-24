// Login-shell PATH resolution (issue #160): markers survive profile noise,
// fish prints a list, a hanging profile times out, PATH lists merge in order.
import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergePath, readLoginShellPath } from '../src/main/shell-path.js'

if (process.platform === 'win32') { console.log('SKIP shell path: not used on Windows'); process.exit(0) }
const dir = await mkdtemp(join(tmpdir(), 'horsemd-shell-path-'))
try {
  // A "shell" whose profile prints a banner before running the -c script.
  const noisy = join(dir, 'noisyshell')
  await writeFile(noisy, '#!/bin/sh\necho "Welcome banner"\nPATH=/custom/tools:/usr/bin\nexport PATH\nshift\nexec /bin/sh -c "$1"\n')
  await chmod(noisy, 0o755)
  assert.equal(await readLoginShellPath({ shell: noisy }), '/custom/tools:/usr/bin')
  // A profile that never returns.
  const hang = join(dir, 'hangshell')
  await writeFile(hang, '#!/bin/sh\nsleep 30\n')
  await chmod(hang, 0o755)
  const started = Date.now()
  assert.equal(await readLoginShellPath({ shell: hang, timeoutMs: 300 }), '')
  assert.ok(Date.now() - started < 3000)
  // A missing shell.
  assert.equal(await readLoginShellPath({ shell: join(dir, 'nope') }), '')
  assert.equal(mergePath('/a:/b', '/b:/c', '', '/a:/d'), '/a:/b:/c:/d')
} finally {
  await rm(dir, { recursive: true, force: true })
}
console.log('PASS shell path: login PATH read through profile noise, timeout and missing shell handled, merge keeps order')
