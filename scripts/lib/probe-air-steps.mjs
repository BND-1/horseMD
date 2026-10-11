import { readFile } from 'node:fs/promises'
import { open, sleep } from './probe-session.mjs'
const scratch = '/private/tmp/claude-501/-Users-yangtingyi-macmini-vibe-the-wrold-horseMD/da3fdb75-779f-4c34-aca2-1aa16686fda8/scratchpad/air-doc.md'
const original = (await readFile(scratch, 'utf8')).replace('4. 数据给老\n5. 费用', '4. 费用').replace('6. 中标通知书', '5. 中标通知书')
const s = await open('air-steps', original, 9991)
const { app } = s
const check = async (label) => {
  const r = JSON.parse(await app.evaluate(`(() => { const h = globalThis.__hmSourceReprintHarness
    globalThis.__hmSourceIntegrityDiffTrace = []
    const out = h.reprint(h.liveSource(), h.liveDoc())
    const src = h.liveSource(); const i = src.indexOf('3. 资信')
    let item3 = null; h.liveDoc().forEach(n => { if (!item3 && n.type.name === 'ordered_list') item3 = n.child(2).toJSON().content.map(c => c.type + ':' + (c.content||[]).map(x => x.text || x.type).join('')) })
    return JSON.stringify({ ok: out.ok, v: out.verified, notes: (out.notes||[]).map(n=>n.level), committed: src.slice(i, i + 60), attempt: (out.markdown||'').slice(i, i+60), item3, diff: globalThis.__hmSourceIntegrityDiffTrace.slice(-1) }) })()`))
  console.log(label.padEnd(12), JSON.stringify(r).slice(0, 700))
}
try {
  await s.clickText('资信材料清单或最终资信文件；')
  await s.key('End'); await sleep(150)
  await s.key('Enter'); await sleep(450); await check('enter')
  for (const p of ['s', 'sj', 'sjg', 'sjgl', 'sjgls']) { await app.send('Input.imeSetComposition', { text: p, selectionStart: p.length, selectionEnd: p.length }); await sleep(100) }
  await app.send('Input.insertText', { text: '数据给老师' }); await sleep(500); await check('ime-commit')
  for (let i = 0; i < 6; i++) { await s.key('Backspace'); await sleep(180); await check('bksp' + (i + 1)) }
  await sleep(800); await check('settled')
  const airSource = await readFile(scratch, 'utf8')
  console.log('batch-jump', await app.evaluate(`((src) => { const h = globalThis.__hmSourceReprintHarness
    globalThis.__hmSourceIntegrityDiffTrace = []
    const out = h.reprint(src, h.liveDoc())
    const i = src.indexOf('3. 资信')
    return JSON.stringify({ ok: out.ok, v: out.verified, reason: out.reason, notes: out.notes, attempt: (out.markdown||'').slice(i, i + 120), diff: globalThis.__hmSourceIntegrityDiffTrace.slice(-2) }) })(${JSON.stringify(airSource)})`))
  console.log('toasts', JSON.stringify(await s.toasts()))
} finally { await s.close() }
