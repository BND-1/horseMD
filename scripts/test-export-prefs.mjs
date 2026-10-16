import assert from 'node:assert/strict'
import { resolveSaveDir, withRecordedSaveDir } from '../src/main/export-prefs-logic.js'

let state = { saveDirs: {}, lastSaveDir: '' }

// Fresh: each file defaults to its OWN Markdown folder.
assert.equal(resolveSaveDir(state, '/notes/a.md'), '/notes')
assert.equal(resolveSaveDir(state, '/docs/b.md'), '/docs')

// Same file remembers a manually chosen folder.
state = withRecordedSaveDir(state, '/notes/a.md', '/exports')
assert.equal(resolveSaveDir(state, '/notes/a.md'), '/exports')

// A DIFFERENT file is untouched — still its own folder, NOT the remembered /exports.
assert.equal(resolveSaveDir(state, '/notes/b.md'), '/notes')
assert.equal(resolveSaveDir(state, '/docs/b.md'), '/docs')

// Re-recording the same file updates in place; no duplicate keys.
state = withRecordedSaveDir(state, '/notes/a.md', '/final')
assert.equal(resolveSaveDir(state, '/notes/a.md'), '/final')
assert.equal(Object.keys(state.saveDirs).length, 1)

// A second recorded file gets its own entry without disturbing the first.
state = withRecordedSaveDir(state, '/docs/b.md', '/pdfs')
assert.equal(resolveSaveDir(state, '/notes/a.md'), '/final')
assert.equal(resolveSaveDir(state, '/docs/b.md'), '/pdfs')
assert.equal(Object.keys(state.saveDirs).length, 2)

// Untitled (no path): global fallback only, no per-file entry created.
const untitled = withRecordedSaveDir({ saveDirs: {}, lastSaveDir: '' }, '', '/global')
assert.equal(resolveSaveDir(untitled, ''), '/global')
assert.deepEqual(untitled.saveDirs, {})

// Empty chosen dir is a no-op.
const before = { saveDirs: { '/x/y.md': '/keep' }, lastSaveDir: '/keep' }
assert.deepEqual(withRecordedSaveDir(before, '/x/y.md', ''), before)

console.log('PASS export-prefs: same file remembers, different files keep their own folder')
