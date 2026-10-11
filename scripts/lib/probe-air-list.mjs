// Replays the 2026-10-07 Air report: Enter at the end of item 3 of an ordered
// list, IME-commit a phrase, Backspace it away and once more on the empty item.
import { readFile } from 'node:fs/promises'
import { open, sleep } from './probe-session.mjs'
const scratch = '/private/tmp/claude-501/-Users-yangtingyi-macmini-vibe-the-wrold-horseMD/da3fdb75-779f-4c34-aca2-1aa16686fda8/scratchpad/air-doc.md'
const original = (await readFile(scratch, 'utf8')).replace('4. 数据给老\n5. 费用', '4. 费用').replace('6. 中标通知书', '5. 中标通知书')
const s = await open('air-list', original, 9991)
const { app } = s
try {
  await s.clickText('资信材料清单或最终资信文件；')
  await s.key('End'); await sleep(150)
  await s.key('Enter'); await sleep(450)
  for (const p of ['s', 'sj', 'sjg', 'sjgl', 'sjgls']) { await app.send('Input.imeSetComposition', { text: p, selectionStart: p.length, selectionEnd: p.length }); await sleep(100) }
  await app.send('Input.insertText', { text: '数据给老师' }); await sleep(500)
  for (let i = 0; i < Number(process.env.BACKSPACES ?? 6); i++) { await s.key('Backspace'); await sleep(200) }
  await sleep(1000)
  console.log('toasts', JSON.stringify(await s.toasts()))
  console.log('reprint', await s.trace(`(globalThis.__hmSourceReprintTrace||[]).slice(-8)`))
  console.log('coord', await s.trace(`(globalThis.__hmSourceSyncCoordinatorTrace||[]).slice(-6).map(e=>[e.phase,e.family,e.reason])`))
  console.log('pm item3', await s.trace(`(() => { const d=[...document.querySelectorAll('.ProseMirror')].find(n=>n.offsetParent).pmViewDesc.node; let out=null; d.forEach(n=>{ if(!out && n.type.name==='ordered_list') out=n.toJSON().content.map(i=>i.content.map(c=>c.type+':'+(c.content?.[0]?.text||''))) }); return out })()`))
  console.log('engine', await app.evaluate(`(() => { const h = globalThis.__hmSourceReprintHarness
    globalThis.__hmSourceIntegrityDiffTrace = []
    const out = h.reprint(h.liveSource(), h.liveDoc())
    return JSON.stringify({ ok: out.ok, verified: out.verified, notes: out.notes, md: (out.markdown||'').slice(80, 260), diff: globalThis.__hmSourceIntegrityDiffTrace.slice(-2) }) })()`))
  console.log('source', JSON.stringify(await s.source()))
} finally { await s.close() }
