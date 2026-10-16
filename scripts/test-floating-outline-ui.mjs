import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = '/tmp/horsemd-floating-outline'
const fixture = join(root, 'floating-outline.md')
const splitFixture = join(root, 'floating-outline-split.md')
// A per-process port avoids reconnecting to an Electron instance that is still
// releasing a previous run's fixed CDP port on macOS.
const port = 9400 + (process.pid % 400)

const markdown = [
  '# Introduction',
  '',
  ...Array.from({ length: 15 }, (_, index) => {
    const number = index + 1
    const title = number === 8
      ? 'A very long section heading that must stay readable without widening the floating navigation beyond the editor edge'
      : `Section ${number}`
    return [
      `## ${title}`,
      '',
      ...Array.from({ length: 9 }, () => `Paragraph ${number}: stable scrolling content for the floating outline regression.`),
      ''
    ].join('\n')
  })
].join('\n')

const waitFor = async (check, message, attempts = 80) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const click = async (send, point) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

const sourceToggle = async (app) => {
  const point = await app.evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find((node) => node.offsetParent && /源码模式|Source mode/.test(node.title || ''))
    const rect = button?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`)
  assert.ok(point, 'Source mode button not found')
  await click(app.send, point)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(fixture, markdown, 'utf8')
  await writeFile(splitFixture, markdown.replace('# Introduction', '# Split document'), 'utf8')
  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [fixture, splitFixture] })
  try {
    // Start from the file browser to validate the compact navigator's default
    // state before checking that it remains available beside the full outline.
    const fileButton = await waitFor(() => app.evaluate(`(() => {
      const button = [...document.querySelectorAll('.activity-item')]
        .find((node) => /文件浏览|File browser/.test(node.title || ''))
      const rect = button?.getBoundingClientRect()
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
    })()`), 'Sidebar file browser button not found')
    await click(app.send, fileButton)
    const initial = await waitFor(() => app.evaluate(`(() => {
      const nav = document.querySelector('.floating-outline')
      const dots = nav?.querySelectorAll('.floating-outline-dot') || []
      const items = nav?.querySelectorAll('.floating-outline-item') || []
      return nav && dots.length > 0 && items.length === 16 ? {
        dots: dots.length,
        items: items.length,
        panelWidth: nav.querySelector('.floating-outline-panel')?.getBoundingClientRect().width || 0
      } : null
    })()`), 'Floating outline did not render')
    assert.ok(initial.dots <= 8, `Collapsed outline rendered too many dots: ${initial.dots}`)
    assert.equal(initial.panelWidth, 0, 'Floating outline starts expanded')

    const hoverPoint = await app.evaluate(`(() => {
      const rect = document.querySelector('.floating-outline')?.getBoundingClientRect()
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
    })()`)
    assert.ok(hoverPoint, 'Floating outline hover target missing')
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hoverPoint })
    const expanded = await waitFor(() => app.evaluate(`(() => {
      const nav = document.querySelector('.floating-outline')
      const long = [...(nav?.querySelectorAll('.floating-outline-item') || [])]
        .find((node) => (node.title || '').startsWith('A very long section'))
      const panel = nav?.querySelector('.floating-outline-panel')
      return panel?.getBoundingClientRect().width > 200 && long ? {
        panelWidth: panel.getBoundingClientRect().width,
        longClient: long.querySelector('.floating-outline-item-text')?.clientWidth || 0,
        longScroll: long.querySelector('.floating-outline-item-text')?.scrollWidth || 0,
        longTitle: long.title
      } : null
    })()`), 'Floating outline did not expand on hover')
    assert.ok(expanded.longScroll > expanded.longClient, 'Long heading was not constrained and ellipsized')
    assert.match(expanded.longTitle, /^A very long section/, 'Long heading lost its full tooltip')

    const themeSurfaces = await app.evaluate(`(() => {
      const original = document.body.className
      const samples = ['light', 'dark', 'light theme-morandi'].map((classes) => {
        document.body.className = classes
        const panel = document.querySelector('.floating-outline-list')
        const item = document.querySelector('.floating-outline-item')
        const active = document.querySelector('.floating-outline-item.active')
        const style = getComputedStyle(panel)
        return {
          classes,
          panel: style.backgroundColor,
          border: style.borderTopColor,
          item: getComputedStyle(item).color,
          active: getComputedStyle(active).color
        }
      })
      document.body.className = original
      return samples
    })()`)
    for (const theme of themeSurfaces) {
      assert.ok(theme.panel !== 'rgba(0, 0, 0, 0)', `${theme.classes} panel is transparent`)
      assert.notEqual(theme.item, theme.panel, `${theme.classes} item text has no panel contrast`)
      assert.notEqual(theme.active, theme.panel, `${theme.classes} active text has no panel contrast`)
      assert.notEqual(theme.border, theme.panel, `${theme.classes} panel border is invisible`)
    }

    await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.editor-scroll')].find((node) => node.offsetParent)
      const target = editor?.querySelectorAll('.ProseMirror h2')[10]
      if (!editor || !target) return false
      editor.scrollTop = target.getBoundingClientRect().top - editor.getBoundingClientRect().top + editor.scrollTop - 24
      editor.dispatchEvent(new Event('scroll'))
      return true
    })()`)
    await waitFor(() => app.evaluate(`document.querySelector('.floating-outline-item.active')?.title === 'Section 11'`), 'Scrollspy did not update the active section')
    const scrolledDotCount = await app.evaluate(`document.querySelectorAll('.floating-outline-dot').length`)
    assert.ok(scrolledDotCount <= 8, `Active chapter increased the compact dot count: ${scrolledDotCount}`)

    const firstItem = await app.evaluate(`(() => {
      const rect = document.querySelector('.floating-outline-item')?.getBoundingClientRect()
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
    })()`)
    assert.ok(firstItem, 'Floating outline first item missing')
    await click(app.send, firstItem)
    await waitFor(() => app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.editor-scroll')].find((node) => node.offsetParent)
      const heading = editor?.querySelector('.ProseMirror h1')
      if (!editor || !heading) return false
      return Math.abs(heading.getBoundingClientRect().top - editor.getBoundingClientRect().top) < 56
    })()`), 'Clicking a floating outline item did not jump to its heading')
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
    await waitFor(() => app.evaluate(`(
      document.querySelector('.floating-outline-panel')?.getBoundingClientRect().width || 0
    ) < 2`), 'Floating outline stayed expanded after clicking an item and moving the pointer away')

    await sourceToggle(app)
    await waitFor(() => app.evaluate(`Boolean([...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent))`), 'Source mode did not open')
    const sourceHover = await app.evaluate(`(() => {
      const rect = document.querySelector('.floating-outline')?.getBoundingClientRect()
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
    })()`)
    assert.ok(sourceHover, 'Floating outline source-mode hover target missing')
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...sourceHover })
    await waitFor(() => app.evaluate(`(
      document.querySelector('.floating-outline-panel')?.getBoundingClientRect().width || 0
    ) > 200`), 'Floating outline did not reopen in source mode on hover')
    const sourcePoint = await app.evaluate(`(() => {
      const item = [...document.querySelectorAll('.floating-outline-item')].find((node) => node.title === 'Section 12')
      const rect = item?.getBoundingClientRect()
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
    })()`)
    assert.ok(sourcePoint, 'Floating outline source-mode item missing')
    await click(app.send, sourcePoint)
    await waitFor(() => app.evaluate(`(() => {
      const textarea = [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)
      return textarea && textarea.scrollTop > 100
    })()`), 'Source mode floating outline did not scroll to the selected heading')

    await sourceToggle(app)
    await waitFor(() => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent))`), 'Could not return to rich mode')
    const outlineButton = await app.evaluate(`(() => {
      const button = [...document.querySelectorAll('.activity-item')].find((node) => /大纲|Outline/.test(node.title || ''))
      const rect = button?.getBoundingClientRect()
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
    })()`)
    assert.ok(outlineButton, 'Sidebar outline button missing')
    await click(app.send, outlineButton)
    await waitFor(() => app.evaluate(`Boolean(document.querySelector('.floating-outline'))`), 'Floating outline disappeared beside the full outline panel')

    await click(app.send, fileButton)
    await waitFor(() => app.evaluate(`Boolean(document.querySelector('.floating-outline'))`), 'Floating outline disappeared after leaving the sidebar outline')
    const splitButton = await app.evaluate(`(() => {
      const button = [...document.querySelectorAll('.topbar .icon-btn')]
        .find((node) => /分屏|Split/.test(node.title || ''))
      const rect = button?.getBoundingClientRect()
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
    })()`)
    assert.ok(splitButton, 'Split toggle button missing')
    await click(app.send, splitButton)
    const splitPanes = await waitFor(() => app.evaluate(`(() => {
      const panes = [...document.querySelectorAll('.editor-scroll')]
        .filter((node) => node.offsetParent)
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
      return panes.length === 2 ? panes.map((node) => {
        const rect = node.getBoundingClientRect()
        return { left: rect.left, right: rect.right, top: rect.top, height: rect.height }
      }) : null
    })()`), 'Split view did not show two document panes')

    const focusPane = async (pane) => {
      await click(app.send, { x: pane.left + 42, y: pane.top + Math.min(80, pane.height / 2) })
      return waitFor(() => app.evaluate(`(() => {
        const nav = document.querySelector('.floating-outline')
        const rect = nav?.getBoundingClientRect()
        return rect ? { left: rect.left, right: rect.right } : null
      })()`), 'Floating outline disappeared in split view')
    }
    const leftNav = await focusPane(splitPanes[0])
    assert.ok(Math.abs(leftNav.right - (splitPanes[0].right - 12)) < 5,
      `Left-pane navigator is not aligned to its pane edge (${leftNav.right} vs ${splitPanes[0].right - 12})`)
    const rightNav = await focusPane(splitPanes[1])
    assert.ok(Math.abs(rightNav.right - (splitPanes[1].right - 14)) < 5,
      `Right-pane navigator is not aligned to its pane edge (${rightNav.right} vs ${splitPanes[1].right - 14})`)

    console.log('PASS floating outline UI: dots, hover list, truncation, scrollspy, rich/source jumps, sidebar coexistence, and split-pane alignment')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
