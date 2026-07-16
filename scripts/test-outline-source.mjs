// CDP test for #40: outline panel works in source mode (and matches rich mode).
// Launch app with a multi-heading doc on --remote-debugging-port=9222 first.
import { connectCdp, sleep } from './lib/cdp.mjs'
async function modsKey(send, key, code, vk, modifiers) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
}

async function main() {
  const { ws, send, evaluate: ev } = await connectCdp({ intervalMs: 500 })
  await send('Runtime.enable')
  const out = {}

  // Open the test doc tab.
  await ev(`(() => { const t=[...document.querySelectorAll('.tab')].find(x=>x.textContent.includes('outline-test')); if(t)t.click(); return true })()`)
  await sleep(600)
  // Open the outline sidebar (Ctrl+Shift+L). Retry if not visible.
  for (let i = 0; i < 3; i++) {
    const has = await ev(`document.querySelectorAll('.outline-item').length`)
    if (has) break
    await modsKey(send, 'L', 'KeyL', 76, 2 | 8) // Ctrl+Shift
    await sleep(350)
  }
  await sleep(400)

  // RICH outline baseline.
  out.richOutline = await ev(`(() => [...document.querySelectorAll('.outline-item')].map(e=>e.textContent.trim()))()`)
  // Toggle to source mode via the StatusBar button (its title always has
  // "Ctrl+/" — stable across locales; the Mod-/ menu accelerator can't be
  // triggered by CDP key events, which don't reach Electron's native menu).
  await ev(`(() => { const b=[...document.querySelectorAll('.status-btn')].find(x=>x.title && x.title.includes('Ctrl+/')); if(b)b.click(); return !!b })()`)
  await sleep(600)
  const modeCheck = await ev(`(() => ({ sourceEditor: !!document.querySelector('.source-editor') }))()`)
  out.afterToggle = modeCheck
  await sleep(400)

  // SOURCE outline.
  out.sourceOutline = await ev(`(() => [...document.querySelectorAll('.outline-item')].map(e=>e.textContent.trim()))()`)

  // Active heading + scroll state before click.
  const taInfo0 = await ev(`(() => {
    const ta = document.querySelector('.source-editor');
    return ta ? { scrollTop: ta.scrollTop, scrollable: ta.scrollHeight > ta.clientHeight + 4 } : null
  })()`)

  // Click the 3rd outline item (Gamma) — should scroll the textarea + set active.
  await ev(`(() => { const items=[...document.querySelectorAll('.outline-item')]; if(items[2]) items[2].click(); return items.length })()`)
  await sleep(450)
  const afterClick = await ev(`(() => {
    const ta = document.querySelector('.source-editor');
    const active = document.querySelector('.outline-item.active');
    return { scrollTop: ta ? ta.scrollTop : null, activeText: active ? active.textContent.trim() : null }
  })()`)

  out.clickGamma = {
    scrollable: taInfo0 && taInfo0.scrollable,
    scrollTopBefore: taInfo0 && taInfo0.scrollTop,
    scrollTopAfter: afterClick.scrollTop,
    activeAfterClick: afterClick.activeText,
  }

  // MATCH assertion: source outline has the same headings as rich.
  out.A_match = Array.isArray(out.richOutline) && Array.isArray(out.sourceOutline) &&
    out.richOutline.length === out.sourceOutline.length &&
    out.richOutline.every((h, i) => h === out.sourceOutline[i])
  // B: clicking Gamma set the active highlight to Gamma, AND scrolled the
  // textarea IF the doc is tall enough to scroll (short docs legitimately stay at 0).
  out.B_clickScroll = out.clickGamma.activeAfterClick === 'Gamma' &&
    (!out.clickGamma.scrollable || out.clickGamma.scrollTopAfter > (out.clickGamma.scrollTopBefore || 0))

  out.ALL_PASS = !!out.A_match && !!out.B_clickScroll && out.afterToggle.sourceEditor === true
  console.log(JSON.stringify(out, null, 2))
  ws.close()
  process.exit(out.ALL_PASS ? 0 : 2)
}
main().catch((e) => { console.error('HARNESS ERROR:', e.message); process.exit(3) })
