import assert from 'node:assert/strict'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const PROFILE = '/tmp/horsemd-document-export-ui'
const BIN = '/tmp/horsemd-document-export-bin'

const waitFor = async (evaluate, expression, message, attempts = 100) => {
  for (let index = 0; index < attempts; index += 1) {
    if (await evaluate(expression)) return
    await sleep(150)
  }
  throw new Error(message)
}

async function main() {
  await rm(BIN, { recursive: true, force: true })
  await mkdir(BIN, { recursive: true })
  const fakePandoc = join(BIN, 'pandoc')
  await writeFile(fakePandoc, '#!/bin/sh\nprintf "pandoc 9.9.9-test\\n"\n', 'utf8')
  await chmod(fakePandoc, 0o755)

  const app = await launchBuiltElectron({
    profileDir: PROFILE,
    port: 9479,
    appArgs: [join(process.cwd(), 'scripts/fixtures/document-export-rich.md')],
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH || ''}` }
  })
  try {
    await waitFor(app.evaluate, `!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`, 'Editor did not become ready')
    const detected = await app.evaluate(`window.api.detectPandoc()`)
    assert.equal(detected.available, true)
    assert.equal(detected.version, '9.9.9-test')
    assert.match(detected.path, /horsemd-document-export-bin/)

    await app.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((node) => /command palette|命令面板/i.test(node.title || node.getAttribute('aria-label') || ''))
      button?.click()
      return !!button
    })()`)
    await waitFor(app.evaluate, `!!document.querySelector('.palette')`, 'Command palette did not open')
    await app.evaluate(`([...document.querySelectorAll('.palette-item')].find((node) => /HTML/i.test(node.textContent || ''))?.click(), true)`)
    await waitFor(app.evaluate, `!!document.querySelector('.hm-html-studio')`, 'HTML Studio did not open')
    await waitFor(app.evaluate, `document.querySelector('.hm-html-preview')?.dataset.previewStatus === 'ready'`, 'HTML preview did not become ready')

    const initial = await app.evaluate(`(() => {
      const preview = document.querySelector('.hm-html-preview')
      const frame = document.querySelector('.hm-html-preview iframe')
      return {
        token: preview?.dataset.previewToken || '',
        src: frame?.srcdoc || '',
        themeOptions: [...document.querySelectorAll('.hm-html-settings select')][0]?.options.length || 0,
        widthOptions: [...document.querySelectorAll('.hm-html-settings select')][1]?.options.length || 0,
        saveDisabled: document.querySelector('.hm-html-studio .hm-pdf-studio-footer .primary')?.disabled
      }
    })()`)
    assert.ok(initial.token)
    assert.equal(initial.themeOptions, 4)
    assert.equal(initial.widthOptions, 4)
    assert.equal(initial.saveDisabled, false)
    assert.match(initial.src, /Content-Security-Policy/)
    assert.doesNotMatch(initial.src, /<script/i)
    assert.match(initial.src, /<table/)
    assert.match(initial.src, /type="checkbox"/)
    assert.match(initial.src, /<math/)
    assert.match(initial.src, /<svg/)
    assert.match(initial.src, /data:image\/svg\+xml;base64/)
    assert.doesNotMatch(initial.src, /milkdown-code-block|language-picker|preview-panel/)

    await app.evaluate(`(() => {
      const selects = [...document.querySelectorAll('.hm-html-settings select')]
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setter.call(selects[0], 'night')
      selects[0].dispatchEvent(new Event('change', { bubbles: true }))
      const switches = [...document.querySelectorAll('.hm-html-settings .hm-pdf-switch')]
      switches.forEach((button) => button.click())
      return true
    })()`)
    await waitFor(app.evaluate, `document.querySelector('.hm-html-preview')?.dataset.previewStatus === 'ready' && document.querySelector('.hm-html-preview')?.dataset.previewToken !== ${JSON.stringify(initial.token)}`, 'Changed HTML preview did not settle')
    const changed = await app.evaluate(`document.querySelector('.hm-html-preview iframe')?.srcdoc || ''`)
    assert.match(changed, /color-scheme:dark/)
    assert.match(changed, /hm-html-cover/)
    assert.match(changed, /hm-html-toc/)

    await app.evaluate(`document.querySelector('.hm-pdf-close')?.click()`)
    await waitFor(app.evaluate, `!document.querySelector('.hm-html-studio')`, 'HTML Studio did not close')
    await app.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((node) => /设置|Settings/.test(node.title || node.textContent || ''))
      button?.click()
      return !!button
    })()`)
    await waitFor(app.evaluate, `!!document.querySelector('.settings-page')`, 'Settings did not open')
    await app.evaluate(`([...document.querySelectorAll('.settings-nav-item')].find((node) => /文件与图片|Files/i.test(node.textContent || ''))?.click(), true)`)
    await waitFor(app.evaluate, `/9\.9\.9-test/.test(document.querySelector('.hm-pandoc-tool-state')?.textContent || '')`, 'Pandoc settings did not show detected version')
    const toolState = await app.evaluate(`({
      status: document.querySelector('.hm-pandoc-tool-state')?.className || '',
      actions: document.querySelectorAll('.hm-pandoc-tool-actions button').length,
      text: document.querySelector('.hm-pandoc-tool-state')?.textContent || ''
    })`)
    assert.match(toolState.status, /available/)
    assert.equal(toolState.actions, 3)
    assert.match(toolState.text, /9\.9\.9-test/)

    console.log('document export UI tests passed')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(BIN, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error.stack || error)
  process.exit(1)
})
