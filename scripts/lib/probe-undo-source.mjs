import { open, sleep } from './probe-session.mjs'
const content = '# T\n\nalpha para\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nomega para\n'
const s = await open('undo-src', content)
const { app } = s
const btn = () => app.evaluate(`(() => { const b=[...document.querySelectorAll('.status-btn')].find(n=>n.offsetParent && /源码|Source/.test(n.title||'')); b?.click() })()`)
const area = `[...document.querySelectorAll('textarea.source-editor')].find(n=>n.offsetParent)`
try {
  await s.clickText('alpha para')
  await s.type(' r1')
  await sleep(400)
  await btn(); for (let i=0;i<40 && !(await app.evaluate(`Boolean(${area})`));i++) await sleep(100)
  await sleep(300)
  await app.evaluate(`(() => { const a=${area}; const off=a.value.indexOf('omega para')+10; a.focus(); a.setSelectionRange(off,off); a.__horsemdSourceSelectionUser=true })()`)
  for (const ch of ' src') { await app.send('Input.insertText', { text: ch }); await sleep(40) }
  await sleep(500)
  await btn(); for (let i=0;i<40 && (await app.evaluate(`Boolean(${area})`));i++) await sleep(100)
  await sleep(600)
  await s.clickText('alpha para')
  await s.key('z', { modifiers: process.platform === 'darwin' ? 4 : 2 })
  await sleep(400)
  console.log('after undo doc text:', await app.evaluate(`[...document.querySelectorAll('.ProseMirror')].find(n=>n.offsetParent).innerText`))
  await s.clickText('1', 1)
  await s.type('x')
  await sleep(800)
  console.log('roundtrip source:', JSON.stringify(await s.source()))
  console.log('toasts', await s.toasts(), 'paused', await s.paused())
  console.log(await s.trace(`(globalThis.__hmSourceSyncCoordinatorTrace||[]).slice(-6)`))
} finally { await s.close() }
