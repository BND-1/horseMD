// Interactive probe session for reproducing rich/source sync bugs found by
// scripts/fuzz-rich-source-ui.mjs (see docs/rich-source-fuzzing.md).
//
//   import { open, sleep } from '../scripts/lib/probe-session.mjs'
//   const p = await open('name', '> quote **bold**\n')   // default: fuzz fixture
//   await p.clickText('bold', 2); await p.type('x'); await sleep(900)
//   console.log(await p.paused(), await p.source())        // warning? exact source
//   console.log(await p.trace('globalThis.__hmSourceSyncCoordinatorTrace'))
//   await p.close()
//
// Run from the repo root (launchBuiltElectron uses out/ relative to cwd);
// `npm run build` first. The app is launched with --horsemd-input-trace so
// every __hm*Trace array exists. Any app already listening on the port is
// killed first (a crashed probe otherwise leaves one holding it).
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { launchBuiltElectron, stopBuiltElectron } from './electron-test-app.mjs'
import { sleep } from './cdp.mjs'
import { pressKey } from './human-input.mjs'
export { sleep, pressKey }
export async function fixtureText() {
  const src = await readFile(new URL('../fuzz-rich-source-ui.mjs', import.meta.url), 'utf8')
  const m = src.match(/const DEFAULT_FIXTURE = \[([\s\S]*?)\]\.join/)
  return eval('[' + m[1] + ']').join('\n')
}
export async function open(name, content, port = 9994) {
  const dir = `/tmp/horsemd-fuzz/probe-${name}`
  await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true })
  try { const pids = execSync(`lsof -nP -t -iTCP:${port} -sTCP:LISTEN || true`).toString().trim(); if (pids) { execSync(`kill ${pids.split('\n').join(' ')}`); await sleep(800) } } catch {}
  const file = dir + '/doc.md'
  await writeFile(file, content ?? await fixtureText())
  const app = await launchBuiltElectron({ profileDir: dir + '/profile', port, appArgs: [file, '--horsemd-input-trace'] })
  await app.send('Runtime.enable')
  for (let i = 0; i < 60; i++) { if (await app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find(n=>n.offsetParent)?.pmViewDesc)`)) break; await sleep(150) }
  await sleep(500)
  await app.evaluate(`(() => { window.__toasts=[]; window.alert=(m)=>window.__toasts.push('ALERT '+m); const seen=new WeakSet(); new MutationObserver(()=>{ for (const n of document.querySelectorAll('.hm-toast-msg')) { if(!seen.has(n)){seen.add(n); window.__toasts.push(n.textContent)} } }).observe(document.body,{childList:true,subtree:true}) })()`)
  return {
    app, file,
    async clickText(text, offset = text.length, nth = 0) {
      const pt = await app.evaluate(`((text, offset, nth) => {
        const pm=[...document.querySelectorAll('.ProseMirror')].find(n=>n.offsetParent)
        const w=document.createTreeWalker(pm, NodeFilter.SHOW_TEXT); let k=0
        while (w.nextNode()) { const n=w.currentNode; const i=n.nodeValue.indexOf(text); if (i>=0) { if (k++<nth) continue; n.parentElement.scrollIntoView({block:'center'}); const r=document.createRange(); r.setStart(n, i+offset); r.collapse(true); const rc=r.getClientRects()[0]||n.parentElement.getBoundingClientRect(); return {x:Math.round(rc.left+1), y:Math.round(rc.top+rc.height/2)} } }
        return null })(${JSON.stringify(text)}, ${offset}, ${nth})`)
      if (!pt) throw new Error('text not found ' + text)
      await sleep(80)
      for (const type of ['mouseMoved','mousePressed','mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
      await sleep(120)
    },
    async type(text, delay = 30) { for (const ch of [...text]) { await app.send('Input.insertText', { text: ch }); await sleep(delay) } },
    async ime(text) { for (const ch of [...text]) { for (const p of ['p','pi','pin']) { await app.send('Input.imeSetComposition', { text: p, selectionStart: p.length, selectionEnd: p.length }); await sleep(20) } await app.send('Input.insertText', { text: ch }); await sleep(30) } },
    key: (key, opts = {}) => pressKey(app.send, { key, ...opts }),
    toasts: () => app.evaluate(`window.__toasts.slice()`),
    paused: async () => (await app.evaluate(`window.__toasts.slice()`)).some((x) => /不一致|无法安全/.test(x)),
    async source() {
      const b = () => app.evaluate(`(() => { const b=[...document.querySelectorAll('.status-btn')].find(n=>n.offsetParent && /源码|Source/.test(n.title||'')); b?.click() })()`)
      await b(); for (let i=0;i<40;i++){ await sleep(100); const v = await app.evaluate(`[...document.querySelectorAll('textarea.source-editor')].find(n=>n.offsetParent)?.value ?? null`); if (v!=null) { await b(); for (let j=0;j<40;j++){ await sleep(100); if (!(await app.evaluate(`Boolean([...document.querySelectorAll('textarea.source-editor')].find(n=>n.offsetParent))`))) break } return v } }
      return null
    },
    trace: (expr) => app.evaluate(`JSON.stringify(${expr})`),
    close: () => stopBuiltElectron(app, { removeProfile: true })
  }
}
