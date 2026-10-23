// Markdown parsers intentionally discard some list spelling details: `-`, `+`,
// and `*` become one bullet node, and ordered item numbers are usually
// normalized. They must not discard list *slots*, though. An empty item created
// by Enter is still a real item, and silently dropping or duplicating that slot
// is the source of the family of rich/source divergence bugs.
//
// This fingerprint is intentionally smaller than a Markdown parser AST. The
// parser/semantic comparison remains responsible for text, nesting content,
// tables, headings, marks, and task state. This layer protects the information
// the parser is allowed to normalize but the source synchronizer must retain:
// list kind, nesting depth, task state, and whether each item is empty.

const markerPattern = /^([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/
const nestedMarkerPattern = /^([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/
const fenceLinePattern = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/
const closingFencePattern = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

const openingFence = (line) => {
  const match = String(line || '').match(fenceLinePattern)
  if (!match) return null
  const run = match[1]
  const rest = match[2] || ''
  // CommonMark forbids backticks in the info string of a backtick fence.
  // Therefore a source paragraph such as ```你好``` is literal text, not an
  // unterminated fence opener. Treating it as a fence hides every later list
  // slot from the integrity fingerprint.
  if (run[0] === '`' && rest.includes('`')) return null
  return { char: run[0], length: run.length }
}

const closesFence = (line, fence) => {
  const match = String(line || '').match(closingFencePattern)
  return Boolean(
    match && fence &&
    match[1][0] === fence.char &&
    match[1].length >= fence.length
  )
}
// Crepe serializes an empty paragraph as a standalone `<br />` line (optionally
// blockquote-prefixed as `> <br />`). It is an editor-only placeholder for the
// blank line that authored Markdown uses, so at the list-slot layer it must be
// equivalent to a blank line — never a hard group fence and never a real slot.
const standaloneEmptyBlockLinePattern = /^\s*(?:[ \t]*>[ \t]*)*<br\s*\/?>\s*$/i

// A lone U+200B is HorseMD's sentinel for an empty task body (`- [ ] ​`,
// RS-50): GFM needs body content to keep the checkbox, but the item is empty
// (fuzz seed 34, where canonical spells the same item `- [ ] <br />`).
const isEmptyItemText = (text) => {
  const value = String(text || '')
    .replace(/<br\s*\/?>/gi, '')
    .replace(/[ \t\u200B]+/g, '')
  return value === ''
}

const taskState = (text) => {
  const match = String(text || '').match(/^\[([ xX])\]([ \t]+|$)/)
  return match ? match[1].toLowerCase() === 'x' ? 'checked' : 'unchecked' : 'plain'
}

const pushLineSlots = (slots, line) => {
  const leading = line.match(/^[ \t]*/)?.[0] || ''
  let remainder = line.slice(leading.length)
  const indent = leading.length

  while (true) {
    // HorseMD keeps an empty authored list item as a bare marker (`-` or
    // `1.`) while Crepe emits marker + `<br />`. Both are one real list slot;
    // requiring trailing whitespace here would make the integrity proof reject
    // a valid empty item during save/source switching.
    const bare = remainder.match(/^([-+*]|\d{1,9}[.)])$/)
    if (bare) {
      const ordered = /^\d/.test(bare[1])
      slots.push({
        kind: ordered ? 'ordered' : 'bullet',
        indent,
        number: ordered ? bare[1].slice(0, -1) : null,
        task: 'plain',
        empty: true
      })
      break
    }
    const match = remainder.match(markerPattern)
    if (!match) break
    const [, token, spacing, body] = match
    const ordered = /^\d/.test(token)
    const bodyText = body || ''
    const nested = !ordered && bodyText.match(
      /^([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/
    )

    if (nested) {
      // Authored `-   1. text` is parsed as an outer empty bullet containing a
      // nested ordered item. Crepe serializes that as two physical lines. Emit
      // the same two slots so the source/canonical proof is independent of
      // line wrapping and marker spelling.
      slots.push({ kind: 'bullet', indent, number: null, task: 'plain', empty: true })
      const nestedMatch = nested
      if (!nestedMatch) break
      slots.push({
        kind: /^\d/.test(nestedMatch[1]) ? 'ordered' : 'bullet',
        indent: indent + spacing.length,
        number: /^\d/.test(nestedMatch[1]) ? nestedMatch[1].slice(0, -1) : null,
        task: taskState(nestedMatch[3]),
        empty: isEmptyItemText(nestedMatch[3])
      })
      break
    }

    slots.push({
      kind: ordered ? 'ordered' : 'bullet',
      indent,
      number: ordered ? token.slice(0, -1) : null,
      task: taskState(bodyText),
      empty: isEmptyItemText(bodyText)
    })
    break
  }
}

// Column of the first non-blank character, with tabs to the next multiple of 4.
const leadingColumns = (line) => {
  let column = 0
  for (const char of line) {
    if (char === ' ') column += 1
    else if (char === '\t') column += 4 - (column % 4)
    else break
  }
  return column
}

// Content columns of the items a marker line opens, outermost first
// (`- a` → [2], `1.  a` → [4], `- 1. a` → [2, 5]); a run of 5+ spaces after
// the marker counts as one (CommonMark).
const listContentColumns = (line) => {
  const columns = []
  let column = leadingColumns(line)
  let rest = line.replace(/^[ \t]*/, '')
  while (true) {
    const bare = rest.match(/^([-+*]|\d{1,9}[.)])$/)
    if (bare) {
      columns.push(column + bare[1].length + 1)
      return columns
    }
    const match = rest.match(/^([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/)
    if (!match) return columns
    const spacing = match[2].length
    column += match[1].length + (spacing > 4 ? 1 : spacing)
    columns.push(column)
    rest = match[3]
  }
}

const fingerprint = (markdown) => {
  const groups = []
  let group = null
  let fence = null
  let crossedNonListLine = false
  // Content columns of the list items that are still open.
  const openItems = []
  // The previous line was top-level paragraph text or indented code.
  let interruptible = false
  // The previous line was paragraph text inside an open list item.
  let lazyItemText = false
  for (const rawLine of String(markdown || '').split(/\r?\n/)) {
    if (fence) {
      if (closesFence(rawLine, fence)) {
        fence = null
        interruptible = false
        lazyItemText = false
        group = null
        crossedNonListLine = true
      }
      continue
    }
    const openedFence = openingFence(rawLine)
    if (openedFence) {
      fence = openedFence
      lazyItemText = false
      group = null
      crossedNonListLine = true
      continue
    }
    if (standaloneEmptyBlockLinePattern.test(rawLine)) {
      interruptible = false
      lazyItemText = false
      continue
    }
    if (!rawLine.trim()) {
      interruptible = false
      lazyItemText = false
      continue
    }
    const column = leadingColumns(rawLine)
    const lineSlots = []
    pushLineSlots(lineSlots, rawLine)
    // Text right below an item's paragraph is a lazy continuation of that
    // item even when it is not indented (`2. a` / `more` / `3. b` is one list).
    const lazy = lazyItemText && !lineSlots.length && !/^ {0,3}(#{1,6}([ \t]|$)|>|`{3,}|~{3,})/.test(rawLine)
    if (!lazy) while (openItems.length && openItems[openItems.length - 1] > column) openItems.pop()
    const topLevel = openItems.length === 0
    // 4+ columns past the enclosing item (or the margin) is an indented code
    // block or paragraph text, never a list item: Yuque exports put `    - x`
    // after a blank line, which CommonMark reads as code and Crepe prints as
    // a fenced block.
    if (column - (openItems[openItems.length - 1] ?? 0) >= 4) {
      crossedNonListLine = true
      group = null
      if (topLevel) interruptible = true
      lazyItemText = lazy
      continue
    }
    // Right after a top-level paragraph or indented code line, the parser
    // starts a list only with `1.` or a non-empty bullet: `2. B` or a bare `-`
    // there is paragraph text (or a setext underline), not a list item.
    const first = lineSlots[0]
    const startsList = first && !(interruptible && (
      /^[ \t]*([-+*]|\d{1,9}[.)])[ \t]*$/.test(rawLine) ||
      (first.kind === 'ordered' && Number(first.number) !== 1)
    ))
    if (startsList) {
      openItems.push(...listContentColumns(rawLine))
      if (!group || crossedNonListLine) {
        group = []
        groups.push(group)
      }
      group.push(...lineSlots)
      crossedNonListLine = false
      interruptible = false
      lazyItemText = !/^[ \t]*([-+*]|\d{1,9}[.)])[ \t]*$/.test(rawLine)
    } else if (lazy) {
      // Continuation text of the item's paragraph (`3. a  ` / `more` /
      // `4. b`) does not separate the items: Crepe may print the same
      // paragraph on one line (Yuque puts the break inside `<font>`).
    } else {
      // A non-empty ordinary line is a hard fence: a list before it and a
      // list after it are separate structural regions even when the parser
      // later normalizes whitespace. Blank lines belong to the current block.
      crossedNonListLine = true
      group = null
      if (topLevel) interruptible = !/^ {0,3}(#{1,6}([ \t]|$)|>)/.test(rawLine)
      lazyItemText = !topLevel && !/^ {0,3}(#{1,6}([ \t]|$)|>)/.test(rawLine)
    }
  }
  return groups.map((slots) => {
    const indentLevels = [...new Set(slots.map((slot) => slot.indent))]
    return slots.map((slot) => ({
      ...slot,
      // Absolute indentation differs between Crepe's wrapper lines and
      // authored Markdown (`-   1.` versus `  1.`). Preserve the relative
      // nesting level instead of raw spaces so equivalent wrapping compares
      // equal while a flattened or unexpectedly nested item fails closed.
      depth: indentLevels.indexOf(slot.indent)
    }))
  })
}

const groupSignature = (group) => JSON.stringify(group.map(({ kind, number, task, empty, depth }) => ({ kind, number, task, empty, depth })))

const changedGroupIndexes = (previousMarkdown, nextGroups) => {
  if (typeof previousMarkdown !== 'string') {
    return new Set(nextGroups.map((_, index) => index))
  }
  const previousGroups = fingerprint(previousMarkdown)
  let prefix = 0
  while (
    prefix < previousGroups.length &&
    prefix < nextGroups.length &&
    groupSignature(previousGroups[prefix]) === groupSignature(nextGroups[prefix])
  ) prefix += 1
  let suffix = 0
  while (
    suffix < previousGroups.length - prefix &&
    suffix < nextGroups.length - prefix &&
    groupSignature(previousGroups[previousGroups.length - 1 - suffix]) ===
      groupSignature(nextGroups[nextGroups.length - 1 - suffix])
  ) suffix += 1
  return new Set(
    Array.from({ length: Math.max(0, nextGroups.length - prefix - suffix) }, (_, index) =>
      prefix + index
    )
  )
}

const sameSlot = (left, right, strictOrderedNumbers, strictNesting) =>
  left.kind === right.kind &&
  (!strictNesting || left.depth === right.depth) &&
  left.task === right.task &&
  left.empty === right.empty &&
  (!strictOrderedNumbers || left.kind !== 'ordered' || left.number === right.number)

const comparableGroup = (group, { strictOrderedNumbers = false, strictNesting = false } = {}) =>
  (group || []).map((slot) => ({
    kind: slot.kind,
    ...(strictNesting ? { depth: slot.depth } : {}),
    task: slot.task,
    empty: slot.empty,
    ...(strictOrderedNumbers && slot.kind === 'ordered' ? { number: slot.number } : {})
  }))

const listSlotTransition = (beforeMarkdown, afterMarkdown, options = {}) => {
  const before = fingerprint(beforeMarkdown)
  const after = fingerprint(afterMarkdown)
  let prefix = 0
  while (
    prefix < before.length &&
    prefix < after.length &&
    groupSignature(before[prefix]) === groupSignature(after[prefix])
  ) prefix += 1
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    groupSignature(before[before.length - 1 - suffix]) ===
      groupSignature(after[after.length - 1 - suffix])
  ) suffix += 1
  return {
    // The old source/canonical pair is already trusted by the caller. Crepe may
    // have renumbered an ordered list across reopen (`1.` authored versus `3.`
    // canonical), so the removed/replaced OLD slots prove count/kind/nesting/
    // task/emptiness but not their normalized ordered number. Newly produced
    // slots stay fully strict, which still rejects wrong numbering or nesting.
    before: before
      .slice(prefix, before.length - suffix)
      .map((group) => comparableGroup(group, { ...options, strictOrderedNumbers: false })),
    after: after
      .slice(prefix, after.length - suffix)
      .map((group) => comparableGroup(group, options))
  }
}

// A trusted authored/canonical baseline can already have a different absolute
// list-group count. For a later local edit, compare the slot transition on each
// side instead of reusing canonical group indexes against the authored file.
// This remains strict about the fields requested by the caller and is only a
// transition primitive; the UI integrity gate decides whether the old pair is
// trusted enough to use it.
export const areMarkdownListSlotTransitionsEquivalent = (
  beforeLeft,
  afterLeft,
  beforeRight,
  afterRight,
  options = {}
) => JSON.stringify(listSlotTransition(beforeLeft, afterLeft, options)) ===
  JSON.stringify(listSlotTransition(beforeRight, afterRight, options))

export const markdownListSlotFingerprint = (markdown) => fingerprint(markdown)

export const areMarkdownListSlotsEquivalent = (
  left,
  right,
  {
    strictOrderedNumbers = false,
    strictNesting = false,
    previousMarkdown = null
  } = {}
) => {
  const a = fingerprint(left)
  const b = fingerprint(right)
  const groupsToCheck = changedGroupIndexes(previousMarkdown, b)
  if (previousMarkdown == null && a.length !== b.length) {
    if (Array.isArray(globalThis.__hmSourceIntegrityDiffTrace)) {
      globalThis.__hmSourceIntegrityDiffTrace.push({
        kind: 'list-slot-group-count',
        left: a,
        right: b
      })
    }
    return false
  }
  for (const groupIndex of groupsToCheck) {
    const leftGroup = a[groupIndex]
    const rightGroup = b[groupIndex]
    if (!leftGroup || !rightGroup) {
      if (Array.isArray(globalThis.__hmSourceIntegrityDiffTrace)) {
        globalThis.__hmSourceIntegrityDiffTrace.push({
          kind: 'list-slot-group-missing',
          groupIndex,
          left: leftGroup || null,
          right: rightGroup || null,
          leftAll: a,
          rightAll: b
        })
      }
      return false
    }
    if (leftGroup.length !== rightGroup.length) {
      if (Array.isArray(globalThis.__hmSourceIntegrityDiffTrace)) {
        globalThis.__hmSourceIntegrityDiffTrace.push({
          kind: 'list-slot-count',
          groupIndex,
          left: leftGroup,
          right: rightGroup,
          leftAll: a,
          rightAll: b
        })
      }
      return false
    }
    for (let index = 0; index < leftGroup.length; index += 1) {
      if (!sameSlot(leftGroup[index], rightGroup[index], strictOrderedNumbers, strictNesting)) {
        if (Array.isArray(globalThis.__hmSourceIntegrityDiffTrace)) {
          globalThis.__hmSourceIntegrityDiffTrace.push({
            kind: 'list-slot',
            groupIndex,
            index,
            left: leftGroup[index],
            right: rightGroup[index],
            leftAll: a,
            rightAll: b
          })
        }
        return false
      }
    }
  }
  return true
}
