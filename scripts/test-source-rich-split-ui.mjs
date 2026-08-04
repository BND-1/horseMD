import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const dir = '/tmp/horsemd-source-rich-split'
const file = join(dir, 'split-preview.md')
const port = Number(process.env.CDP_PORT || 9885)
const source = `# 双栏预览\n\n开头段落。\n\n## 中段锚点\n\n${Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 段：滚动联动与源码保真测试内容。`).join('\n\n')}\n\n- 保持短横线列表\n- 第二项\n`

async function waitFor(check, message, attempts = 100, delay = 25) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(delay)
  }
  throw new Error(message)
}

async function toggleSplitPreview(evaluate) {
  const opened = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const target = editor?.querySelector('p, h1, h2') || editor
    if (!target) return false
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(rect.left + Math.min(24, rect.width / 2)),
      clientY: Math.round(rect.top + Math.min(20, rect.height / 2))
    }))
    return true
  })()`)
  assert.equal(opened, true, 'Could not open the rich editor context menu')
  await waitFor(
    () => evaluate(`!!document.querySelector('[data-source-rich-toggle]')`),
    'Source + preview was not available from the rich editor context menu'
  )
  await evaluate(`document.querySelector('[data-source-rich-toggle]')?.click()`)
}


async function placeSourceCaretAtEnd(evaluate) {
  const placed = await evaluate(`(() => {
    const el = document.querySelector('textarea.source-editor.hm-source-rich-left')
    if (!el) return false
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    return true
  })()`)
  assert.equal(placed, true, 'Could not focus source pane')
}



