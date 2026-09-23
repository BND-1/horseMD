import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const family = process.env.CLIPBOARD_FAMILY || 'all'
const root = await mkdtemp(join(tmpdir(), 'horsemd-139-ui-'))
const executable = process.env.HORSEMD_APP_PATH || undefined
const editor = "[...document.querySelectorAll('.ProseMirror')].find(n=>n.offsetParent)"
const wait = async (fn, message) => {
  for (let i = 0; i < 100; i++) { const v = await fn(); if (v !== null && v !== false && v !== undefined) return v; await sleep(60) }
  throw new Error(message)
}
const open = async (file, id) => {
  const app = await launchBuiltElectron({ executable, entrypoint: executable ? null : undefined,
    profileDir: join(root, id), cleanProfile: false, port: 35000 + process.pid % 1000,
    appArgs: [file, '--horsemd-input-trace'] })
  try { await wait(() => app.evaluate(`(${editor})?.textContent.includes('AUDIT')`), 'fixture did not open'); return app }
  catch (error) { await stopBuiltElectron(app); throw error }
}
const select = async (app, token = null, end = false, reverse = false) => {
  assert.equal(await app.evaluate(`(() => {
    const e=${editor}, n=${token ? `[...e.querySelectorAll('p')].find(n=>n.textContent===${JSON.stringify(token)})` : 'e'}
    if(!n)return false; n.scrollIntoView({block:'center'}); e.focus()
    const r=document.createRange();r.selectNodeContents(n);if(${end})r.collapse(false)
    const s=getSelection();s.removeAllRanges();s.addRange(r)
    if(${reverse})s.setBaseAndExtent(r.endContainer,r.endOffset,r.startContainer,r.startOffset)
    document.dispatchEvent(new Event('selectionchange'));return true
  })()`), true)
  await sleep(150)
}
const modifier = process.platform === 'darwin' ? 4 : 2
const command = async (app, key, name) => {
  for (const type of ['rawKeyDown', 'keyUp']) await app.send('Input.dispatchKeyEvent', {
    type, key, code: 'Key' + key.toUpperCase(), modifiers: modifier,
    windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), commands: [name]
  })
}
const sourceView = async app => {
  assert.equal(await app.evaluate(`(() => {
    const b=[...document.querySelectorAll('.status-btn')].find(n=>n.offsetParent && (/富文本|Rich/.test(n.textContent)||/切换源码|Toggle source/.test(n.title)))
    b?.click();return !!b
  })()`), true, 'source button missing')
  return wait(() => app.evaluate('[...document.querySelectorAll("textarea.source-editor")].find(n=>n.offsetParent)?.value ?? null'), 'source view missing')
}
const inspect = app => app.evaluate(`(() => {
  const e=${editor};return {html:e.innerHTML, paragraphs:[...e.querySelectorAll('p')].map(n=>n.innerHTML),
    failures:(window.__hmSourceIntegrityTrace||[]).filter(n=>n.ok===false).map(n=>({reason:n.preservationReason,site:n.validationSite}))}
})()`)
const results = []
try {
  if (family !== 'paste') for (const eol of ['\n', '\r\n']) {
    const id = eol === '\n' ? 'copy-LF' : 'copy-CRLF', file = join(root, id + '.md')
    const source = ['# AUDIT', '', 'BODYLEFT', 'BODYRIGHT', '', '- SOFTLEFT', '  SOFTRIGHT', '',
      '- HARDLEFT\\', '  HARDRIGHT', '', '- PARAFIRST', '', '  PARASECOND', '', 'TAIL', ''].join(eol)
    await writeFile(file, source)
    const app = await open(file, id)
    try {
      await app.evaluate(`document.addEventListener('copy', e => { window.__copy139={plain:e.clipboardData.getData('text/plain'),html:e.clipboardData.getData('text/html'),markdown:e.clipboardData.getData('text/markdown')} })`)
      await select(app)
      await command(app, 'a', 'selectAll')
      await command(app, 'c', 'copy')
      const data = await wait(() => app.evaluate('window.__copy139 ?? null'), 'native copy event not received')
      for (const [a,b] of [['BODYLEFT','BODYRIGHT'],['SOFTLEFT','SOFTRIGHT'],['HARDLEFT','HARDRIGHT']]) {
        assert.ok(data.plain.includes(a + '\n' + b), `${id} lost ${a} line break: ${JSON.stringify(data.plain)}`)
      }
      assert.ok(data.html.includes('<br'))
      assert.ok(data.markdown.includes('SOFTLEFT\n'))
      if (family !== 'plain') {
        assert.ok(!data.html.includes('PARAFIRSTPARASECOND'), 'HTML merged list paragraphs')
        assert.ok(/PARAFIRST[\s\S]*<p[^>]*>PARASECOND/.test(data.html), 'continuation paragraph missing')
        assert.ok(/PARAFIRST\n+PARASECOND/.test(data.plain), 'plain list paragraph boundary missing')
      }
      // Partial reverse selection must remain text-only (no list marker added).
      await select(app, 'TAIL', false, true)
      await app.evaluate('window.__copy139=null')
      await command(app, 'c', 'copy')
      assert.equal((await wait(() => app.evaluate('window.__copy139'), 'partial copy missing')).plain, 'TAIL')
      assert.deepEqual((await inspect(app)).failures, [])
      assert.equal(await sourceView(app), source.replace(/\r\n/g, '\n'))
      assert.equal(await readFile(file, 'utf8'), source, 'copy modified disk')
      results.push({id,plain:data.plain,sourceUnchanged:true})
      console.log('PASS', id)
    } finally { await stopBuiltElectron(app) }
  }
  if (family === 'all' || family === 'paste') {
    const cases = [
      {id:'plain', plain:'LEFT\nRIGHT', expected:'LEFT\nRIGHT'},
      {id:'html-br', html:'<p>LEFT<br>RIGHT</p>', expected:'LEFT  \nRIGHT'},
      {id:'html-paragraphs', html:'<p>LEFT</p><p>RIGHT</p>', expected:'LEFT\n\nRIGHT'},
      {id:'css-span', html:'<span style="white-space:pre-wrap">LEFT\nRIGHT</span>', expected:'LEFT  \nRIGHT'},
      {id:'css-bold', html:'<p style="white-space:pre-wrap"><strong>LEFT</strong>\nRIGHT</p>', expected:'**LEFT**  \nRIGHT'},
      {id:'css-div', html:'<div style="white-space:pre-line">LEFT\nRIGHT</div>', expected:'LEFT  \nRIGHT'},
      {id:'css-link', html:'<p style="white-space:pre-wrap"><a href="https://example.com">LEFT</a>\nRIGHT</p>', expected:'[LEFT](https://example.com)  \nRIGHT'},
      {id:'css-reset', html:'<p style="white-space:pre-wrap">LEFT<span style="white-space:normal">\nRIGHT</span></p>', expected:'LEFT RIGHT'},
      {id:'enter', key:true, expected:'LEFT\n\nRIGHT'},
      {id:'shift-enter', key:true, shift:true, expected:'LEFT  \nRIGHT'}
    ]
    for (const eol of ['\n','\r\n']) for (const item of cases) {
      const id=item.id+(eol==='\n'?'-LF':'-CRLF'), file=join(root,id+'.md')
      const original=['# AUDIT','',item.key?'LEFT':'ANCHOR','','TAIL',''].join(eol)
      await writeFile(file, original)
      let app = await open(file,id+'-edit')
      try {
        await select(app,item.key?'LEFT':'ANCHOR',!!item.key)
        if (item.key) { await pressKey(app.send,{key:'Enter',modifiers:item.shift?8:0});await typeTextLikeUser(app.send,'RIGHT') }
        else await app.evaluate(`(() => {const e=${editor},d=new DataTransfer();d.setData('text/plain',${JSON.stringify((item.plain||'LEFT\nRIGHT').replace(/\n/g,eol))});${item.html?'d.setData("text/html",'+JSON.stringify(item.html.replace(/\n/g,eol))+');':''}e.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}))})()`)
        await sleep(750)
        const before = await inspect(app)
        assert.deepEqual(before.failures, [], id+' first divergence')
        const raw = await sourceView(app)
        const expected = '# AUDIT\n\n'+item.expected+'\n\nTAIL\n'
        assert.equal(raw,expected,id+' source does not match intended paste')
        await app.evaluate('document.querySelector(".hm-save-fab")?.click()')
        await wait(() => app.evaluate('!document.querySelector(".hm-save-fab")'),'save incomplete')
        const disk=await readFile(file,'utf8')
        assert.equal(disk,expected.replace(/\n/g,eol),id+' disk/EOL mismatch')
        await stopBuiltElectron(app);app=null
        app=await open(file,id+'-cold')
        const cold=await inspect(app)
        assert.deepEqual(cold.paragraphs,before.paragraphs,id+' cold reopen changed rich document')
        assert.deepEqual(cold.failures,[])
        assert.equal(await readFile(file,'utf8'),disk)
        results.push({id,source:raw,diskMatches:true,coldMatches:true})
        console.log('PASS',id)
      } finally { if(app)await stopBuiltElectron(app) }
    }
  }
  await writeFile(join(root,'result.json'),JSON.stringify({family,results},null,2))
  console.log('PASS #139 UI',results.length,'cases; evidence:',root)
} catch (error) {
  await writeFile(join(root,'result.json'),JSON.stringify({family,results,error:String(error)},null,2))
  console.error('Evidence retained:',root)
  throw error
}
