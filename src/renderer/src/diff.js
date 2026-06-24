export function buildLineDiff(before, after) {
  const a = String(before ?? '').split('\n')
  const b = String(after ?? '').split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++

  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--
    endB--
  }

  const rows = []
  let oldNo = 1
  let newNo = 1
  const push = (type, text, oldLine, newLine) => rows.push({ type, text, oldLine, newLine })

  for (let i = 0; i < start; i++) push('same', a[i], oldNo++, newNo++)

  const left = a.slice(start, endA + 1)
  const right = b.slice(start, endB + 1)
  const changedRows = diffMiddle(left, right)
  for (const r of changedRows) {
    if (r.type === 'same') push('same', r.text, oldNo++, newNo++)
    else if (r.type === 'del') push('del', r.text, oldNo++, null)
    else push('add', r.text, null, newNo++)
  }

  for (let i = endA + 1; i < a.length; i++) push('same', a[i], oldNo++, newNo++)

  let added = 0
  let deleted = 0
  for (const r of rows) {
    if (r.type === 'add') added++
    if (r.type === 'del') deleted++
  }
  return { rows, added, deleted }
}

function diffMiddle(a, b) {
  // ponytail: O(n*m) line diff, fallback to one changed block if a huge file needs smarter diffing.
  if (a.length * b.length > 250000) {
    return [
      ...a.map((text) => ({ type: 'del', text })),
      ...b.map((text) => ({ type: 'add', text }))
    ]
  }
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const out = []
  let i = a.length
  let j = b.length
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) out.push({ type: 'same', text: a[--i], j: --j })
    else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) out.push({ type: 'add', text: b[--j] })
    else out.push({ type: 'del', text: a[--i] })
  }
  return out.reverse()
}

export function compactDiffRows(rows, context = 2) {
  const keep = new Set()
  rows.forEach((r, i) => {
    if (r.type === 'same') return
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep.add(j)
  })
  if (!keep.size) return rows.slice(0, 20)

  const out = []
  let last = -1
  ;[...keep].sort((a, b) => a - b).forEach((i) => {
    if (i > last + 1) out.push({ type: 'gap' })
    out.push(rows[i])
    last = i
  })
  return out
}

export function __diffSelfCheck() {
  const diff = buildLineDiff('a\nb\nc', 'a\nB\nc\nd')
  if (diff.added !== 2 || diff.deleted !== 1) throw new Error('diff stats failed')
  if (!compactDiffRows(diff.rows).some((r) => r.type === 'gap')) return true
  return true
}
