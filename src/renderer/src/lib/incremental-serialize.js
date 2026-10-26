// Incremental Markdown serialization of a large document (2026-10-24).
//
// Every rich→source sync serializes the whole ProseMirror document: ~40 ms
// on an M-series Mac and ~90 ms on Windows for a 250 K-char file, paid after
// every typing pause, bold / italic, heading change, Backspace…. Most of the
// document is unchanged between two syncs, so its Markdown is reused here.
//
// How the whole-document output is built (Milkdown SerializerState →
// mdast-util-to-markdown): the root's children are joined by `between()`
// ("\n\n", or "\n\n<!---->\n\n" for a few pairs), then one final "\n" is
// added unless the text already ends with one. A child's own text depends
// only on itself and on the child just before it when both are lists (the
// bullet / delimiter alternates). So the document is kept as SEGMENTS of
// top-level children — runs of adjacent lists never split — each holding its
// text exactly as it appears in the whole output ("in context"):
//
//   full = finalize(seg[0].text + "\n\n" + seg[1].text + …)
//
// The last segment's text keeps the final newline, so finalize() is a no-op
// for it and the end-of-document rules stay with the real serializer.
//
// An edit serializes a WINDOW: the changed segments plus one unchanged
// segment on each side. The window's output must start with the left
// neighbour's cached text and end with the right neighbour's — that proves
// the change did not alter its neighbours (an alternating bullet, a separator
// comment, Milkdown's "empty paragraph that is the last child" rule…). Only
// then is the middle spliced in; anything else falls back to a full
// serialization (always correct). Segments come from an idle-time bootstrap
// that must reproduce the full output byte for byte, or the document is
// never served incrementally.
//
// `check: true` (self-check builds, tests) compares every incremental result
// with a full serialization; `verifyEvery` does it at idle time now and then
// in normal builds. A mismatch disables incremental serialization for good
// (this editor) and is reported through `onMismatch`.

const LIST_TYPES = new Set(['bullet_list', 'ordered_list'])
const SENTINEL_TEXT = 'hmincrementalserializesentinel'
const SENTINEL_SUFFIX = `\n\n${SENTINEL_TEXT}\n`

const UNRELATED = Symbol('unrelated document')
const finalize = (text) => (text && !text.endsWith('\n') && !text.endsWith('\r') ? `${text}\n` : text)
const isList = (node) => LIST_TYPES.has(node?.type?.name)
const childrenOf = (doc) => {
  const out = []
  doc.forEach((child) => out.push(child))
  return out
}
const makeDoc = (doc, children) => doc.type.create(doc.attrs, doc.content.constructor.fromArray(children))

// Group children into segments: a run of adjacent lists stays together.
const groupChildren = (children) => {
  const groups = []
  for (let index = 0; index < children.length; index += 1) {
    const last = groups[groups.length - 1]
    if (last && isList(children[index]) && isList(children[index - 1])) last.count += 1
    else groups.push({ start: index, count: 1 })
  }
  return groups
}

