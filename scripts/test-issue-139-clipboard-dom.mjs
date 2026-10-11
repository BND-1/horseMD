import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const family = process.env.CLIPBOARD_FAMILY || 'all'
const root = await mkdtemp(join(tmpdir(), 'horsemd-139-dom-'))
const file = join(root, 'fixture.md')
await writeFile(file, '# Clipboard regression\n\nIsolated fixture.\n')
const bundle = await build({
  stdin: { contents: `export * from './src/renderer/src/components/editor-copy.js'; export * from './src/renderer/src/components/editor-web-paste.js'`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'iife', globalName: 'clipboard139', platform: 'browser'
})
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), cleanProfile: false,
  port: 34000 + process.pid % 1000, appArgs: [file, '--horsemd-input-trace']
})
try {
  await app.evaluate(bundle.outputFiles[0].text)
  const result = await app.evaluate(`(() => {
    const failures = [], passed = []
    const check = (name, fn) => { try { fn(); passed.push(name) } catch (e) { failures.push({name, error:String(e)}) } }
    const equal = (a,b) => { if(a!==b) throw new Error(JSON.stringify({actual:a,expected:b})) }
    const yes = (a) => { if(!a) throw new Error('assertion failed') }
    const make = html => { const root=document.createElement('div'); root.innerHTML=html; return root }
    const text = html => clipboard139.copiedPlainText(make(html), 'FALLBACK')
    const styled = html => {const r=make(html); clipboard139.materializeCopiedSoftBreaks(r); clipboard139.inlineRichStyles(r); return r}
    if (${JSON.stringify(family)} === 'all' || ${JSON.stringify(family)} === 'plain') {
      check('mixed ordinary paragraph retains br', () => yes(text('<p>BODY_A<br>BODY_B</p><ul><li>ITEM</li></ul>').includes('BODY_A\\nBODY_B')))
      check('list hard break retained', () => yes(text('<ul><li>A<br>B</li></ul>').includes('A\\nB')))
      check('consecutive explicit breaks retained', () => yes(text('<ul><li>A<br><br>B</li></ul>').includes('A\\n\\nB')))
      check('selected prefix and suffix retained', () => {const t=text('PREFIX<ul><li>X<br>Y</li></ul>SUFFIX');yes(t.startsWith('PREFIX'));yes(t.endsWith('SUFFIX'))})
      check('nested order and numbering', () => {const t=text('<ol start="4"><li>A<ul><li>N<br>M</li></ul>Z</li><li value="8">B</li></ol>');yes(t.includes('4. A'));yes(t.includes('8. B'));yes(t.indexOf('N')<t.indexOf('Z'));yes(t.includes('N\\nM'))})
      check('table and list selection preserves cell breaks', () => yes(text('<table><tr><td>A<br>B</td><td>C</td></tr></table><ul><li>X</li></ul>').includes('A\\nB')))
      check('preformatted code with list preserves empty line', () => yes(text('<pre>A\\n\\n  B</pre><ul><li>X</li></ul>').includes('A\\n\\n  B')))
      check('source DOM remains untouched', () => {const r=make('<ul><li>A<br>B</li></ul>'),old=r.innerHTML;clipboard139.copiedPlainText(r);equal(r.innerHTML,old)})
      check('non-list selection still uses original fallback', () => equal(text('<strong>A</strong>'),'FALLBACK'))
    }
    if (${JSON.stringify(family)} === 'all' || ${JSON.stringify(family)} === 'list-html') {
      check('only first list paragraph unwrapped', () => {const r=styled('<ol><li><p><strong>A</strong></p><p>B</p></li></ol>'),li=r.querySelector('li');yes(li.firstElementChild.tagName==='STRONG');equal(li.querySelector('p')?.textContent,'B');yes(clipboard139.copiedPlainText(r).includes('A\\n'))})
      check('code and quote blocks not flattened', () => {const r=styled('<ul><li><p>A</p><pre><code>X\\nY</code></pre><blockquote><p>Q</p></blockquote></li></ul>');equal(r.querySelector('pre code')?.textContent,'X\\nY');yes(r.querySelector('blockquote'))})
      check('nested lists and continuation order retained', () => {const r=styled('<ul><li><p>A</p><ul><li><p>N</p></li></ul><p>Z</p></li></ul>');equal(r.querySelectorAll('ul').length,2);yes(r.querySelector('li > p')?.textContent==='Z')})
      check('no duplicate or separate first marker', () => {const r=styled('<ol><li><span>1.</span><div><div data-content-dom><p>A<br>B</p></div></div></li></ol>');yes(!r.querySelector('li > p'));yes(!r.textContent.includes('1.'));yes(r.querySelector('br'))})
    }
    if (${JSON.stringify(family)} === 'all' || ${JSON.stringify(family)} === 'paste') {
      for(const tag of ['p','span','div']) for(const ws of ['pre-wrap','pre-line','pre','break-spaces']) {
        check('paste '+tag+' '+ws, () => {const html='<'+tag+' style="white-space:'+ws+'"><strong>A</strong>\\r\\nB</'+tag+'>';const r=make(clipboard139.normalizeWebPasteHtml(html));equal(r.querySelectorAll('br').length,1);equal(r.querySelector('strong')?.textContent,'A')})
      }
      check('inherited whitespace with descendant reset', () => {const r=make(clipboard139.normalizeWebPasteHtml('<div style="white-space:pre-wrap"><span>A\\nB</span><span style="white-space:normal">C\\nD</span><span style="white-space:nowrap">E\\nF</span></div>'));equal(r.querySelectorAll('br').length,1)})
      check('initial resets but unset inherits', () => {const r=make(clipboard139.normalizeWebPasteHtml('<div style="white-space:pre-wrap"><span style="white-space:initial">A\\nB</span><span style="white-space:unset">C\\nD</span></div>'));equal(r.querySelectorAll('br').length,1)})
      check('ordinary HTML indentation not a visible line break', () => {const r=make(clipboard139.normalizeWebPasteHtml('<p>A\\nB</p>\\n<ul>\\n<li>C</li>\\n</ul>'));equal(r.querySelectorAll('br').length,0)})
      check('pre/code left to their existing parser', () => {const r=make(clipboard139.normalizeWebPasteHtml('<pre style="white-space:pre-wrap"><code>A\\nB</code></pre>'));equal(r.querySelectorAll('br').length,0);equal(r.querySelector('code').textContent,'A\\nB')})
      check('existing br not doubled and consecutive newlines preserved', () => {const r=make(clipboard139.normalizeWebPasteHtml('<p style="white-space:pre-line">A<br>B\\n\\nC</p>'));equal(r.querySelectorAll('br').length,3)})
      check('links tables and inline code retained', () => {const r=make(clipboard139.normalizeWebPasteHtml('<table><tr><td style="white-space:pre-wrap"><a href="https://example.com">A</a>\\nB<code>X</code></td></tr></table>'));equal(r.querySelectorAll('br').length,1);yes(r.querySelector('td a'));yes(r.querySelector('code'))})
      check('PM internal slice remains untouched', () => {const html='<p data-pm-slice="0 0 []" style="white-space:pre-wrap">A\\nB</p>';equal(clipboard139.normalizeWebPasteHtml(html),html)})
      check('normal reset and style/script text not materialized', () => {const r=make(clipboard139.normalizeWebPasteHtml('<div style="white-space:pre-wrap"><style>a\\nb</style><script>let a=1;\\nlet b=2</script><span style="white-space:normal">A\\nB</span></div>'));equal(r.querySelectorAll('br').length,0)})
      check('idempotent normalization', () => {const once=clipboard139.normalizeWebPasteHtml('<p style="white-space:pre-wrap">A\\nB</p>');equal(clipboard139.normalizeWebPasteHtml(once),once)})
    }
    return {passed,failures}
  })()`)
  await writeFile(join(root, 'result.json'), JSON.stringify({family,...result}, null, 2))
  console.log(JSON.stringify({family,...result,root}, null, 2))
  assert.equal(result.failures.length, 0, `${family}: ${result.failures.length} clipboard regression(s)`)
} finally {
  await stopBuiltElectron(app)
  console.log('Evidence:', root)
}