async function main() {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(file, source, 'utf8')
  const app = await launchBuiltElectron({ profileDir: join(dir, 'profile'), port, appArgs: [file] })
  try {
    const { evaluate, send } = app
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent && node.dataset.horsemdReady === 'true')`),
      'Rich editor did not become ready'
    )
    assert.equal(await evaluate(`!!document.querySelector('.hm-source-rich-toggle')`), false, 'Source + preview must not occupy the status bar')
    await toggleSplitPreview(evaluate)

    const layout = await waitFor(() => evaluate(`(() => {
      const source = document.querySelector('textarea.source-editor.hm-source-rich-left')
      const rich = document.querySelector('.editor-scroll.hm-source-rich-right')
      const host = rich?.querySelector('.editor-host')
      if (!source || !rich || !host || !source.offsetParent || !rich.offsetParent) return null
      const l = source.getBoundingClientRect(), r = rich.getBoundingClientRect(), h = host.getBoundingClientRect()
      const sourceStyle = getComputedStyle(source)
      return {
        sourceLeft: l.left, sourceRight: l.right, richLeft: r.left, richRight: r.right,
        hostLeft: h.left, hostRight: h.right,
        sourcePaddingRight: sourceStyle.paddingRight,
        hostPaddingLeft: getComputedStyle(host).paddingLeft,
        hostPaddingRight: getComputedStyle(host).paddingRight
      }
    })()`), 'Source + rich panes did not become visible together')
    assert.ok(layout.sourceRight <= layout.richLeft + 8, `Panes overlap: ${JSON.stringify(layout)}`)
    assert.ok(Math.abs(layout.hostLeft - layout.richLeft) <= 2 && Math.abs(layout.hostRight - layout.richRight) <= 12,
      `Rich preview host did not fill its panel: ${JSON.stringify(layout)}`)
    assert.equal(layout.sourcePaddingRight, '32px', `Source pane retained the single-view empty strip: ${JSON.stringify(layout)}`)
    assert.equal(layout.hostPaddingLeft, '32px', `Rich preview retained the single-view empty strip: ${JSON.stringify(layout)}`)
    assert.equal(layout.hostPaddingRight, '32px', `Rich preview retained the single-view empty strip: ${JSON.stringify(layout)}`)
    assert.equal(await evaluate(`!!document.querySelector('.tab-close.dirty')`), false, 'Opening split preview incorrectly marked the document dirty')

    // Source -> rich: every committed character goes through the normal input
    // path; only the final settled source snapshot may update the projection.
    await placeSourceCaretAtEnd(evaluate)
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await typeTextLikeUser(send, '## 源码实时标题')
    const afterSource = await evaluate(`document.querySelector('textarea.source-editor.hm-source-rich-left')?.value || ''`)
    assert.ok(afterSource.includes('## 源码实时标题'), 'Source textarea lost its authored heading')

    // Saving must honor the authored source immediately, before the 180ms rich
    // projection debounce can run. This is the durability boundary that
    // prevents a stale ProseMirror serializer from overwriting source typed
    // just before Cmd/Ctrl+S.
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'Source edit did not expose Save')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(
      async () => (await readFile(file, 'utf8')).includes('## 源码实时标题'),
      'Immediate source save wrote a stale rich snapshot'
    )
    await waitFor(
      () => evaluate(`document.querySelector('.editor-scroll.hm-source-rich-right .ProseMirror')?.textContent.includes('源码实时标题')`),
      'Source edit did not reach rich preview'
    )

    // The rich side is deliberately a preview: it cannot accept editing,
    // show block/selection affordances, open HorseMD's context menu, or turn
    // a click into an unsaved edit. It still remains scrollable for comparison.
    const previewContract = await evaluate(`(() => {
      const rich = document.querySelector('.editor-scroll.hm-source-rich-right .ProseMirror')
      const root = document.querySelector('.editor-scroll.hm-source-rich-right')
      if (!rich || !root) return null
      const rect = rich.getBoundingClientRect()
      rich.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(rect.left + 18),
        clientY: Math.round(rect.top + 18)
      }))
      rich.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: Math.round(rect.left + 18), clientY: Math.round(rect.top + 18) }))
      return {
        editable: rich.getAttribute('contenteditable'),
        toolbarDisplay: (() => {
          const toolbar = root.querySelector('.milkdown-toolbar')
          return toolbar ? getComputedStyle(toolbar).display : 'missing'
        })(),
        blockHandleDisplay: (() => {
          const handle = root.querySelector('.milkdown-block-handle')
          return handle ? getComputedStyle(handle).display : 'missing'
        })(),
        hasContextMenu: !!document.querySelector('.block-ctxmenu'),
        dirty: !!document.querySelector('.tab-close.dirty')
      }
    })()`)
    assert.deepEqual(previewContract, {
      editable: 'false', toolbarDisplay: 'none', blockHandleDisplay: 'none', hasContextMenu: false, dirty: false
    }, `Rich side was not a non-editing preview: ${JSON.stringify(previewContract)}`)

    // The source edit was already saved before preview refresh. Preview-side
    // reading must not manufacture a second save/dirty state.
    assert.equal(await evaluate(`!!document.querySelector('.hm-save-fab')`), false, 'Preview interaction incorrectly exposed Save')

    // Alternate source/rich scroll ownership ten times. The opposite pane must
    // follow without a reset to the document top or an infinite bounce.
    for (let index = 0; index < 10; index += 1) {
      const side = index % 2 === 0 ? 'source' : 'rich'
      const ratio = 0.16 + ((index * 0.071) % 0.68)
      const values = await evaluate(`(() => {
        const source = document.querySelector('textarea.source-editor.hm-source-rich-left')
        const rich = document.querySelector('.editor-scroll.hm-source-rich-right')
        const target = ${JSON.stringify(side)} === 'source' ? source : rich
        if (!source || !rich || !target) return null
        target.scrollTop = ${ratio} * Math.max(0, target.scrollHeight - target.clientHeight)
        target.dispatchEvent(new Event('scroll'))
        return { sourceTop: source.scrollTop, richTop: rich.scrollTop }
      })()`)
      assert.ok(values, 'Split scroll surfaces disappeared')
      await sleep(120)
      const followed = await evaluate(`(() => {
        const source = document.querySelector('textarea.source-editor.hm-source-rich-left')
        const rich = document.querySelector('.editor-scroll.hm-source-rich-right')
        return source && rich ? { sourceTop: source.scrollTop, richTop: rich.scrollTop } : null
      })()`)
      assert.ok(followed, 'Split scroll surfaces disappeared after sync')
      const opposite = side === 'source' ? followed.richTop : followed.sourceTop
      assert.ok(opposite > 10, `Scroll ${index + 1} did not move the ${side === 'source' ? 'rich' : 'source'} pane`)
    }

    // The normal source/rich control remains the explicit exit route; it first
    // leaves preview, then enters source mode, and the second click returns to
    // single rich mode.
    await evaluate(`[...document.querySelectorAll('.status-right .status-btn')].find((button) => /富文本|Rich/.test(button.textContent || ''))?.click()`)
    await waitFor(
      () => evaluate(`!!document.querySelector('textarea.source-editor') && !document.querySelector('textarea.source-editor.hm-source-rich-left')`),
      'Source/rich control did not exit preview into source mode'
    )
    await evaluate(`[...document.querySelectorAll('.status-right .status-btn')].find((button) => /源码|Source/.test(button.textContent || ''))?.click()`)
    await waitFor(
      () => evaluate(`!document.querySelector('textarea.source-editor') && !![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
      'Second source/rich control click did not return to single rich view'
    )

    console.log('PASS source + rich split UI: context entry, source-only editing, preview contract, save, 10 scroll links, close')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
