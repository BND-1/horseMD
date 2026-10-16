import { open, sleep } from './probe-session.mjs'
const content = process.env.DOC ?? '# T\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n---\n\nfinal para.\n'
const s = await open('hr-type', content)
const { app } = s
try {
  await s.clickText(process.env.CLICK ?? '2')
  for (const k of (process.env.KEYS ?? 'ArrowDown,ArrowDown').split(',')) { await s.key(k); await sleep(150) }
  console.log("sel", await app.evaluate(`(() => { const pm=[...document.querySelectorAll(".ProseMirror")].find(n=>n.offsetParent); const sel=window.getSelection(); return [sel.anchorNode?.nodeName, sel.anchorNode?.textContent?.slice(0,20), document.querySelector(".ProseMirror-selectednode")?.nodeName] })()`))
  for (const part of (process.env.TYPE ?? 'beta').split('|')) { if (part.startsWith('key:')) { await s.key(part.slice(4)); await sleep(150) } else await s.type(part) }
  console.log('integrity', await s.trace(`(globalThis.__hmSourceIntegrityTrace||globalThis.__hmSourceSyncIntegrityTrace||[]).slice(-1).map(e=>({c:e.candidate,k:e.canonical,r:e.preservationReason}))`))
  console.log('coord', await s.trace(`(globalThis.__hmSourceSyncCoordinatorTrace||[])`))
  console.log('flush', await s.trace(`(globalThis.__hmFlushTrace||[])`))
  console.log('owner', await s.trace(`(globalThis.__hmTopLevelBlockRemovalTransactionTrace||[]).slice(-3)`))
  console.log('jr', await s.trace(`(globalThis.__hmSourceSyncTransactionJournalTrace||[]).map(e=>[e.phase,e.reason,JSON.stringify(e.blockers||''),JSON.stringify(e.stepDetails||'')])`))
  console.log('pm', await s.trace(`[...document.querySelectorAll('.ProseMirror')].find(n=>n.offsetParent).pmViewDesc.node.toJSON().content.map(n=>n.type+':'+JSON.stringify(n.content?.map(c=>c.text)||''))`))
  await sleep(800)
  console.log('source:', JSON.stringify(await s.source()))
  console.log('toasts', await s.toasts(), 'paused', await s.paused())
  console.log(await s.trace(`(globalThis.__hmSourceSyncCoordinatorTrace||[]).slice(-4)`))
  console.log(await s.trace(`(globalThis.__hmSourceSyncTransactionJournalTrace||[]).slice(-3).map(e=>({phase:e.phase,reason:e.reason,steps:e.stepDetails}))`))
} finally { await s.close() }
