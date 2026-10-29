// Atomic save (main/filesystem.js writeFileAtomic, docs/cloud-sync-review.md
// P0): a save never leaves a half-written file. Checks: content, no temp file
// left, permissions kept, hard links kept (in-place write), writing through a
// symlink updates its target, extended attributes kept (macOS: Finder tags),
// and a reader polling during repeated saves of a large file only ever sees a
// complete version (an in-place write shows it empty / partial). On Windows a
// file another program holds open cannot be replaced: the save moves the old
// file aside and puts the new one in its place, so for an instant the name
// can be missing (counted separately, allowed there) — but a reader never
// gets half a file. The reader pauses 2 ms between reads there (real readers
// — antivirus, indexers, sync tools — hold files briefly).
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileAtomic } from '../src/main/filesystem.js'

const root = await fs.mkdtemp(join(tmpdir(), 'hm-atomic-save-'))
const leftovers = async () => (await fs.readdir(root)).filter((n) => n.endsWith('.hmtmp'))
try {
  // New file, then overwrite.
  const file = join(root, '笔记.md')
  await writeFileAtomic(file, '第一版\n')
  assert.equal(await fs.readFile(file, 'utf8'), '第一版\n')
  await writeFileAtomic(file, '第二版\n')
  assert.equal(await fs.readFile(file, 'utf8'), '第二版\n')
  assert.deepEqual(await leftovers(), [])

  // Permissions kept (POSIX).
  if (process.platform !== 'win32') {
    await fs.chmod(file, 0o640)
    await writeFileAtomic(file, '第三版\n')
    assert.equal((await fs.stat(file)).mode & 0o777, 0o640)
  }

  // Hard link: written in place, both names see the new text.
  const linked = join(root, 'linked.md')
  const other = join(root, 'other-name.md')
  await fs.writeFile(linked, 'old\n')
  await fs.link(linked, other)
  const inode = (await fs.stat(linked)).ino
  await writeFileAtomic(linked, 'new\n')
  assert.equal(await fs.readFile(other, 'utf8'), 'new\n')
  assert.equal((await fs.stat(linked)).ino, inode)

  // Symlink: the target changes, the link stays a link (not on Windows,
  // where creating symlinks needs a privilege).
  if (process.platform !== 'win32') {
    const target = join(root, 'target.md')
    const link = join(root, 'link.md')
    await fs.writeFile(target, 'before\n')
    await fs.symlink(target, link)
    await writeFileAtomic(link, 'after\n')
    assert.equal(await fs.readFile(target, 'utf8'), 'after\n')
    assert.ok((await fs.lstat(link)).isSymbolicLink())
  }

  // macOS: extended attributes (Finder tags live in one) survive the save.
  if (process.platform === 'darwin') {
    execFileSync('xattr', ['-w', 'com.horsemd.test', 'kept', file])
    await writeFileAtomic(file, '第四版\n')
    assert.equal(execFileSync('xattr', ['-p', 'com.horsemd.test', file]).toString().trim(), 'kept')
  }

  // A reader never sees a partial file during repeated saves.
  const big = join(root, 'big.md')
  const versions = ['甲'.repeat(400000) + '\n', '乙'.repeat(400000) + '\n']
  await fs.writeFile(big, versions[0])
  let reading = true
  let reads = 0
  let partial = 0
  let missing = 0
  const reader = (async () => {
    while (reading) {
      try {
        const text = await fs.readFile(big, 'utf8')
        reads += 1
        if (!versions.includes(text)) partial += 1
        if (process.platform === 'win32') await new Promise((resolve) => setTimeout(resolve, 2))
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'EPERM' && error?.code !== 'EBUSY') throw error
        if (process.platform === 'win32' && error?.code === 'ENOENT') missing += 1
        else partial += 1 // elsewhere the file is never missing either
      }
    }
  })()
  for (let i = 0; i < 40; i += 1) await writeFileAtomic(big, versions[i % 2])
  reading = false
  await reader
  assert.ok(reads > 10, `reader ran (${reads})`)
  assert.equal(partial, 0, `a reader saw ${partial} partial / missing reads out of ${reads}`)
  assert.ok(missing <= reads / 4, `the name was missing too often on Windows (${missing} of ${reads})`)
  assert.deepEqual(await leftovers(), [])
  console.log(`PASS atomic save: content, no temp left, permissions, hard link in place, symlink target, xattrs, ${reads} concurrent reads never partial${missing ? ` (name briefly missing ${missing}×, Windows move-aside)` : ''}`)
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
