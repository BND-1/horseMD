// CDP test for #41: caret survives rich↔source mode switches (lands in the same
// heading section). Drives the StatusBar source toggle + sets the textarea caret
// precisely, then reads back the caret section in each mode via the DOM.
import { connectCdp, sleep } from './lib/cdp.mjs'

// ATX heading parse (mirror of parseSourceHeadings) for computing char ranges.
const HEAD_RE = /^(#{1,6})[ \t]+(.+)$/gm
function parseHeads(md) {
  const out = []; let m
  while ((m = HEAD_RE.exec(md)) !== null) out.push({ text: m[2].trim(), charOffset: m.index })
  HEAD_RE.lastIndex = 0
  return out
}

async function toggleSource(send, ev) {
  await ev(`(() => { const b=[...document.querySelectorAll('.status-btn')].find(x=>/源码|Source|Ctrl\\+\\/|⌘\\//.test(x.title || x.textContent || '')); if(b)b.click(); return !!b })()`)
}

async function main() {
  const { ws, send, evaluate: ev } = await connectCdp({ intervalMs: 500 })
  await send('Runtime.enable')
  const out = {}

  await ev(`(() => { const t=[...document.querySelectorAll('.tab')].find(x=>x.textContent.includes('caret-test')); if(t)t.click(); return true })()`)
  await sleep(700)

  // 1) Switch rich → source.
  await toggleSource(send, ev)
  await sleep(700)
  out.inSource = await ev(`!!document.querySelector('.source-editor')`)

  // 2) Place the textarea caret inside the Gamma section (mid-body of Gamma).
  const placed = await ev(`(() => {
    const ta = document.querySelector('.source-editor'); if (!ta) return { error: 'no textarea' }
    const md = ta.value
    const heads = []
    const re = /^(#{1,6})[ \\t]+(.+)$/gm; let m
    while ((m = re.exec(md)) !== null) heads.push({ text: m[2].trim(), charOffset: m.index })
    const gamma = heads.find(h => h.text === 'Gamma')
    const delta = heads.find(h => h.text === 'Delta')
    if (!gamma) return { error: 'no Gamma heading', heads: heads.map(h=>h.text) }
    // land ~60 chars into the Gamma section body
    const pos = Math.min(gamma.charOffset + 60, (delta ? delta.charOffset : md.length) - 1)
    ta.setSelectionRange(pos, pos)
    ta.focus()
    return { gammaOffset: gamma.charOffset, placedAt: pos, sectionStart: gamma.charOffset, sectionEnd: delta ? delta.charOffset : md.length }
  })()`)
  out.placedSourceCaret = placed

  // 3) Switch source → rich. Wait for the multi-pass caret restore (≤450ms + buffer).
  await toggleSource(send, ev)
  await sleep(900)
  out.inRich = await ev(`!!document.querySelector('.ProseMirror')`)
  // Read the caret's section in the rich editor (nearest heading at/above the caret).
  out.richCaretSection = await ev(`(() => {
    const sel = getSelection()
    if (!sel || !sel.rangeCount) return { error: 'no selection' }
    const r = sel.getRangeAt(0).cloneRange(); r.collapse(true)
    const cRect = r.getBoundingClientRect()
    const heads = [...document.querySelectorAll('.ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4,.ProseMirror h5,.ProseMirror h6')]
    if (!heads.length) return { error: 'no rich headings' }
    let section = null
    for (const h of heads) { if (h.getBoundingClientRect().top <= cRect.top + 3) section = h.textContent.trim(); else break }
    return { section, caretTop: Math.round(cRect.top) }
  })()`)

  // 4) Switch rich → source again; caret should come back into the Gamma section.
  await toggleSource(send, ev)
  await sleep(900)
  out.sourceCaretAfterRoundtrip = await ev(`(() => {
    const ta = document.querySelector('.source-editor'); if (!ta) return { error: 'no textarea' }
    const md = ta.value
    const heads = []
    const re = /^(#{1,6})[ \\t]+(.+)$/gm; let m
    while ((m = re.exec(md)) !== null) heads.push({ text: m[2].trim(), charOffset: m.index })
    const gamma = heads.find(h => h.text === 'Gamma')
    const delta = heads.find(h => h.text === 'Delta')
    const start = ta.selectionStart
    const inGamma = gamma && start >= gamma.charOffset && start < (delta ? delta.charOffset : md.length)
    return { selectionStart: start, gammaOffset: gamma && gamma.charOffset, deltaOffset: delta && delta.charOffset, inGamma }
  })()`)

  // Assertions
  out.A_sourceToRich = out.inRich && out.richCaretSection && out.richCaretSection.section === 'Gamma'
  out.B_richToSource = out.sourceCaretAfterRoundtrip && out.sourceCaretAfterRoundtrip.inGamma
  out.ALL_PASS = !!out.A_sourceToRich && !!out.B_richSource
  // (typo guard below — recompute cleanly)
  out.ALL_PASS = !!out.A_sourceToRich && !!out.B_richToSource
  console.log(JSON.stringify(out, null, 2))
  ws.close()
  process.exit(out.ALL_PASS ? 0 : 2)
}
main().catch((e) => { console.error('HARNESS ERROR:', e.message); process.exit(3) })
