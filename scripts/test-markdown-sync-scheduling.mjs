import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

// Exercise the actual production scheduling block, not a duplicate algorithm.
const source = await readFile(new URL('../src/renderer/src/components/Editor.jsx', import.meta.url), 'utf8')
const start = source.indexOf('      let markdownSyncLastMs = 0')
const end = source.indexOf('\n    })\n\n    const runCreate', start)
assert.ok(start >= 0 && end > start, 'production scheduler boundaries missing')
const block = source.slice(start, end)
const createHarness = () => {
  let clock = 1000
  let nextId = 1
  let callback
  const timers = new Map()
  const calls = []
  const cleanups = []
  const flags = { current: null }
  const context = {
    Date: { now: () => clock },
    performance: { now: () => clock },
    setTimeout: (fn, delay) => { const id = nextId++; timers.set(id, { fn, at: clock + delay }); return id },
    clearTimeout: (id) => timers.delete(id),
    ready: true, appending: false,
    pendingRawMarkdownPasteRef: { current: null },
    wholeDocumentReplacementPending: null,
    programmaticReplaceRef: flags,
    viewRef: { current: { composing: false, state: { doc: { text: '' } } } },
    serializerCtx: 'serializer',
    crepe: { editor: { ctx: { get: () => (doc) => doc.text } } },
    richFlushPending: true,
    cancelDeferredMarkdownSync: () => {},
    hasRecentUserEdit: () => true,
    handleMarkdownUpdatedImpl: (_ctx, md) => { calls.push(md[0]); clock += 200 },
    api: { markdownUpdated: (fn) => { callback = fn } },
    cleanups
  }
  runInNewContext(block, context)
  const fireTimers = () => {
    for (const [id, timer] of [...timers]) {
      if (!timers.delete(id)) continue
      clock = Math.max(clock, timer.at)
      timer.fn()
    }
  }
  const mutate = (letter) => { context.viewRef.current.state.doc = { text: letter.repeat(100001) } }
  return {
    calls, timers, flags, cleanups, mutate, context,
    cancel: () => context.cancelDeferredMarkdownSync(),
    send: (letter) => { mutate(letter); callback(null, letter.repeat(100001)) },
    advance: (ms) => { clock += ms }, fireTimers
  }
}

for (const mode of ['hard-cap', 'programmatic-boundary']) {
  const h = createHarness()
  h.send('A')
  assert.equal(h.timers.size, 1)
  if (mode === 'hard-cap') h.advance(5000)
  else h.flags.current = {}
  h.send('B')
  h.fireTimers()
  assert.deepEqual(h.calls, ['B'], `${mode}: stale A ran after newer B`)
}
const latest = createHarness()
latest.send('A')
latest.advance(100)
latest.send('B')
latest.fireTimers()
assert.deepEqual(latest.calls, ['B'], 'trailing execution must use latest callback')
const destroyed = createHarness()
destroyed.send('A')
destroyed.cleanups.forEach((cleanup) => cleanup())
destroyed.fireTimers()
assert.deepEqual(destroyed.calls, [], 'destroyed editor must not run deferred sync')
const advanced = createHarness()
advanced.send('A')
advanced.mutate('B')
advanced.fireTimers()
assert.deepEqual(advanced.calls, ['B'], 'deferred sync must serialize the current document, not captured A')
const flushed = createHarness()
flushed.send('A')
flushed.cancel()
flushed.mutate('B')
flushed.fireTimers()
assert.deepEqual(flushed.calls, [], 'forced flush must invalidate earlier callback')
for (const condition of ['committed', 'composition']) {
  const h = createHarness()
  h.send('A')
  if (condition === 'committed') h.context.richFlushPending = false
  else h.context.viewRef.current.composing = true
  h.fireTimers()
  assert.deepEqual(h.calls, [], `${condition}: must not publish a deferred snapshot`)
}
assert.match(source, /const clearRichFlushPending = \(\) => \{\s*cancelDeferredMarkdownSync\(\)/)
assert.match(source, /const publishPendingTransactionJournal = \([\s\S]*?\} = \{\}\) => \{\s*cancelDeferredMarkdownSync\(\)/)
console.log('PASS markdown scheduling: 8 cases including hard-cap, immediate, trailing, teardown, live freshness, flush cancellation, committed state, IME guard')
