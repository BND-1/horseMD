// Pure parts of "images in content pasted from another document":
// renderer lib/pasted-image-refs.js (find + rewrite the authored bytes) and
// main/pasted-images.js (what the target writes instead).
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectRelativeImageRefs, rewriteImageRefs, sameDocumentFolder } from '../src/renderer/src/lib/pasted-image-refs.js'
import { importPastedImages } from '../src/main/pasted-images.js'

const rewrite = (md, mapping) => rewriteImageRefs(md, collectRelativeImageRefs(md), mapping)
const map = { 'assets/p.png': 'assets/p-1.png', 'pics sub/q r.png': 'assets/q r.png', 'a%20b.png': 'assets/a b.png', 'x(1).png': 'assets/x(1).png' }

// Resource images, every spelling; only the destination changes.
assert.equal(rewrite('![red](assets/p.png)', map), '![red](assets/p-1.png)')
assert.equal(rewrite('![red](assets/p.png "t ](assets/p.png")', map), '![red](assets/p-1.png "t ](assets/p.png")')
assert.equal(rewrite('x ![b](<pics sub/q r.png>) y', map), 'x ![b](<assets/q r.png>) y')
assert.equal(rewrite('![](a%20b.png)', map), '![](<assets/a b.png>)')
assert.equal(rewrite('![](x\\(1\\).png)', map), '![](<assets/x(1).png>)')
assert.equal(rewrite('![al](t](assets/p.png)', map), '![al](t](assets/p.png)') // not an image here: literal
assert.equal(rewrite('[link](assets/p.png)', map), '[link](assets/p.png)') // links are not images
// Absolute / remote / data stay.
for (const md of ['![](/abs/p.png)', '![](https://x.org/p.png)', '![](data:image/png;base64,AA)', '![](file:///p.png)', '![](C:\\p.png)']) {
  assert.deepEqual(collectRelativeImageRefs(md), [], md)
}
// Code is not an image.
assert.deepEqual(collectRelativeImageRefs('```\n![](assets/p.png)\n```\n\n`![](assets/p.png)`'), [])
// Reference images: the definition is rewritten.
assert.equal(rewrite('![r][img]\n\n[img]: assets/p.png "T"\n', map), '![r][img]\n\n[img]: assets/p-1.png "T"\n')
assert.equal(rewrite('[l][d]\n\n[d]: assets/p.png\n', map), '[l][d]\n\n[d]: assets/p.png\n') // link-only definition
// Raw HTML <img>, quoted or not, block and inline.
assert.equal(rewrite('<img src="assets/p.png" width="80">', map), '<img src="assets/p-1.png" width="80">')
assert.equal(rewrite("a <img alt='x' src='pics sub/q r.png'> b", map), 'a <img alt=\'x\' src="assets/q r.png"> b')
assert.equal(rewrite('<p><img src=assets/p.png></p>', map), '<p><img src="assets/p-1.png"></p>')
// Tables, lists, quotes keep every other byte.
const doc = '# T\n\n| a | b |\n|---|---|\n| ![](assets/p.png) | z |\n\n- item ![q](<pics sub/q r.png>)\n\n> ![](assets/p.png)\n'
assert.equal(rewrite(doc, map), doc.replace(/assets\/p\.png/g, 'assets/p-1.png').replace('<pics sub/q r.png>', '<assets/q r.png>'))
// Unmapped urls stay as written.
assert.equal(rewrite('![](assets/missing.png)', map), '![](assets/missing.png)')

assert.equal(sameDocumentFolder('/a/b/x.md', '/a/b/y.md'), true)
assert.equal(sameDocumentFolder('/a/b/x.md', '/a/c/y.md'), false)
assert.equal(sameDocumentFolder('C:\\A\\x.md', 'c:/a/y.md'), true)

// main: copy rules.
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const root = await mkdtemp(join(tmpdir(), 'horsemd-pasted-images-'))
const A = join(root, 'A'), B = join(root, 'B'), paste = join(root, 'paste')
await mkdir(join(A, 'assets'), { recursive: true })
await mkdir(join(A, 'pics sub'), { recursive: true })
await mkdir(join(B, 'assets'), { recursive: true })
await writeFile(join(A, 'assets', 'p.png'), png)
await writeFile(join(A, 'pics sub', 'q r.png'), Buffer.concat([png, Buffer.from('q')]))
await writeFile(join(A, 'notes.txt'), 'secret')
await writeFile(join(B, 'assets', 'p.png'), Buffer.from('other bytes')) // same name, other image
const r1 = await importPastedImages({
  sourceDocPath: join(A, 'a.md'), targetDocPath: join(B, 'b.md'), pasteDir: paste,
  urls: ['assets/p.png', 'pics%20sub/q%20r.png', 'pics sub/q r.png', 'notes.txt', 'missing.png', '../A/assets/p.png']
})
assert.deepEqual(r1, { 'assets/p.png': 'assets/p-1.png', 'pics%20sub/q%20r.png': 'assets/q r.png', 'pics sub/q r.png': 'assets/q r.png', '../A/assets/p.png': 'assets/p-1.png' })
assert.deepEqual((await readdir(join(B, 'assets'))).sort(), ['p-1.png', 'p.png', 'q r.png'])
assert.deepEqual(await readFile(join(B, 'assets', 'p-1.png')), png)
// Pasting again reuses the copies.
const r2 = await importPastedImages({ sourceDocPath: join(A, 'a.md'), targetDocPath: join(B, 'b.md'), pasteDir: paste, urls: ['assets/p.png'] })
assert.deepEqual(r2, { 'assets/p.png': 'assets/p-1.png' })
assert.equal((await readdir(join(B, 'assets'))).length, 3)
// Target folder holds the image (A is inside root): a path, no copy.
const r3 = await importPastedImages({ sourceDocPath: join(A, 'a.md'), targetDocPath: join(root, 'top.md'), pasteDir: paste, urls: ['assets/p.png', 'pics sub/q r.png'] })
assert.deepEqual(r3, { 'assets/p.png': 'A/assets/p.png', 'pics sub/q r.png': 'A/pics sub/q r.png' })
await assert.rejects(readdir(join(root, 'assets')))
// Through a symlinked target folder too.
await symlink(root, join(tmpdir(), `horsemd-pasted-link-${process.pid}`)).catch(() => {})
const r4 = await importPastedImages({ sourceDocPath: join(A, 'a.md'), targetDocPath: join(tmpdir(), `horsemd-pasted-link-${process.pid}`, 'top.md'), pasteDir: paste, urls: ['assets/p.png'] })
assert.deepEqual(r4, { 'assets/p.png': 'A/assets/p.png' })
// Unsaved target: the paste folder, as a file:// URL.
const r5 = await importPastedImages({ sourceDocPath: join(A, 'a.md'), targetDocPath: null, pasteDir: paste, urls: ['assets/p.png'] })
assert.match(r5['assets/p.png'], /^file:\/\/.*\/paste\/p\.png$/)
// Bad input does nothing.
assert.deepEqual(await importPastedImages({ sourceDocPath: 'rel/a.md', targetDocPath: join(B, 'b.md'), urls: ['assets/p.png'] }), {})
assert.deepEqual(await importPastedImages({ sourceDocPath: join(A, 'a.md'), targetDocPath: 'rel/b.md', urls: ['assets/p.png'] }), {})
console.log('PASS pasted images (refs + main copy rules)')
