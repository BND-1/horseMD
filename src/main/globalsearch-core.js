// Pure workspace-search logic (issue #120: 全局搜索, space-separated terms =
// AND across files). No Electron, no fs — the IPC wrapper lives in
// globalsearch.js. Locked by scripts/test-global-search.mjs.
//
// Matching semantics are deliberately aligned with the in-document find
// backend (find.js `matchIndices`): case-insensitive, non-overlapping
// occurrences. `occIdx` returned per match is the 0-based index of that
// occurrence in a full-document matchIndices scan, so the renderer can land
// the FindBar on the EXACT clicked match in source/plain-text tabs
// (`runFind(term, occIdx)`). Rich tabs jump via the raw markdown offset
// (`restoreMarkdownOffset`) instead.

export const SEARCH_LIMITS = {
  maxTerms: 8, // ignore terms beyond this (pathological queries)
  maxFiles: 200, // files returned
  maxMatchesPerFile: 30, // result lines listed per file
  totalMatchCap: 1000, // hard cap across every file
  maxLineSnippet: 300, // display snippet length before windowing
  maxFileSize: 2 * 1024 * 1024 // skip files larger than 2 MB
}

// Split a raw query into search terms: whitespace-separated, deduplicated
// case-insensitively, capped. Empty/duplicate terms are dropped so "a  A b"
// searches for ["a", "b"].
export function parseSearchQuery(query) {
  if (typeof query !== 'string') return []
  const seen = new Set()
  const terms = []
  for (const raw of query.split(/\s+/)) {
    if (!raw) continue
    const lower = raw.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    terms.push(lower)
    if (terms.length >= SEARCH_LIMITS.maxTerms) break
  }
  return terms
}

// All non-overlapping case-insensitive occurrence starts of `term` in
// `contentLower` — byte-identical semantics to find.js matchIndices so the
// occurrence index computed here lands on the same match in the FindBar.
function occurrenceStarts(contentLower, term) {
  const starts = []
  let idx = contentLower.indexOf(term)
  while (idx !== -1) {
    starts.push(idx)
    idx = contentLower.indexOf(term, idx + term.length)
  }
  return starts
}

// Physical lines of a document with their absolute offsets. Handles LF, CRLF
// and lone CR; `end` excludes the line terminator so a match can never start
// inside an EOL.
function physicalLines(content) {
  const lines = []
  let start = 0
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]
    if (ch === '\n' || ch === '\r') {
      lines.push({ start, end: i, number: lines.length + 1 })
      if (ch === '\r' && content[i + 1] === '\n') i += 1
      start = i + 1
    }
  }
  lines.push({ start, end: content.length, number: lines.length + 1 })
  return lines
}

// Build the display snippet for a matched line: trim leading indentation, and
// when the line is very long window it around the first match (with ellipses).
// Returned ranges are positions into the returned snippet, clipped.
function buildSnippet(lineText, ranges) {
  const indent = lineText.length - lineText.trimStart().length
  let text = lineText.slice(indent)
  let shift = indent
  const clipped = ranges.map((range) => ({
    start: Math.max(0, range.start - shift),
    end: Math.max(0, range.end - shift)
  }))
  if (text.length > SEARCH_LIMITS.maxLineSnippet) {
    const first = clipped[0]?.start ?? 0
    const windowStart = Math.min(
      Math.max(first - 40, 0),
      Math.max(text.length - SEARCH_LIMITS.maxLineSnippet, 0)
    )
    const windowEnd = Math.min(windowStart + SEARCH_LIMITS.maxLineSnippet, text.length)
    const leading = windowStart > 0 ? '…' : ''
    const trailing = windowEnd < text.length ? '…' : ''
    text = leading + text.slice(windowStart, windowEnd) + trailing
    const offset = leading.length - windowStart
    for (const range of clipped) {
      range.start = Math.max(leading.length, Math.min(range.start + offset, text.length - trailing.length))
      range.end = Math.max(range.start, Math.min(range.end + offset, text.length - trailing.length))
    }
  }
  // Drop zero-width ranges produced by clipping.
  return { text, ranges: clipped.filter((range) => range.end > range.start) }
}

// Search one file's content. A file qualifies only when EVERY term occurs at
// least once (AND semantics, the issue's space-separated multi-term query).
// Listed lines are the ones containing any term; every term occurrence on a
// listed line is highlighted. Lines dropped by the per-file cap still advance
// nothing — occIdx comes from the whole-document occurrence list, so the
// FindBar index stays exact even for late matches.
export function searchContent(content, terms, limits = SEARCH_LIMITS) {
  if (!content || !terms.length) return { matched: false, matches: [], matchTotal: 0 }
  if (content.length > limits.maxFileSize) return { matched: false, matches: [], matchTotal: 0 }

  const contentLower = content.toLowerCase()
  const termStarts = terms.map((term) => occurrenceStarts(contentLower, term))
  if (termStarts.some((starts) => starts.length === 0)) {
    return { matched: false, matches: [], matchTotal: 0 }
  }

  const lines = physicalLines(content)
  const matches = []
  let matchTotal = 0
  let truncated = false
  for (const line of lines) {
    if (line.end < line.start) continue // empty line
    // Occurrences of every term inside this line (start offsets relative to
    // the line, absolute for occIdx/fileOffset).
    const occurrences = []
    for (let t = 0; t < terms.length; t += 1) {
      for (const abs of termStarts[t]) {
        if (abs >= line.start && abs < line.end) {
          occurrences.push({ term: terms[t], abs, termIndex: t, occIdx: -1 })
        }
      }
    }
    if (!occurrences.length) continue
    matchTotal += occurrences.length
    if (matchTotal > limits.totalMatchCap) {
      truncated = true
      matchTotal = limits.totalMatchCap
      break
    }
    if (matches.length >= limits.maxMatchesPerFile) {
      truncated = true
      continue
    }
    occurrences.sort((a, b) => a.abs - b.abs)
    // occIdx: index of this occurrence within the term's whole-document list.
    for (const occ of occurrences) {
      occ.occIdx = termStarts[occ.termIndex].indexOf(occ.abs)
    }
    const primary = occurrences[0]
    const { text, ranges } = buildSnippet(
      content.slice(line.start, line.end),
      occurrences.map((occ) => ({ start: occ.abs - line.start, end: occ.abs - line.start + occ.term.length }))
    )
    matches.push({
      line: line.number,
      col: primary.abs - line.start + 1,
      term: primary.term,
      occIdx: primary.occIdx,
      fileOffset: primary.abs,
      text,
      ranges
    })
  }
  return { matched: true, matches, matchTotal, truncated }
}

// Search a scanned set of files (already read). `entries`:
// [{ path, name, rel, content }]. Result files keep the input order (the
// caller scans roots alphabetically) and are capped at limits.maxFiles.
export function searchFiles(entries, query, limits = SEARCH_LIMITS) {
  const terms = parseSearchQuery(query)
  if (!terms.length) return { terms, files: [], truncated: false, matchTotal: 0 }
  const files = []
  let truncated = false
  let matchTotal = 0
  for (const entry of entries) {
    if (files.length >= limits.maxFiles) {
      truncated = true
      break
    }
    const result = searchContent(entry.content, terms, limits)
    if (!result.matched) continue
    files.push({
      path: entry.path,
      name: entry.name,
      rel: entry.rel,
      matches: result.matches
    })
    matchTotal += result.matchTotal
    if (result.truncated) truncated = true
  }
  return { terms, files, truncated, matchTotal }
}
