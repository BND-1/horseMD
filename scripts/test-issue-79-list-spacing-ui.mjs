import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const port = Number(process.env.CDP_PORT || 9650)
const fixture = join(process.cwd(), 'scripts', 'fixtures', 'list-spacing.md')

async function main() {
  const app = await launchBuiltElectron({
    profileDir: '/tmp/horsemd-issue-79-list-spacing-ui',
    port,
    appArgs: [fixture]
  })

  try {
    const result = await app.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const textOf = (element) => element?.textContent?.replace(/\\s+/g, ' ').trim() || ''
      const visible = (element) => {
        if (!element) return false
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      }
      const buttons = () => [...document.querySelectorAll('button')].filter(visible)
      const metric = (element) => {
        const style = getComputedStyle(element)
        return {
          fontSize: Number.parseFloat(style.fontSize),
          lineHeight: Number.parseFloat(style.lineHeight),
          marginTop: Number.parseFloat(style.marginTop)
        }
      }
      const currentEditor = () => [...document.querySelectorAll('.editor-scroll .ProseMirror')]
        .find((editor) => visible(editor))
      const listMetrics = (root) => {
        const unordered = root?.querySelector('ul')
        const ordered = root?.querySelector('ol')
        const nested = unordered?.querySelector('ul')
        // Milkdown wraps each list item in a node-view host, so a direct
        // child selector would miss the actual <li> element.
        const directItem = (list) => [...(list?.querySelectorAll('li') || [])]
          .find((item) => item.closest('ul, ol') === list)
        const unorderedItem = directItem(unordered)
        const orderedItem = directItem(ordered)
        if (!unordered || !ordered || !nested || !unorderedItem || !orderedItem) return null
        return {
          unordered: metric(unordered),
          ordered: metric(ordered),
          nested: metric(nested),
          unorderedItem: metric(unorderedItem),
          orderedItem: metric(orderedItem)
        }
      }
      const nearly = (actual, expected, label) => {
        if (Math.abs(actual - expected) > 0.15) {
          throw new Error(label + ': expected ' + expected + ', got ' + actual)
        }
      }
      const waitForEditor = async () => {
        for (let i = 0; i < 40; i += 1) {
          if (currentEditor()) return
          await sleep(100)
        }
        throw new Error('list fixture did not render in rich mode')
      }
      const groupByTitle = (titles) => {
        const wanted = titles.map((title) => title.toLowerCase())
        return [...document.querySelectorAll('.hm-adjust-group')].find((group) =>
          wanted.includes(textOf(group.querySelector('.hm-pop-title')).toLowerCase())
        )
      }
      const clickPreset = async (titles, labels) => {
        const group = groupByTitle(titles)
        if (!group) throw new Error('missing adjust group: ' + titles.join('/'))
        const wanted = labels.map((label) => label.toLowerCase())
        const button = [...group.querySelectorAll('button')].find((item) =>
          visible(item) && wanted.includes(textOf(item).toLowerCase())
        )
        if (!button) throw new Error('missing preset: ' + labels.join('/'))
        button.click()
        await sleep(260)
      }

      await waitForEditor()
      const before = listMetrics(currentEditor())
      if (!before) {
        throw new Error('fixture lists were not parsed: ' + (currentEditor()?.innerHTML || '').slice(0, 500))
      }

      const settingsButton = buttons().find((button) =>
        button.title === '设置' || button.title === 'Settings' || textOf(button) === '设置' || textOf(button) === 'Settings'
      )
      if (!settingsButton) throw new Error('missing settings button')
      settingsButton.click()
      await sleep(350)

      const editorNav = buttons().find((button) => ['编辑器', 'Editor'].includes(textOf(button)))
      if (!editorNav) throw new Error('missing editor settings navigation')
      editorNav.click()
      await sleep(220)

      await clickPreset(['Line Height', '行间距'], ['Loose', '宽松'])
      await clickPreset(['Paragraph Spacing', '段落间距'], ['Loose', '松散'])

      const preview = document.querySelector('.settings-preview .ProseMirror')
      const previewList = preview?.querySelector('ul')
      const previewItem = [...(previewList?.querySelectorAll('li') || [])]
        .find((item) => item.closest('ul, ol') === previewList)
      if (!previewList || !previewItem) throw new Error('settings preview must include a list sample')
      const previewMetrics = { list: metric(previewList), item: metric(previewItem) }

      const documentTab = [...document.querySelectorAll('.tab')].find((tab) =>
        visible(tab) && /list-spacing\\.md/i.test(tab.title || textOf(tab))
      )
      if (!documentTab) throw new Error('missing list fixture tab')
      documentTab.click()
      await sleep(300)

      const after = listMetrics(currentEditor())
      if (!after) throw new Error('list fixture disappeared after returning from settings')
      const expectedLineHeight = after.unorderedItem.fontSize * 2.2
      const expectedOuterMargin = after.unordered.fontSize * 1.6 * 1.25
      const expectedItemMargin = after.unorderedItem.fontSize * 1.6 * 0.625
      const expectedNestedMargin = after.nested.fontSize * 1.6 * 0.5

      for (const [name, metrics] of Object.entries({ unordered: after.unorderedItem, ordered: after.orderedItem })) {
        nearly(metrics.lineHeight, expectedLineHeight, name + ' list item line height')
      }
      for (const [name, metrics] of Object.entries({ unordered: after.unordered, ordered: after.ordered })) {
        nearly(metrics.marginTop, expectedOuterMargin, name + ' list outer margin')
      }
      nearly(after.unorderedItem.marginTop, expectedItemMargin, 'unordered item margin')
      nearly(after.orderedItem.marginTop, expectedItemMargin, 'ordered item margin')
      nearly(after.nested.marginTop, expectedNestedMargin, 'nested list margin')

      const previewExpectedLineHeight = previewMetrics.item.fontSize * 2.2
      nearly(previewMetrics.item.lineHeight, previewExpectedLineHeight, 'preview list item line height')

      if (after.unorderedItem.lineHeight <= before.unorderedItem.lineHeight ||
          after.ordered.marginTop <= before.ordered.marginTop) {
        throw new Error('list spacing did not increase after selecting loose presets')
      }

      return { before, after, preview: previewMetrics }
    })()`)

    console.log('issue #79 list spacing UI ok:', {
      unorderedLineHeight: result.after.unorderedItem.lineHeight,
      orderedLineHeight: result.after.orderedItem.lineHeight,
      unorderedMargin: result.after.unordered.marginTop,
      nestedMargin: result.after.nested.marginTop
    })
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
