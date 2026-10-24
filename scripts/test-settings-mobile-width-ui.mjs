// Settings on a phone (is-mobile, 390px): every page fits the screen (the
// sections column used to keep the desktop margin:auto and grow to 530px),
// and the typography preview pads its page on desktop.
import assert from 'node:assert/strict'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
const app = await launchBuiltElectron({ profileDir: `/tmp/horsemd-settings-mobile-${process.pid}`, port: Number(process.env.CDP_PORT || 9420 + (process.pid % 40)) })
try {
  await app.send('Runtime.enable'); await sleep(1500)
  await app.evaluate(`document.querySelector('.activity-item[title="设置"], .activity-item[title="Settings"]')?.click()`); await sleep(600)
  // Desktop: the typography preview pads its page (an editor rule zeroed it).
  await app.evaluate(`[...document.querySelectorAll('.settings-nav-item')].find(n => /外观|Appearance/.test(n.textContent))?.click()`); await sleep(400)
  const pad = await app.evaluate(`parseFloat(getComputedStyle(document.querySelector('.settings-preview .ProseMirror')).paddingLeft)`)
  assert.ok(pad >= 22, `preview left padding ${pad}px`)
  await app.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await app.evaluate(`document.querySelector('.app').classList.add('is-mobile')`); await sleep(500)
  const names = await app.evaluate(`[...document.querySelectorAll('.settings-nav-item')].map(n => n.textContent.trim())`)
  for (const name of names) {
    await app.evaluate(`[...document.querySelectorAll('.settings-nav-item')].find(n => n.textContent.trim() === ${JSON.stringify(name)}).click()`)
    await sleep(500)
    const r = await app.evaluate(`(() => {
      const W = document.documentElement.clientWidth
      const s = document.querySelector('.settings-sections')
      const out = []
      for (const n of s.querySelectorAll('*')) {
        const r = n.getBoundingClientRect()
        if (!r.width || r.right <= W + 1) continue
        // skip things inside their own horizontal scroller
        let p = n.parentElement, clipped = false
        while (p && p !== s) { const o = getComputedStyle(p).overflowX; if ((o === 'auto' || o === 'scroll' || o === 'hidden') && p.getBoundingClientRect().right <= W + 1) { clipped = true; break } p = p.parentElement }
        if (!clipped) out.push((n.className || n.tagName).toString().slice(0, 40) + '@' + Math.round(r.right))
      }
      return { sections: Math.round(s.getBoundingClientRect().width), out: out.slice(0, 6) }
    })()`)
    console.log(name, JSON.stringify(r))
    assert.equal(r.sections, 390, `${name}: settings column is wider than the phone`)
    assert.deepEqual(r.out, [], `${name}: elements past the right edge`)
  }
} finally { await stopBuiltElectron(app) }
console.log('PASS settings mobile width: every settings page fits a 390px phone; preview page padded')
