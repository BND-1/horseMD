import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = '/tmp/horsemd-inline-html-block-handle'
const fixture = join(root, 'inline-html.md')
const port = Number(process.env.CDP_PORT || 9494)

const markdown = [
  '## 测试一下',
  '',
  '* 测试一下，测试一下测试一下测试一下<font color=#F36208>测试一下</font>测试一下测试一下啊。（存在bug）',
  '',
  '* 测试一下测试一下再测试一下，<font color=#F36208>测试一下</font>。（存在bug）',
  '',
  '* 测试一下测试一下啊测试一下<font color=#F36208>测试一下</font>',
  '',
  '* 测试一下测试一下测试一下啊，<span style="background:#affad1">测试一下</span>（存在bug）'
].join('\n')

async function move(app, point) {
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await sleep(260)
  return app.evaluate(`(() => [...document.querySelectorAll('.milkdown-block-handle')]
    .some((handle) => handle.dataset.show === 'true' && getComputedStyle(handle).opacity !== '0'))()`)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(fixture, markdown, 'utf8')
  const app = await launchBuiltElectron({
    profileDir: join(root, 'profile'),
    port,
    appArgs: [fixture]
  })

  try {
    let points = null
    for (let attempt = 0; attempt < 40; attempt += 1) {
      points = await app.evaluate(`(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        const html = editor?.querySelector('.hm-html-inline')
        const text = html?.closest('p')?.firstChild
        if (!editor || !html || !text) return null
        const atom = html.getBoundingClientRect()
        const range = document.createRange()
        range.setStart(text, 1)
        range.setEnd(text, 2)
        const plain = range.getBoundingClientRect()
        const editorRect = editor.getBoundingClientRect()
        return {
          inlineHtml: { x: atom.left + atom.width / 2, y: atom.top + atom.height / 2 },
          plainText: { x: plain.left + plain.width / 2, y: plain.top + plain.height / 2 },
          gutter: { x: editorRect.left + 8, y: atom.top + atom.height / 2 }
        }
      })()`)
      if (points) break
      await sleep(100)
    }
    assert.ok(points, 'inline HTML fixture did not render in rich mode')

    assert.equal(await move(app, points.inlineHtml), false,
      'block handle appeared over inline <font>/<span> content')
    assert.equal(await move(app, points.plainText), false,
      'block handle appeared over ordinary body text')
    assert.equal(await move(app, points.gutter), true,
      'block handle no longer opens from the left block-operation gutter')

    console.log('PASS inline HTML block handle UI: inline HTML stays control-free; left gutter retains block actions')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
