import { open, sleep } from './probe-session.mjs'
const content = process.env.DOC ?? '# T\n\nfirst para\n\nsecond `code` here\n'
const s = await open('lead-space', content)
const { app } = s
try {
  await s.clickText(process.env.CLICK ?? 'second', Number(process.env.OFF ?? 0))
  for (const part of (process.env.TYPE ?? 'key:Tab').split('|')) { if (part === 'wait') await sleep(900); else if (part.startsWith('key:')) { await s.key(part.slice(4)); await sleep(150) } else await s.type(part) }
  await sleep(800)
  console.log('pm', await s.trace(`[...document.querySelectorAll('.ProseMirror')].find(n=>n.offsetParent).pmViewDesc.node.toJSON().content.map(n=>n.type+':'+JSON.stringify(n.content?.map(c=>c.text||c.type)||''))`))
  console.log('codes', await s.trace(`[...[...document.querySelectorAll('.ProseMirror')].find(n=>n.offsetParent).pmViewDesc.node.child(2).textContent.slice(0,8)].map(c=>c.charCodeAt(0))`))
  console.log('integ', await s.trace(`(globalThis.__hmSourceIntegrityTrace||[]).map(e=>{const c={...e}; return c})`))
  console.log('preserve', await s.trace(`(globalThis.__hmPreserveLog||[]).map(e=>[e.previous,e.next,e.markdown,e.reason])`))
  console.log('cells', await s.trace(`(() => { const d=[...document.querySelectorAll('.ProseMirror')].find(n=>n.offsetParent).pmViewDesc.node; const out=[]; d.forEach(n=>{ if(n.type.name==='table') n.forEach(r=>{ const row=[]; r.forEach(c=>row.push(c.textContent+'|'+c.attrs.alignment)); out.push(row) }) }); return out })()`))
  console.log('jr', await s.trace(`(globalThis.__hmSourceSyncTransactionJournalTrace||[]).map(e=>[e.phase,e.reason,JSON.stringify(e.stepDetails)])`))
  console.log('tbl', await s.trace(`(globalThis.__hmTableTransactionTrace||[]).filter(e=>e.family==='table-cell-plain-text-replace').map(e=>[e.phase,e.reason,JSON.stringify(e.proof?.multiCellReason||'')])`))
  console.log('source:', JSON.stringify(await s.source()))
  console.log('toasts', await s.toasts())
  console.log('coord', await s.trace(`(globalThis.__hmSourceSyncCoordinatorTrace||[]).map(e=>[e.phase,e.family,e.reason])`))
} finally { await s.close() }
