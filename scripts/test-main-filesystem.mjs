import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  listMarkdownFiles,
  nextDuplicatePath,
  readDirectoryTree
} from '../src/main/filesystem.js'

const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-filesystem-'))
const markdownPattern = /\.(md|markdown|mdx|txt)$/i

try {
  await fs.mkdir(join(root, 'notes'))
  await fs.mkdir(join(root, 'node_modules'))
  await fs.mkdir(join(root, '.git'))
  await fs.writeFile(join(root, 'z.md'), '# z')
  await fs.writeFile(join(root, 'a.txt'), 'a')
  await fs.writeFile(join(root, 'ignored.json'), '{}')
  await fs.writeFile(join(root, '.secret.md'), 'secret')
  await fs.writeFile(join(root, '.gitignore'), 'dist')
  await fs.writeFile(join(root, 'notes', 'nested.markdown'), '# nested')
  await fs.writeFile(join(root, 'node_modules', 'package.md'), '# ignored')
  await fs.writeFile(join(root, '.git', 'internal.md'), '# ignored')

  const visibleTree = await readDirectoryTree(root, { markdownPattern })
  assert.deepEqual(visibleTree.map(({ name, type }) => ({ name, type })), [
    { name: 'notes', type: 'dir' },
    { name: 'a.txt', type: 'file' },
    { name: 'z.md', type: 'file' }
  ])

  const hiddenTree = await readDirectoryTree(root, { showHidden: true, markdownPattern })
  assert.equal(hiddenTree.some((entry) => entry.name === '.secret.md'), true)
  assert.equal(hiddenTree.some((entry) => entry.name === '.git'), false)

  const visibleFiles = await listMarkdownFiles(root, { markdownPattern })
  assert.deepEqual(
    visibleFiles.map((entry) => entry.rel).sort(),
    ['a.txt', 'notes/nested.markdown', 'z.md']
  )

  const hiddenFiles = await listMarkdownFiles(root, { showHidden: true, markdownPattern })
  assert.deepEqual(
    hiddenFiles.map((entry) => entry.rel).sort(),
    ['.secret.md', 'a.txt', 'notes/nested.markdown', 'z.md']
  )

  const occupied = new Set([
    join(root, 'z copy.md'),
    join(root, 'z copy 2.md')
  ])
  assert.equal(
    nextDuplicatePath(join(root, 'z.md'), (path) => occupied.has(path)),
    join(root, 'z copy 3.md')
  )
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

console.log('PASS main filesystem: tree, hidden files, recursion and duplicate naming')
