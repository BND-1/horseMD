// Dump post-plugin mdast (with positions) and the parsed PM doc for a source.
import { open } from './probe-session.mjs'
const content = process.env.DOC ?? undefined
const s = await open('reprint-explore', content)
try {
  const out = await s.app.evaluate(`(() => {
    const h = globalThis.__hmSourceReprintHarness
    if (!h) return 'NO HARNESS'
    const src = h.liveSource()
    const r = h.remark()
    const tree = r.runSync(r.parse(src), src)
    const lines = []
    const walk = (n, d) => {
      const p = n.position ? n.position.start.offset + '-' + n.position.end.offset : 'nopos'
      const extra = n.value != null ? ' ' + JSON.stringify(String(n.value).slice(0, 40)) : ''
      lines.push('  '.repeat(d) + n.type + ' [' + p + ']' + extra + (n.ordered != null ? ' ordered=' + n.ordered : '') + (n.checked != null ? ' checked=' + n.checked : ''))
      for (const c of n.children || []) walk(c, d + 1)
    }
    walk(tree, 0)
    const pm = []
    const pwalk = (n, d) => { pm.push('  '.repeat(d) + n.type.name + (n.isText ? ' ' + JSON.stringify(n.text.slice(0,40)) + ' ' + n.marks.map(m=>m.type.name).join(',') : '') ); n.forEach(c => pwalk(c, d + 1)) }
    pwalk(h.parse(src), 0)
    return lines.join('\\n') + '\\n=====PM=====\\n' + pm.join('\\n')
  })()`)
  console.log(out)
} finally { await s.close() }
