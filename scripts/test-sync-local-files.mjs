import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanLocalWorkspace, sha256 } from '../src/main/sync/local-files.js'

const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-sync-scan-'))
try {
  await fs.mkdir(join(root, 'assets'), { recursive: true })
  await fs.mkdir(join(root, '.horsemd'), { recursive: true })
  await fs.mkdir(join(root, '.git'), { recursive: true })
  await fs.writeFile(join(root, 'note.md'), '# Note\n')
  await fs.writeFile(join(root, 'assets', 'photo.bin'), Buffer.from([1, 2, 3]))
  await fs.writeFile(join(root, '.horsemd', 'workspace.json'), '{}')
  await fs.writeFile(join(root, '.git', 'config'), 'hidden')
  await fs.symlink(join(root, 'note.md'), join(root, 'link.md'))

  const files = await scanLocalWorkspace(root)
  assert.deepEqual([...files.keys()].sort(), ['assets/photo.bin', 'note.md'])
  assert.equal(files.get('note.md').sha256, sha256(Buffer.from('# Note\n')))
  assert.equal(files.get('assets/photo.bin').size, 3)
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

console.log('PASS sync local files: attachments included, internal directories and symlinks excluded')
