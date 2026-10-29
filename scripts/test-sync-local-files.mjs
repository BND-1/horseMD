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

// The scan reuses hashes of unchanged files (size, mtime, ctime, file id).
// Two files of the same size and mtime swapping names must still be seen:
// size + mtime alone missed it on Windows (test:sync-move "交换两个文件的名字").
{
  const dir = await fs.mkdtemp(join(tmpdir(), 'hm-scan-cache-'))
  const when = new Date(2026, 0, 1, 12)
  await fs.writeFile(join(dir, 'a.md'), 'AAAA')
  await fs.writeFile(join(dir, 'b.md'), 'BBBB')
  for (const name of ['a.md', 'b.md']) await fs.utimes(join(dir, name), when, when)
  const first = await scanLocalWorkspace(dir)
  await fs.rename(join(dir, 'a.md'), join(dir, 'tmp.md'))
  await fs.rename(join(dir, 'b.md'), join(dir, 'a.md'))
  await fs.rename(join(dir, 'tmp.md'), join(dir, 'b.md'))
  for (const name of ['a.md', 'b.md']) await fs.utimes(join(dir, name), when, when)
  const second = await scanLocalWorkspace(dir)
  assert.equal(second.get('a.md').sha256, first.get('b.md').sha256, 'swapped names: a.md now holds B')
  assert.equal(second.get('b.md').sha256, first.get('a.md').sha256)
  // An edit that keeps size and mtime (rewritten in place, then mtime reset)
  // changes ctime, so it is hashed again.
  await new Promise((resolve) => setTimeout(resolve, 20))
  await fs.writeFile(join(dir, 'a.md'), 'CCCC')
  await fs.utimes(join(dir, 'a.md'), when, when)
  assert.equal((await scanLocalWorkspace(dir)).get('a.md').sha256, sha256(Buffer.from('CCCC')))
  await fs.rm(dir, { recursive: true, force: true })
}

console.log('PASS sync local files: attachments included, internal directories and symlinks excluded, hash cache sees swapped names and same-size edits')
