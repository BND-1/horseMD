import { open, sleep, pressKey } from './probe-session.mjs'
const s = await open('raw-paste', 'Old heading\n\nOld body\n')
const { app } = s
const replacement = '# Raw heading\n\n- exact item\n'
try {
  await app.evaluate(`[...document.querySelectorAll('.ProseMirror')].find(n=>n.offsetParent).focus()`)
  await pressKey(app.send, { key: 'a', code: 'KeyA', modifiers: 4, delayMs: 80 })
  await app.evaluate(`(() => { const e=[...document.querySelectorAll('.ProseMirror')].find(n=>n.offsetParent); const d=new DataTransfer(); d.setData('text/markdown', ${JSON.stringify(replacement)}); d.setData('text/plain', ${JSON.stringify(replacement)}); e.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d})) })()`)
  await sleep(900)
  console.log('source:', JSON.stringify(await s.source()))
  console.log('coord', await s.trace(`(globalThis.__hmSourceSyncCoordinatorTrace||[]).map(e=>[e.revision,e.phase,e.family,e.reason])`))
  console.log('journal', await s.trace(`(globalThis.__hmSourceSyncTransactionJournalTrace||[]).map(e=>[e.phase,e.reason,JSON.stringify(e.stepDetails||'').slice(0,200)])`))
  console.log('preserve', await s.trace(`(globalThis.__hmPreserveLog||[]).map(e=>[e.source,e.previous,e.next,e.markdown,e.reason])`))
  console.log('pm', await s.trace(`[...document.querySelectorAll('.ProseMirror')].find(n=>n.offsetParent).pmViewDesc.node.toJSON().content.map(n=>n.type)`))
} finally { await s.close() }
