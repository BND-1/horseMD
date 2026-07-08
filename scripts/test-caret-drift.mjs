// CDP: probe caret drift across rich↔source switch for many caret positions.
// For each anchor string: place rich caret right after it, capture context,
// toggle source, read source context, toggle back, read rich context again.
// Report where caret drifts (source/rich context != original).
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl)
const pending = new Map(); let id = 0
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
await new Promise(r => ws.onopen = r)
const send = (m, p) => new Promise(res => { const c = ++id; pending.set(c, res); ws.send(JSON.stringify({ id: c, method: m, params: p })) })
await send('Runtime.enable')
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description?.slice(0, 300) }; return r.result?.result?.value }
const sleep = ms => new Promise(r => setTimeout(r, ms))

await ev(`(() => { const t = [...document.querySelectorAll('.tab')].find(x => x.textContent.includes('hmcaret-doc')); if (t) t.click(); return true })()`)
await sleep(800)

// Place the rich caret immediately AFTER the first occurrence of `anchor` text.
const setRichCaretAfter = async (anchor) => ev(`((anchor) => {
  const pms = [...document.querySelectorAll('.ProseMirror')];
  const vis = pms.find(p => p.offsetParent !== null && p.getBoundingClientRect().width > 50) || pms[0];
  if (!vis) return { err: 'no pm' };
  vis.focus();
  const walker = document.createTreeWalker(vis, NodeFilter.SHOW_TEXT);
  let n, found = null;
  while (n = walker.nextNode()) {
    const i = n.nodeValue.indexOf(anchor);
    if (i >= 0) { found = { node: n, off: i + anchor.length }; break; }
  }
  if (!found) return { err: 'anchor not found: ' + anchor };
  const r = document.createRange(); r.setStart(found.node, found.off); r.collapse(true);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  // dispatch a selectionchange-ish so ProseMirror picks up the DOM selection
  vis.dispatchEvent(new Event('selectionchange', { bubbles: true }));
  return true;
})(${JSON.stringify(anchor)})`)

const richCtx = async () => ev(`(() => {
  const sel = window.getSelection(); if (!sel.rangeCount) return { err: 'no sel' };
  const n = sel.anchorNode, off = sel.anchorOffset;
  if (n.nodeType !== 3) return { err: 'not text', tp: n.nodeName };
  const v = n.nodeValue;
  return { before: v.slice(Math.max(0, off - 12), off), after: v.slice(off, off + 12) };
})()`)

const srcCtx = async () => ev(`(() => {
  const ta = document.querySelector('.source-editor'); if (!ta) return { err: 'no ta' };
  const s = ta.selectionStart;
  return { before: ta.value.slice(Math.max(0, s - 12), s), after: ta.value.slice(s, s + 12) };
})()`)

const toggle = async () => { await ev(`(() => { const b = [...document.querySelectorAll('.status-btn')].find(x => x.title && x.title.includes('Ctrl+/')); if (b) b.click(); return true })()`); await sleep(900) }

const ANCHORS = [
  '包含一个链接',      // prose w/ a markdown link nearby
  '投资有风险',        // pure prose, 2nd paragraph
  'hello world',       // inside a code block
  '列表第二项',        // inside a list item
  '结尾文字',          // last paragraph
  '一级标题',          // a heading
]

const results = []
for (const a of ANCHORS) {
  // ensure rich mode
  const inSrc = await ev(`!!document.querySelector('.source-editor')`)
  if (inSrc) await toggle()
  const set = await setRichCaretAfter(a)
  if (set?.err) { results.push({ anchor: a, skip: set.err }); continue }
  await sleep(150)
  const r1 = await richCtx()
  await toggle()                                   // rich → source
  const s1 = await srcCtx()
  await toggle()                                   // source → rich
  const r2 = await richCtx()
  // drift = rich caret moved? (r1.before !== r2.before) and source landed near anchor?
  const srcNearAnchor = s1.after?.includes(a.slice(0, 2)) || s1.before?.includes(a.slice(-2)) || JSON.stringify(s1).includes(a.slice(-3))
  results.push({ anchor: a, richBefore: r1.before, richAfter: r1.after, srcBefore: s1.before, srcAfter: s1.after, richBefore2: r2.before, richRoundtripOK: r1.before === r2.before && r1.after === r2.after, srcHasAnchor: srcNearAnchor })
}
console.log(JSON.stringify(results, null, 2))
ws.close(); process.exit(0)
