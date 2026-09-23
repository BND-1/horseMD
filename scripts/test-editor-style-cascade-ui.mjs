import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-style-cascade-'))
const file = join(root, 'fonts.md')
const source = [1, 2, 3, 4, 5, 6].map(level => '#'.repeat(level) + ' 标题 Heading ' + level).join('\n\n') +
  '\n\n正文 Body paragraph.\n\n| 甲 | 乙 |\n| --- | --- |\n| 一 | 二 |\n\n```js\nconst demo = 1\n```\n'
await writeFile(file, source)
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), cleanProfile: false,
  port: 28700 + process.pid % 250, appArgs: [file, '--horsemd-input-trace']
})
const editor = "[...document.querySelectorAll('.ProseMirror')].find(node => node.offsetParent)"
const waitFor = async (fn, label) => {
  for (let i = 0; i < 100; i++) { const result = await fn(); if (result) return result; await sleep(100) }
  throw new Error(label)
}
const ready = () => waitFor(() => app.evaluate(`(${editor})?.querySelectorAll('h1,h2,h3,h4,h5,h6').length === 6`), 'headings did not mount')
const readStyles = () => app.evaluate(`(() => {
  const e = ${editor}
  const styleOf = node => {
    const c = getComputedStyle(node)
    return {font:c.fontFamily, weight:c.fontWeight, size:c.fontSize, color:c.color, lineHeight:c.lineHeight}
  }
  const probe = document.createElement('span')
  probe.style.fontFamily = getComputedStyle(e).getPropertyValue('--font-write')
  e.parentElement.appendChild(probe)
  const expectedFont = getComputedStyle(probe).fontFamily
  probe.remove()
  return {
    expectedFont, body:styleOf(e.querySelector('p')),
    headings:[...e.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(styleOf),
    tableBackground:getComputedStyle(e.querySelector('table')).backgroundColor,
    sheetOrder:[...document.styleSheets].map(sheet => sheet.href || sheet.ownerNode.id),
    overrides:[...document.querySelectorAll('#hm-custom-theme,#hm-user-css')].map(n => ({id:n.id,css:n.textContent}))
  }
})()`)
const updateIsolatedSettings = async values => {
  const oldOrigin = await app.evaluate('performance.timeOrigin')
  await app.evaluate(`(() => {
    const settings = JSON.parse(localStorage.getItem('horsemd.settings.v1') || '{}')
    localStorage.setItem('horsemd.settings.v1', JSON.stringify({...settings,...${JSON.stringify(values)}}))
  })()`)
  await app.send('Page.reload')
  await waitFor(async () => {
    try { return await app.evaluate('performance.timeOrigin') !== oldOrigin } catch { return false }
  }, 'page did not finish reloading')
  await ready()
}
try {
  await ready()
  const baseline = await readStyles()
  await writeFile(join(root, 'baseline.json'), JSON.stringify(baseline, null, 2))
  console.log('BASELINE', JSON.stringify(baseline))
  assert.equal(baseline.body.font, baseline.expectedFont, 'body lost the app writing font to a late vendor stylesheet')
  for (const [index, heading] of baseline.headings.entries()) {
    assert.equal(heading.font, baseline.expectedFont, 'H' + (index + 1) + ' unexpectedly uses a serif/vendor font')
    assert.equal(heading.weight, index < 2 ? '700' : '600', 'heading lost HorseMD weight hierarchy')
  }
  assert.equal(baseline.headings[0].size, '36px', 'H1 lost relative size hierarchy')

  await updateIsolatedSettings({ fontWrite: 'Arial', fontSize: 20 })
  const configured = await readStyles()
  console.log('CONFIGURED', JSON.stringify(configured))
  assert.equal(configured.body.size, '20px', 'paragraph font size setting was overridden')
  for (const heading of configured.headings) assert.equal(heading.font, configured.expectedFont)
  assert.equal(configured.headings[0].size, '45px')

  // User-written overrides remain authoritative. Exercise the persisted snippet
  // path at boot, before the lazy rich editor has mounted.
  const css = '.milkdown .ProseMirror h1 {font-family: Georgia, serif; color: rgb(91, 23, 67);}' +
    '\n.milkdown .milkdown-table-block table {background-color: rgb(234, 217, 199);}'
  await updateIsolatedSettings({ userCssSnippets: [{id:'font-test',name:'Explicit font and table',enabled:true,css}] })
  const custom = await readStyles()
  assert.match(custom.headings[0].font, /Georgia/)
  assert.equal(custom.headings[0].color, 'rgb(91, 23, 67)')
  assert.equal(custom.headings[1].font, configured.expectedFont, 'H1 custom font contaminated H2')
  assert.equal(custom.tableBackground, 'rgb(234, 217, 199)')
  await app.evaluate(`(() => {
    const sheet = document.createElement('style')
    sheet.id = 'late-table-css-regression'
    sheet.textContent = '.milkdown .ProseMirror h1 {font-family: Times, serif; color: blue;}' +
      '.milkdown .milkdown-table-block table {background-color: blue;}'
    document.head.appendChild(sheet)
  })()`)
  await sleep(150)
  const late = await readStyles()
  assert.equal(late.headings[0].font, custom.headings[0].font)
  assert.equal(late.tableBackground, custom.tableBackground, 'late table stylesheet overrode user CSS')

  await updateIsolatedSettings({ userCssSnippets: [{id:'font-test',enabled:false,css}] })
  const disabled = await readStyles()
  for (const heading of disabled.headings) assert.equal(heading.font, configured.expectedFont)
  await app.evaluate(`(() => {
    [...document.querySelectorAll('.status-btn')].find(node => node.offsetParent && /源码|Source/.test(node.title || node.textContent))?.click()
  })()`)
  const raw = await waitFor(() => app.evaluate('[...document.querySelectorAll("textarea.source-editor")].find(n => n.offsetParent)?.value'), 'source mode missing')
  assert.equal(raw, source, 'style changes mutated Markdown')
  assert.equal(await readFile(file, 'utf8'), source, 'style changes wrote the document')
  await writeFile(join(root, 'verified.json'), JSON.stringify({baseline,configured,custom,late,disabled}, null, 2))
  console.log('PASS editor style cascade: six heading fonts/weights, body font, font settings, custom snippet boot/order/disable, source and disk unchanged')
} finally {
  await stopBuiltElectron(app)
  console.log('Evidence retained:', root)
}