export function createIncrementalSerializer({
  serialize,
  minChildren = 64,
  verifyEvery = 100,
  scheduleIdle = (run) => setTimeout(run, 0),
  onMismatch = null,
  check = () => false,
  // The document being edited (the live view's). Only it may become the
  // base: the sync also serializes freshly parsed documents (all new nodes),
  // and bootstrapping one of those would make every later edit "unrelated".
  isPrimary = () => true
}) {
  // { doc, style, children, segs: [{ count, text }] }
  let base = null
  let disabled = false
  // Set when the editor is destroyed: idle work scheduled before must not
  // run its serializer any more (Milkdown's paragraph rule reads the
  // destroyed view and throws; an uncaught error keeps the editor alive).
  let disposed = false
  let bootstrapping = null
  let served = 0
  const stats = { incremental: 0, full: 0, fallback: 0, bootstraps: 0 }

  const disable = (reason, detail) => {
    disabled = true
    base = null
    bootstrapping = null
    try { onMismatch?.({ reason, ...detail }) } catch { /* reporting never breaks a sync */ }
  }

  // Idle bootstrap: each segment's in-context text, from [segment…, sentinel].
  const bootstrap = (doc, style, full) => {
    // A running bootstrap finishes first: edits made meanwhile are local, and
    // the next serialization diffs against the bootstrapped document.
    if (disabled || bootstrapping) return
    const children = childrenOf(doc)
    if (children.length < minChildren) return
    const schema = doc.type.schema
    const paragraph = schema.nodes.paragraph
    if (!paragraph) return
    const sentinel = paragraph.create(null, schema.text(SENTINEL_TEXT))
    const groups = groupChildren(children)
    const job = { doc, style, full, children, groups, texts: [], next: 0 }
    bootstrapping = job
    const step = (deadline) => {
      if (bootstrapping !== job || disabled || disposed) return
      while (job.next < groups.length) {
        if (deadline && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() < 2 && job.texts.length) break
        const group = groups[job.next]
        let part
        try { part = serialize(makeDoc(doc, [...children.slice(group.start, group.start + group.count), sentinel])) } catch { part = null }
        if (typeof part !== 'string' || !part.endsWith(SENTINEL_SUFFIX)) {
          bootstrapping = null
          return // unusual output (an unknown separator rule): stay full
        }
        job.texts.push(part.slice(0, -SENTINEL_SUFFIX.length))
        job.next += 1
      }
      if (job.next < groups.length) {
        scheduleIdle(step)
        return
      }
      bootstrapping = null
      const segs = groups.map((group, index) => ({ count: group.count, text: job.texts[index] }))
      // The last segment keeps the final newline exactly as the full output has it.
      const head = segs.slice(0, -1).map((seg) => seg.text)
      const headBody = head.join('\n\n')
      const prefix = head.length ? `${headBody}\n\n` : ''
      if (!full.startsWith(prefix)) return
      segs[segs.length - 1].text = full.slice(prefix.length)
      if (finalize(segs.map((seg) => seg.text).join('\n\n')) !== full) return
      stats.bootstraps += 1
      stats.segments = segs.length
      stats.largestSegment = Math.max(...segs.map((seg) => seg.count))
      stats.largestSegmentChars = Math.max(...segs.map((seg) => seg.text.length))
      base = { doc, style, children, segs }
    }
    scheduleIdle(step)
  }

  // Shares at least half of the base's top-level nodes (by identity): an
  // edit of the same document, not a freshly parsed one.
  const relatedToBase = (children) => {
    if (!base) return false
    base.childSet ??= new Set(base.children)
    let shared = 0
    for (const child of children) if (base.childSet.has(child)) shared += 1
    return shared * 2 >= Math.min(base.children.length, children.length)
  }

  // A wide edit leaves one large middle segment, and every later window
  // touching it would serialize all of it. Split it again at idle time: the
  // per-group texts (computed with the sentinel, as in the bootstrap) must
  // join back to exactly the segment's text, or the segment stays as it is.
  const REFINE_COUNT = 8
  const refineLater = (seg) => {
    scheduleIdle(() => {
      if (disabled || disposed || !base) return
      const index = base.segs.indexOf(seg)
      const fail = (why) => { stats.refineFail = stats.refineFail || {}; stats.refineFail[why] = (stats.refineFail[why] || 0) + 1 }
      if (index < 0) return fail('gone')
      let start = 0
      for (let i = 0; i < index; i += 1) start += base.segs[i].count
      const children = base.children.slice(start, start + seg.count)
      const schema = base.doc.type.schema
      const paragraph = schema.nodes.paragraph
      if (!paragraph) return
      const sentinel = paragraph.create(null, schema.text(SENTINEL_TEXT))
      const groups = groupChildren(children)
      if (groups.length < 2) return fail('one-group')
      const texts = []
      for (const group of groups) {
        let part
        try { part = serialize(makeDoc(base.doc, [...children.slice(group.start, group.start + group.count), sentinel])) } catch { part = null }
        if (typeof part !== 'string' || !part.endsWith(SENTINEL_SUFFIX)) return fail('sentinel')
        texts.push(part.slice(0, -SENTINEL_SUFFIX.length))
      }
      const isTail = index === base.segs.length - 1
      if (isTail) {
        const headText = texts.slice(0, -1).join('\n\n')
        const prefix = texts.length > 1 ? `${headText}\n\n` : ''
        if (!seg.text.startsWith(prefix)) return fail('tail-prefix')
        texts[texts.length - 1] = seg.text.slice(prefix.length)
      }
      if (texts.join('\n\n') !== seg.text) return fail('join')
      if (!base || base.segs[index] !== seg) return fail('changed') // changed meanwhile
      const pieces = groups.map((group, i) => ({ count: group.count, text: texts[i] }))
      base = { ...base, segs: [...base.segs.slice(0, index), ...pieces, ...base.segs.slice(index + 1)] }
      stats.refined = (stats.refined || 0) + 1
    })
  }

  const assemble = (segs) => finalize(segs.map((seg) => seg.text).join('\n\n'))

  // Changed child range between base.children and the new children (identity).
  const diff = (oldChildren, newChildren) => {
    let head = 0
    const max = Math.min(oldChildren.length, newChildren.length)
    while (head < max && oldChildren[head] === newChildren[head]) head += 1
    let tail = 0
    while (
      tail < max - head &&
      oldChildren[oldChildren.length - 1 - tail] === newChildren[newChildren.length - 1 - tail]
    ) tail += 1
    return { head, tail }
  }

  const tryIncremental = (doc, style) => {
    if (!base || base.style !== style) return null
    const children = childrenOf(doc)
    const { head, tail } = diff(base.children, children)
    if (head === base.children.length && head === children.length) {
      return { text: assemble(base.segs), children, segs: base.segs }
    }
    // An unrelated document (most children replaced): serialize it whole and
    // keep the base for the document that is being edited.
    if (!relatedToBase(children)) {
      stats.lastUnrelated = { head, tail, oldChildren: base.children.length, newChildren: children.length }
      return UNRELATED
    }
    // Segments touched by the old changed range [head, oldEnd).
    const oldEnd = base.children.length - tail
    const segs = base.segs
    const starts = []
    let at = 0
    for (const seg of segs) { starts.push(at); at += seg.count }
    let first = segs.findIndex((seg, index) => starts[index] + seg.count > head)
    if (first < 0) first = segs.length - 1 // insertion at the very end
    let last = first
    while (last + 1 < segs.length && starts[last + 1] < oldEnd) last += 1
    // An insertion exactly at a segment boundary still re-serializes the
    // segment it lands in (keeps the window non-empty and the logic uniform).
    const left = first > 0 ? first - 1 : -1
    const right = last + 1 < segs.length ? last + 1 : -1
    const winOldStart = left >= 0 ? starts[left] : starts[first]
    const winOldEnd = right >= 0 ? starts[right] + segs[right].count : base.children.length
    const delta = children.length - base.children.length
    const winNewStart = winOldStart
    const winNewEnd = winOldEnd + delta
    if (winNewEnd < winNewStart) return null
    const windowChildren = children.slice(winNewStart, winNewEnd)
    if (!windowChildren.length) return null
    // A list run must not start or end inside the window boundary children
    // differently from the cached segmentation: adjacent lists across the
    // window edge would make a neighbour depend on outside context.
    const before = children[winNewStart - 1]
    const afterNode = children[winNewEnd]
    if ((before && isList(before) && isList(windowChildren[0])) ||
        (afterNode && isList(afterNode) && isList(windowChildren[windowChildren.length - 1]))) return null
    const windowText = serialize(makeDoc(doc, windowChildren))
    if (windowChildren.length > 50) stats.wideWindows = (stats.wideWindows || 0) + 1
    stats.lastWindowChildren = windowChildren.length
    stats.lastWindowChars = typeof windowText === 'string' ? windowText.length : 0
    if (stats.lastWindowChildren > (stats.maxWindowChildren || 0)) {
      stats.maxWindowChildren = stats.lastWindowChildren
      stats.maxWindowAt = { head, oldEnd, oldChildren: base.children.length, newChildren: children.length }
    }
    if (typeof windowText !== 'string') return null
    const leftText = left >= 0 ? segs[left].text : null
    const rightText = right >= 0 ? segs[right].text : null
    const leftPart = leftText != null ? `${leftText}\n\n` : ''
    if (!windowText.startsWith(leftPart)) return null
    const middleCount = windowChildren.length - (left >= 0 ? segs[left].count : 0) - (right >= 0 ? segs[right].count : 0)
    if (middleCount < 0) return null
    // The window's text must equal leftPart + middle + rightPart exactly.
    // A right neighbour that is the document tail already carries the final
    // newline; any other right neighbour gets finalize() like the full output.
    const isTail = right === segs.length - 1
    let middle = ''
    if (middleCount === 0) {
      if (leftText == null || rightText == null) return null
      const expected = isTail ? `${leftPart}${rightText}` : finalize(`${leftPart}${rightText}`)
      if (windowText !== expected) return null
    } else if (rightText != null) {
      const rightPart = `\n\n${rightText}`
      const body = isTail || rightText.endsWith('\n') ? windowText
        : (windowText.endsWith('\n') ? windowText.slice(0, -1) : null)
      if (body == null || !body.endsWith(rightPart) || body.length < leftPart.length + rightPart.length) return null
      middle = body.slice(leftPart.length, body.length - rightPart.length)
      const rebuilt = `${leftPart}${middle}${rightPart}`
      if ((isTail ? rebuilt : finalize(rebuilt)) !== windowText) return null
    } else {
      // The window reaches the end: the middle is the new tail, final newline
      // included, exactly as the window (and the full document) ends.
      middle = windowText.slice(leftPart.length)
    }
    const nextSegs = [
      ...segs.slice(0, left >= 0 ? left + 1 : first),
      ...(middleCount > 0 ? [{ count: middleCount, text: middle }] : []),
      ...(right >= 0 ? segs.slice(right) : [])
    ]
    const total = nextSegs.reduce((sum, seg) => sum + seg.count, 0)
    if (total !== children.length) return null
    return { text: assemble(nextSegs), children, segs: nextSegs }
  }

  const verifyLater = (doc, style, text) => {
    const ref = typeof WeakRef === 'function' ? new WeakRef(doc) : { deref: () => doc }
    scheduleIdle(() => {
      if (disabled || disposed) return
      const target = ref.deref()
      if (!target) return
      let expected
      try { expected = serialize(target) } catch { return }
      if (expected !== text) disable('idle-verify', { expectedLength: expected.length, gotLength: text.length })
    })
  }

  return {
    stats,
    get enabled () { return !disabled },
    // Returns the document's Markdown (always correct: incremental only when
    // proven by the window checks, else a full serialization).
    serialize (doc, style) {
      const isDoc = doc && typeof doc === 'object' && doc.type?.name === 'doc' && typeof doc.forEach === 'function'
      // Small documents (the sync also serializes one-block helper documents
      // through the same serializer) are serialized whole and never become
      // the base: diffing the large document against them would make the
      // next window the entire document.
      if (!isDoc || disabled || doc.childCount < minChildren) {
        stats.full += 1
        return serialize(doc)
      }
      let result = null
      try { result = tryIncremental(doc, style) } catch { result = null }
      if (result === UNRELATED && !isPrimary(doc)) {
        stats.full += 1
        stats.unrelated = (stats.unrelated || 0) + 1
        return serialize(doc)
      }
      if (result === UNRELATED) result = null // the edited document moved on: rebase on it
      if (result) {
        if (check()) {
          const expected = serialize(doc)
          if (expected !== result.text) {
            disable('self-check', { expectedLength: expected.length, gotLength: result.text.length })
            stats.full += 1
            return expected
          }
        }
        base = { doc, style, children: result.children, segs: result.segs }
        const wide = result.segs.find((seg) => seg.count > REFINE_COUNT && !seg.refining)
        if (wide) { wide.refining = true; refineLater(wide) }
        stats.incremental += 1
        served += 1
        if (verifyEvery > 0 && served % verifyEvery === 0) verifyLater(doc, style, result.text)
        return result.text
      }
      stats.full += 1
      const related = base ? relatedToBase(childrenOf(doc)) : false
      const full = serialize(doc)
      if (!isPrimary(doc) && !related) return full
      if (base) stats.fallback += 1
      base = null
      if (typeof full === 'string') bootstrap(doc, style, full)
      return full
    },
    // `next` serializes to exactly the bytes of `previous` (the caller proved
    // it: they differ only in attributes the serializer never writes, e.g.
    // heading ids). Re-key the cached segments to `next`, whose replaced
    // nodes would otherwise widen every later window.
    adoptEquivalent (previous, next) {
      if (!base || base.doc !== previous || !next || typeof next.forEach !== 'function') return
      if (next.childCount !== previous.childCount) return
      base = { doc: next, style: base.style, segs: base.segs, children: childrenOf(next) }
    },
    forget () { base = null; bootstrapping = null },
    // The editor is gone: drop the cached document and stop idle work.
    dispose () { disposed = true; base = null; bootstrapping = null }
  }
}
