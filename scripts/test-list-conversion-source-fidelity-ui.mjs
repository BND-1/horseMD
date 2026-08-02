import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const port = Number(process.env.CDP_PORT || 9791)
const root = `/tmp/horsemd-list-source-fidelity-${process.pid}`
const file = join(root, 'nested-lists.md')
const source = [
  '# 嵌套列表源码保真',
  '',
  '1. 用来做推特运营',
  '',
  '   * 发每日更新',
  '   * 搜索值得收藏的内容',
  '2. 自动写公众号',
  '',
  '   * 找选题、写文章',
  '3. 开发 HorseMD',
  '',
  '   * 监控 issue',
  '   * 实现新功能',
  ''
].join('\n')
const convertedExpected = source.replace(/^\d+\. /gm, '- ')

async function waitFor(check, message, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

async function convertFirstListAndType(app) {
  const opened = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const item = [...(editor?.querySelectorAll('li') || [])]
      .find((node) => [...node.querySelectorAll('p')]
        .some((paragraph) => paragraph.closest('li') === node && paragraph.textContent.trim() === '用来做推特运营'))
    const paragraph = [...(item?.querySelectorAll('p') || [])]
      .find((node) => node.closest('li') === item)
    const text = paragraph?.firstChild
    if (!paragraph || !text) return false
    const selection = window.getSelection()
    const range = document.createRange()
    range.setStart(text, text.nodeValue.length)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    paragraph.focus()
    const rect = paragraph.getBoundingClientRect()
    paragraph.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left + Math.min(40, rect.width / 2),
      clientY: rect.top + rect.height / 2
    }))
    return true
  })()`)
  assert.equal(opened, true, 'could not open the outer ordered-list context menu')

  const triggerPoint = await waitFor(() => app.evaluate(`(() => {
    const trigger = document.querySelector('[data-context-submenu-trigger="list"]')
    const rect = trigger?.getBoundingClientRect()
    return rect && trigger.offsetParent ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`), 'list conversion submenu trigger did not appear')
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...triggerPoint, button: 'none' })
  const actionPoint = await waitFor(() => app.evaluate(`(() => {
    const button = [...document.querySelectorAll('[data-list-conversion="bullet_list"]')]
      .find((node) => node.offsetParent)
    const rect = button?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`), 'bullet-list conversion action did not appear')
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...actionPoint, button: 'none' })
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...actionPoint, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...actionPoint, button: 'left', clickCount: 1 })

  // Intentionally do not wait for markdownUpdated. This is the production race:
  // a fast next keystroke may share the delayed callback with the conversion.
  await typeTextLikeUser(app.send, '追加甲', { delayMs: 5 })
}

async function openApp(profile, currentPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: currentPort,
    appArgs: [file]
  })
  await waitFor(
    () => app.evaluate(`[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent)`),
    'nested-list fixture did not open in rich mode'
  )
  await waitFor(
    () => app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      return editor?.textContent.includes('嵌套列表源码保真') &&
        editor.textContent.includes('开发 HorseMD')
    })()`),
    'nested-list fixture mounted before its target list content was ready'
  )
  return app
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, source)
  let app
  try {
    app = await openApp('profile-edit', port)
    await convertFirstListAndType(app)
    await waitFor(() => app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      return editor?.textContent.includes('追加甲') || false
    })()`), 'per-character input did not become visible in the ProseMirror document')
    // Save directly from rich mode before inspecting source. This protects the
    // production path where no standalone markdownUpdated callback arrives and
    // the user saves immediately after conversion/typing.
    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
    const saved = await readFile(file, 'utf8')
    assert.equal((saved.match(/追加甲/g) || []).length, 1, 'immediate text input was lost or duplicated')
    assert.equal(
      saved.replace('追加甲', ''),
      convertedExpected,
      'outer-list conversion rewrote nested spacing, lost markers, or merged text'
    )

    assert.equal(await toggleSource(app), true, 'could not switch to source mode')
    const raw = await waitFor(() => app.evaluate(`(() =>
      [...document.querySelectorAll('textarea.source-editor')]
        .find((node) => node.offsetParent)?.value ?? null
    )()`), 'source textarea did not appear')
    assert.equal(raw, saved, 'source view differs from the Markdown saved directly from rich mode')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('profile-reopen', port + 1)
    const shape = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const first = [...(editor?.querySelectorAll('li') || [])]
        .find((node) => [...node.querySelectorAll('p')]
          .some((paragraph) => paragraph.closest('li') === node && paragraph.textContent.includes('追加甲')))
      return {
        outer: first?.closest('ul, ol')?.tagName || null,
        nested: [...(first?.querySelectorAll('ul, ol') || [])]
          .find((list) => list.closest('li') === first)?.tagName || null
      }
    })()`)
    assert.deepEqual(shape, { outer: 'UL', nested: 'UL' }, 'saved file did not reopen with the converted outer and unchanged nested lists')
    assert.equal(await toggleSource(app), true, 'could not inspect source after full reopen')
    const reopened = await waitFor(() => app.evaluate(`(() =>
      [...document.querySelectorAll('textarea.source-editor')]
        .find((node) => node.offsetParent)?.value ?? null
    )()`), 'source textarea did not appear after reopen')
    assert.equal(reopened, saved, 'full reopen normalized or merged the saved nested-list source')

    console.log('PASS list conversion source fidelity: immediate typing, compact nested bytes, save, and full reopen')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
