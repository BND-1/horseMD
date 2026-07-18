import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const port = Number(process.env.CDP_PORT || 9454)

async function main() {
  const app = await launchBuiltElectron({
    profileDir: '/tmp/horsemd-editor-style-settings-ui',
    port
  })

  try {
    await app.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const textOf = (element) => element?.textContent?.replace(/\\s+/g, ' ').trim() || ''
      const visible = (element) => {
        if (!element) return false
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      }
      const buttons = () => [...document.querySelectorAll('button')].filter(visible)
      const byText = (labels) => buttons().find((button) => labels.includes(textOf(button)))
      const settingsButton = buttons().find((button) =>
        button.title === '设置' || button.title === 'Settings' || textOf(button) === '设置' || textOf(button) === 'Settings'
      )
      if (!settingsButton) throw new Error('missing settings button')
      settingsButton.click()
      await sleep(300)

      const appearance = byText(['外观', 'Appearance'])
      if (!appearance) throw new Error('missing appearance nav')
      appearance.click()
      await sleep(150)
      if (document.querySelector('.settings-css-editor')) {
        throw new Error('custom CSS editor should not live under Appearance')
      }

      const editor = byText(['编辑器', 'Editor'])
      if (!editor) throw new Error('missing editor nav')
      editor.click()
      await sleep(200)
      const cssEditor = document.querySelector('.settings-css-editor')
      if (!cssEditor) throw new Error('missing custom CSS editor under Editor')
      const preview = document.querySelector('.settings-preview.milkdown .ProseMirror h1')
      if (!preview) throw new Error('missing HorseMD-style typography preview')
      const rows = [...document.querySelectorAll('.settings-typo-row')].filter(visible)
      if (rows.length !== 3) throw new Error('expected three paired typography rows')
      const expectedChildren = [2, 2, 2]
      for (const [index, row] of rows.entries()) {
        const children = [...row.children].filter(visible)
        if (children.length !== expectedChildren[index]) {
          throw new Error('unexpected typography row item count: ' + index)
        }
        const [left, right] = children.map((child) => child.getBoundingClientRect())
        if (Math.abs(left.top - right.top) > 1 || right.left <= left.right) {
          throw new Error('typography controls are not arranged as a desktop pair: ' + index)
        }
      }
      if (rows[0].querySelectorAll('.settings-font-row').length !== 2 ||
        rows.slice(1).some((row) => row.querySelectorAll('.hm-adjust-group').length !== 2)) {
        throw new Error('typography row grouping is incorrect')
      }
      const sourceTitle = [...document.querySelectorAll('.settings-block-title')]
        .find((title) => ['源码模式', 'Source mode'].includes(textOf(title)))
      const cssBlock = cssEditor.closest('.settings-block')
      const sourceBlock = sourceTitle?.closest('.settings-block')
      if (!cssBlock || !sourceBlock || !(cssBlock.compareDocumentPosition(sourceBlock) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        throw new Error('custom CSS must appear before source-mode settings')
      }
      cssEditor.focus()
      cssEditor.select()
      return true
    })()`)

    await app.send('Input.insertText', {
      text: '.milkdown .ProseMirror h1 { color: rgb(12, 34, 56); }'
    })
    await sleep(600)

    const cssResult = await app.evaluate(`(() => ({
      value: document.querySelector('.settings-css-editor')?.value || '',
      styleText: document.querySelector('#hm-user-css')?.textContent || '',
      color: getComputedStyle(document.querySelector('.settings-preview.milkdown .ProseMirror h1')).color
    }))()`)
    if (!cssResult.value.includes('rgb(12, 34, 56)')) {
      throw new Error('custom CSS was not typed into settings: ' + JSON.stringify(cssResult))
    }
    if (!cssResult.styleText.includes('rgb(12, 34, 56)')) {
      throw new Error('custom CSS was not injected: ' + JSON.stringify(cssResult))
    }
    if (cssResult.color !== 'rgb(12, 34, 56)') {
      throw new Error('typography preview did not receive user CSS: ' + JSON.stringify(cssResult))
    }

    const fontResult = await app.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const textOf = (element) => element?.textContent?.replace(/\\s+/g, ' ').trim() || ''
      const visible = (element) => {
        if (!element) return false
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      }
      const buttons = () => [...document.querySelectorAll('button')].filter(visible)
      const sourceGroup = [...document.querySelectorAll('.hm-adjust-group')]
        .find((group) => /源码字号|Source font size/.test(textOf(group)))
      if (!sourceGroup) {
        throw new Error('missing source font group; groups=' + [...document.querySelectorAll('.hm-adjust-group')].map(textOf).join(' | '))
      }
      const xl = [...sourceGroup.querySelectorAll('button')].find((button) => ['特大', 'XL'].includes(textOf(button)))
      if (!xl) throw new Error('missing source XL preset in group: ' + textOf(sourceGroup))
      xl.click()
      await sleep(250)

      const docTab = [...document.querySelectorAll('.tab')]
        .find((tab) => visible(tab) && !/设置|Settings/.test(textOf(tab)))
      if (!docTab) throw new Error('missing document tab')
      docTab.click()
      await sleep(300)

      const sourceButton = buttons().find((button) => {
        const label = button.title || textOf(button)
        return /Ctrl\\+\\/?|Cmd\\+\\/?|源码|Source|富文本|Rich/.test(label)
      })
      if (!sourceButton) throw new Error('missing source-mode status button')
      sourceButton.click()
      await sleep(500)

      const textarea = [...document.querySelectorAll('textarea.source-editor')].find(visible)
      if (!textarea) throw new Error('missing visible source editor')
      return {
        offset: getComputedStyle(document.documentElement).getPropertyValue('--source-font-offset').trim(),
        rootFont: getComputedStyle(document.documentElement).getPropertyValue('--editor-font-size').trim(),
        sourceFont: getComputedStyle(textarea).fontSize
      }
    })()`)
    if (fontResult.offset !== '4px') {
      throw new Error('source font offset did not apply: ' + JSON.stringify(fontResult))
    }
    if (fontResult.sourceFont !== '20px') {
      throw new Error('source editor did not use body font + source offset: ' + JSON.stringify(fontResult))
    }

    console.log('editor style settings UI ok:', { css: cssResult.color, source: fontResult })
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
