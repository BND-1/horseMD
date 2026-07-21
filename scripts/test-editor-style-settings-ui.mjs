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
      let appearance = null
      for (let attempt = 0; attempt < 30; attempt += 1) {
        appearance = byText(['外观', 'Appearance'])
        if (appearance) break
        await sleep(100)
      }
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

    const added = await app.evaluate(`(() => {
      const editor = document.querySelector('.settings-css-editor')
      const block = editor?.closest('.settings-block')
      const add = [...(block?.querySelectorAll('button') || [])]
        .find((button) => /新增 CSS 片段|Add CSS snippet/.test(button.getAttribute('aria-label') || ''))
      add?.click()
      return Boolean(add)
    })()`)
    if (!added) throw new Error('custom CSS add-snippet action is missing')
    await sleep(180)
    const snippetEditor = await app.evaluate(`(() => {
      const active = document.querySelector('.settings-css-snippet.active')
      const editor = active?.closest('.settings-css-workspace')?.querySelector('.settings-css-editor')
      const name = active?.closest('.settings-css-workspace')?.querySelector('.settings-css-name-input')
      if (!editor || !name) return null
      name.value = 'Accent heading'
      name.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      editor.focus()
      return {
        snippetCount: document.querySelectorAll('.settings-css-snippet').length,
        activeToggle: active.querySelector('.hm-toggle')?.getAttribute('aria-checked')
      }
    })()`)
    if (!snippetEditor || snippetEditor.snippetCount !== 2 || snippetEditor.activeToggle !== 'true') {
      throw new Error('custom CSS snippet was not created: ' + JSON.stringify(snippetEditor))
    }
    await app.send('Input.insertText', {
      text: '.milkdown .ProseMirror h1 { color: rgb(70, 80, 90); }'
    })
    // A toggle immediately after typing must flush the pending CSS debounce;
    // otherwise a stale timer can restore the old enabled state afterwards.
    await app.evaluate(`document.querySelector('.settings-css-snippet.active .hm-toggle')?.click()`)
    await sleep(450)
    const flushedBeforeToggle = await app.evaluate(`(() => ({
      color: getComputedStyle(document.querySelector('.settings-preview.milkdown .ProseMirror h1')).color,
      snippets: JSON.parse(localStorage.getItem('horsemd.settings.v1') || '{}').userCssSnippets || []
    }))()`)
    if (flushedBeforeToggle.color !== 'rgb(12, 34, 56)' ||
      flushedBeforeToggle.snippets[1]?.enabled !== false ||
      !flushedBeforeToggle.snippets[1]?.css.includes('rgb(70, 80, 90)')) {
      throw new Error('typing then immediately toggling a snippet lost pending CSS: ' + JSON.stringify(flushedBeforeToggle))
    }

    await app.evaluate(`document.querySelector('.settings-css-snippet.active .hm-toggle')?.click()`)
    await sleep(180)
    const composed = await app.evaluate(`(() => ({
      color: getComputedStyle(document.querySelector('.settings-preview.milkdown .ProseMirror h1')).color,
      styleText: document.querySelector('#hm-user-css')?.textContent || '',
      snippets: JSON.parse(localStorage.getItem('horsemd.settings.v1') || '{}').userCssSnippets || []
    }))()`)
    if (composed.color !== 'rgb(70, 80, 90)' || composed.snippets.length !== 2 || !composed.styleText.includes('rgb(12, 34, 56)') || !composed.styleText.includes('rgb(70, 80, 90)')) {
      throw new Error('enabled snippets did not compose in order: ' + JSON.stringify(composed))
    }

    const disabled = await app.evaluate(`(() => {
      const active = document.querySelector('.settings-css-snippet.active')
      active?.querySelector('.hm-toggle')?.click()
      return Boolean(active)
    })()`)
    if (!disabled) throw new Error('active custom CSS snippet disappeared before toggle')
    await sleep(180)
    const toggled = await app.evaluate(`(() => ({
      color: getComputedStyle(document.querySelector('.settings-preview.milkdown .ProseMirror h1')).color,
      styleText: document.querySelector('#hm-user-css')?.textContent || ''
    }))()`)
    if (toggled.color !== 'rgb(12, 34, 56)' || toggled.styleText.includes('rgb(70, 80, 90)')) {
      throw new Error('disabled snippet still affected the editor: ' + JSON.stringify(toggled))
    }

    await app.evaluate(`document.querySelector('.settings-css-snippet.active .hm-toggle')?.click()`)
    await sleep(120)
    const moved = await app.evaluate(`(() => {
      const button = [...document.querySelectorAll('.settings-css-snippet-editor button')]
        .find((node) => /上移片段|Move snippet up/.test(node.getAttribute('aria-label') || ''))
      button?.click()
      return Boolean(button)
    })()`)
    if (!moved) throw new Error('custom CSS snippet move action is missing')
    await sleep(180)
    const reordered = await app.evaluate(`(() => ({
      color: getComputedStyle(document.querySelector('.settings-preview.milkdown .ProseMirror h1')).color,
      snippets: JSON.parse(localStorage.getItem('horsemd.settings.v1') || '{}').userCssSnippets || []
    }))()`)
    if (reordered.color !== 'rgb(12, 34, 56)' || reordered.snippets[0]?.name !== 'Accent heading') {
      throw new Error('snippet order did not determine CSS precedence: ' + JSON.stringify(reordered))
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

      const sourceButton = [...document.querySelectorAll('.status-btn')].find((button) => visible(button) && (() => {
        const label = button.title || textOf(button)
        return /Ctrl\\+\\/?|Cmd\\+\\/?|源码|Source|富文本|Rich/.test(label)
      })())
      if (!sourceButton) throw new Error('missing source-mode status button')
      sourceButton.click()
      let textarea = null
      for (let attempt = 0; attempt < 30; attempt += 1) {
        textarea = [...document.querySelectorAll('textarea.source-editor')].find(visible)
        if (textarea) break
        await sleep(100)
      }
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
