import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const PROFILE_DIR = '/tmp/horsemd-settings-view-ui'

async function main() {
  await rm(PROFILE_DIR, { recursive: true, force: true })
  await mkdir(join(PROFILE_DIR, 'themes'), { recursive: true })
  await writeFile(
    join(PROFILE_DIR, 'themes', 'Codex Custom.css'),
    'body { --codex-custom-theme-marker: 1; } #write { color: rgb(21, 34, 55); }',
    'utf8'
  )

  const app = await launchBuiltElectron({
    profileDir: PROFILE_DIR,
    port: 9446,
    cleanProfile: false
  })

  try {
    const result = await app.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const settingsKey = 'horsemd.settings.v1'
      const sessionKey = 'minimd.session.v1'
      const visible = (element) => {
        if (!element) return false
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      }
      const textOf = (element) => element?.textContent?.replace(/\\s+/g, ' ').trim() || ''
      const buttons = () => [...document.querySelectorAll('button')].filter(visible)
      const clickButton = async (predicate, label) => {
        const button = buttons().find(predicate)
        if (!button) throw new Error('Missing button: ' + label)
        button.click()
        await sleep(240)
        return button
      }
      const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
      const bodyHas = (name) => document.body.classList.contains(name)
      const groupByTitle = (titles, root = document) => {
        const normalized = titles.map((title) => title.toLowerCase())
        return [...root.querySelectorAll('.hm-adjust-group')].find((group) =>
          normalized.includes(textOf(group.querySelector('.hm-pop-title')).toLowerCase())
        )
      }
      const clickPreset = async (titles, labels, root = document) => {
        const group = groupByTitle(titles, root)
        if (!group) throw new Error('Missing adjust group: ' + titles.join('/'))
        const normalized = labels.map((label) => label.toLowerCase())
        const button = [...group.querySelectorAll('button')].filter(visible)
          .find((item) => normalized.includes(textOf(item).toLowerCase()))
        if (!button) throw new Error('Missing preset ' + labels.join('/') + ' in ' + titles.join('/'))
        button.click()
        await sleep(260)
        return button
      }
      const settings = () => JSON.parse(localStorage.getItem(settingsKey) || '{}')
      const clickNav = (labels) => {
        const normalized = labels.map((label) => label.toLowerCase())
        return clickButton((button) => normalized.includes(textOf(button).toLowerCase()), labels.join('/'))
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      window.queryLocalFonts = async () => [
        { family: 'Codex Sans' },
        { family: 'Codex Mono' },
        { family: 'Codex Sans' }
      ]

      await clickButton(
        (button) => button.title === '设置' || button.title === 'Settings' || textOf(button) === '设置' || textOf(button) === 'Settings',
        'settings'
      )
      await sleep(500)

      const settingsTabCount = [...document.querySelectorAll('.tab-title')]
        .filter((tab) => /设置|Settings/.test(textOf(tab))).length
      if (settingsTabCount !== 1) throw new Error('Expected one settings tab, got ' + settingsTabCount)
      if (document.querySelector('.save-fab')) throw new Error('Settings tab showed Save FAB / dirty affordance')

      await clickNav(['通用', 'General'])
      await clickButton((button) => /^English$/.test(textOf(button)), 'English language')
      await sleep(450)
      let rawSession = localStorage.getItem(sessionKey)
      let session = JSON.parse(rawSession || '{}')
      if ((session.openPaths || []).length) throw new Error('Settings tab leaked into openPaths: ' + rawSession)
      if ((session.untitled || []).some((tab) => /设置|Settings/i.test(tab.title || ''))) {
        throw new Error('Settings tab leaked into untitled session: ' + rawSession)
      }
      if (session.lang !== 'en') throw new Error('Language did not persist to session: ' + rawSession)

      await clickNav(['编辑器', 'Editor'])
      const spellToggle = [...document.querySelectorAll('button[role="switch"]')]
        .find((button) => visible(button) && /英文拼写检查|English spell-check/.test(button.getAttribute('aria-label') || ''))
      if (!spellToggle) throw new Error('Missing spellcheck toggle')
      spellToggle.click()
      await sleep(240)
      if (settings().spellcheck !== true) throw new Error('Spellcheck did not persist true')

      const largePreset = buttons().find((button) => ['大', 'Large'].includes(textOf(button)))
      if (!largePreset) throw new Error('Missing Large font preset')
      largePreset.click()
      await sleep(260)
      if (settings().fontSize !== 18) throw new Error('Font size did not persist 18: ' + JSON.stringify(settings()))
      if (getComputedStyle(document.documentElement).getPropertyValue('--editor-font-size').trim() !== '18px') {
        throw new Error('Font size CSS variable did not update')
      }
      await clickPreset(['Line Height', '行高'], ['Relaxed', '舒展'])
      if (settings().lineHeight !== 2) throw new Error('Line height did not persist 2.0: ' + JSON.stringify(settings()))
      if (cssVar('--editor-line-height') !== '2') throw new Error('Line height CSS variable did not update: ' + cssVar('--editor-line-height'))
      await clickPreset(['Paragraph Spacing', '段落间距'], ['Loose', '宽松'])
      if (settings().paragraphSpacing !== 1.6) throw new Error('Paragraph spacing did not persist 1.6: ' + JSON.stringify(settings()))
      if (cssVar('--editor-para-spacing') !== '1.6em') throw new Error('Paragraph spacing CSS variable did not update: ' + cssVar('--editor-para-spacing'))
      await clickPreset(['Editor width', '编辑区宽度', 'Page Width', '页面宽度'], ['Wide', '宽'])
      if (settings().pageWidth !== 1000) throw new Error('Page width did not persist 1000: ' + JSON.stringify(settings()))
      if (cssVar('--editor-max-width') !== '1000px') throw new Error('Page width CSS variable did not update: ' + cssVar('--editor-max-width'))
      await clickPreset(['Editor width', '编辑区宽度', 'Page Width', '页面宽度'], ['Full width', '全宽', 'Full', '通栏'])
      if (settings().pageWidth !== 'full') throw new Error('Full width did not persist: ' + JSON.stringify(settings()))
      if (!bodyHas('hm-full-width')) throw new Error('Full width body class did not apply')
      const fontFields = [...document.querySelectorAll('.settings-font-field')].filter(visible)
      if (fontFields.length < 2) throw new Error('Missing font picker fields')
      fontFields[0].click()
      await sleep(500)
      const writeFontOption = [...document.querySelectorAll('.settings-font-option')].filter(visible)
        .find((option) => /Codex Sans/.test(textOf(option)))
      if (!writeFontOption) throw new Error('Missing mocked write font option')
      writeFontOption.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }))
      await sleep(220)
      const appRoot = document.querySelector('.app')
      if (!appRoot || !/Codex Sans/.test(appRoot.style.getPropertyValue('--font-write'))) {
        throw new Error('Write font hover preview did not update app CSS var: ' + appRoot?.getAttribute('style'))
      }
      writeFontOption.click()
      await sleep(300)
      if (settings().fontWrite !== 'Codex Sans') throw new Error('Write font did not persist: ' + JSON.stringify(settings()))
      if (!/Codex Sans/.test(appRoot.style.getPropertyValue('--font-write'))) {
        throw new Error('Write font selection did not update app CSS var')
      }
      const monoField = [...document.querySelectorAll('.settings-font-field')].filter(visible)[1]
      monoField.click()
      await sleep(300)
      const monoSearch = document.querySelector('.settings-font-search')
      if (!visible(monoSearch)) throw new Error('Mono font search did not focus/open')
      setter.call(monoSearch, 'mono')
      monoSearch.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'mono' }))
      await sleep(260)
      const monoFontOption = [...document.querySelectorAll('.settings-font-option')].filter(visible)
        .find((option) => /Codex Mono/.test(textOf(option)))
      if (!monoFontOption) throw new Error('Missing mocked mono font option after search')
      monoFontOption.click()
      await sleep(300)
      if (settings().fontMono !== 'Codex Mono') throw new Error('Mono font did not persist: ' + JSON.stringify(settings()))
      if (!/Codex Mono/.test(appRoot.style.getPropertyValue('--font-mono'))) {
        throw new Error('Mono font selection did not update app CSS var')
      }
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 1, clientY: 1 }))
      await sleep(180)
      if (document.querySelector('.settings-font-menu')) throw new Error('Font menu did not close on outside pointer')

      await clickNav(['文件与图片', 'Files & Images'])
      const hiddenToggle = [...document.querySelectorAll('button[role="switch"]')].filter(visible)
        .find((button) => /hidden|隐藏/i.test(button.getAttribute('aria-label') || textOf(button.closest('.settings-row'))))
      if (!hiddenToggle) throw new Error('Missing hidden files toggle')
      hiddenToggle.click()
      await sleep(240)
      if (settings().showHiddenFiles !== true) throw new Error('Show hidden files did not persist true')
      const imageInput = [...document.querySelectorAll('input.settings-input')]
        .find((input) => input.type === 'text' && visible(input))
      if (!imageInput) throw new Error('Missing image host input')
      setter.call(imageInput, 'echo https://img.example/$1')
      imageInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'echo https://img.example/$1' }))
      await sleep(300)
      if (settings().imageUploadCommand !== 'echo https://img.example/$1') {
        throw new Error('Image host command did not persist: ' + JSON.stringify(settings()))
      }

      await clickNav(['Appearance', '外观'])
      const themeClasses = ['theme-morandi', 'theme-morandi-rose', 'theme-morandi-blue', 'theme-morandi-dark']
      const assertBuiltInTheme = (expected) => {
        const actual = document.body.className
        if (!document.body.classList.contains(expected.base)) {
          throw new Error('Built-in theme base did not apply for ' + expected.name + ': ' + actual)
        }
        for (const cls of themeClasses) {
          if (cls === expected.cls) continue
          if (document.body.classList.contains(cls)) {
            throw new Error('Unexpected stale theme class for ' + expected.name + ': ' + actual)
          }
        }
        if (expected.cls && !document.body.classList.contains(expected.cls)) {
          throw new Error('Built-in theme class did not apply for ' + expected.name + ': ' + actual)
        }
        if (document.body.classList.contains('hm-has-custom-theme')) {
          throw new Error('Built-in theme did not clear custom theme overlay for ' + expected.name + ': ' + actual)
        }
        if ((document.querySelector('#hm-custom-theme')?.textContent || '').trim()) {
          throw new Error('Built-in theme did not clear injected custom CSS for ' + expected.name)
        }
        const persistedSession = JSON.parse(localStorage.getItem(sessionKey) || '{}')
        if (persistedSession.theme !== expected.id) {
          throw new Error('Built-in theme did not persist for ' + expected.name + ': ' + JSON.stringify(persistedSession))
        }
      }
      const builtInThemes = [
        { id: 'light', name: 'Warm Light', base: 'light', cls: '' },
        { id: 'dark', name: 'Warm Dark', base: 'dark', cls: '' },
        { id: 'morandi', name: 'Morandi Sage', base: 'light', cls: 'theme-morandi' },
        { id: 'morandi-rose', name: 'Morandi Rose', base: 'light', cls: 'theme-morandi-rose' },
        { id: 'morandi-blue', name: 'Morandi Mist', base: 'light', cls: 'theme-morandi-blue' },
        { id: 'morandi-dark', name: 'Morandi Dusk', base: 'dark', cls: 'theme-morandi-dark' }
      ]
      for (const expected of builtInThemes) {
        const themeButton = buttons().find((button) => (button.title || textOf(button)) === expected.name)
        if (!themeButton) throw new Error('Missing built-in theme swatch: ' + expected.name)
        themeButton.click()
        await sleep(520)
        assertBuiltInTheme(expected)
      }
      const customThemeButton = buttons().find((button) => /Codex Custom/.test(button.title || textOf(button)))
      if (!customThemeButton) throw new Error('Missing test custom theme swatch')
      customThemeButton.click()
      await sleep(500)
      if (!document.body.classList.contains('hm-has-custom-theme')) {
        throw new Error('Custom theme marker did not apply: ' + document.body.className)
      }
      if (!/codex-custom-theme-marker/.test(document.querySelector('#hm-custom-theme')?.textContent || '')) {
        throw new Error('Custom theme CSS was not injected')
      }
      const lightTheme = buttons().find((button) => (button.title || textOf(button)) === 'Warm Light')
      if (!lightTheme) throw new Error('Missing Warm Light after custom theme')
      lightTheme.click()
      await sleep(520)
      assertBuiltInTheme(builtInThemes[0])

      await clickButton((button) => /new file|新建文件/i.test(button.title || textOf(button)), 'new document')
      await sleep(500)
      if (!document.querySelector('.statusbar .hm-layout .status-btn')) {
        throw new Error('Missing status bar layout control on document tab')
      }
      const layoutButton = document.querySelector('.statusbar .hm-layout .status-btn')
      layoutButton.click()
      await sleep(260)
      const layoutPopover = document.querySelector('.hm-layout-pop')
      if (!visible(layoutPopover)) throw new Error('Status bar layout popover did not open')
      await clickPreset(['Font Size', '字号'], ['Small', '小'], layoutPopover)
      if (settings().fontSize !== 14) throw new Error('Status bar font size did not persist 14: ' + JSON.stringify(settings()))
      if (cssVar('--editor-font-size') !== '14px') throw new Error('Status bar font size CSS variable did not update: ' + cssVar('--editor-font-size'))
      const themeButton = [...document.querySelectorAll('.statusbar .status-btn')].filter(visible)
        .find((button) => /Morandi|Warm|Codex Custom|暖|莫兰迪/.test(textOf(button)))
      if (!themeButton) throw new Error('Missing status bar theme button')
      themeButton.click()
      await sleep(260)
      const statusRose = [...document.querySelectorAll('.theme-menu .block-menu-item')].filter(visible)
        .find((button) => /Morandi Rose|豆沙/.test(textOf(button)))
      if (!statusRose) throw new Error('Missing status bar Morandi Rose option')
      statusRose.click()
      await sleep(360)
      if (!document.body.classList.contains('theme-morandi-rose') || document.body.classList.contains('hm-has-custom-theme')) {
        throw new Error('Status bar theme did not switch away from custom theme: ' + document.body.className)
      }
      const langButton = [...document.querySelectorAll('.statusbar .status-btn')].filter(visible)
        .find((button) => /EN|中文/.test(textOf(button)))
      if (!langButton) throw new Error('Missing status bar language button')
      langButton.click()
      await sleep(240)
      const chinese = [...document.querySelectorAll('.block-switch-menu .block-menu-item')].filter(visible)
        .find((button) => textOf(button) === '中文')
      if (!chinese) throw new Error('Missing status bar Chinese option')
      chinese.click()
      await sleep(450)
      session = JSON.parse(localStorage.getItem(sessionKey) || '{}')
      if (session.lang !== 'zh') throw new Error('Status bar language did not persist zh: ' + JSON.stringify(session))

      await clickButton(
        (button) => button.title === '设置' || button.title === 'Settings' || textOf(button) === '设置' || textOf(button) === 'Settings',
        'settings refocus'
      )
      await sleep(240)
      const settingsTabCountAfterRefocus = [...document.querySelectorAll('.tab-title')]
        .filter((tab) => /设置|Settings/.test(textOf(tab))).length
      if (settingsTabCountAfterRefocus !== 1) {
        throw new Error('Settings opened duplicate tabs: ' + settingsTabCountAfterRefocus)
      }
      await clickNav(['Editor', '编辑器'])
      const fontSizeGroup = groupByTitle(['Font Size', '字号'])
      if (!fontSizeGroup || !/14/.test(textOf(fontSizeGroup.querySelector('.hm-pop-value')))) {
        throw new Error('Settings page did not reflect status bar font size: ' + textOf(fontSizeGroup))
      }

      window.dispatchEvent(new Event('pagehide'))
      await sleep(500)
      rawSession = localStorage.getItem(sessionKey)
      session = JSON.parse(rawSession || '{}')
      if ((session.openPaths || []).length) throw new Error('Settings tab leaked into session after flush: ' + rawSession)
      if ((session.untitled || []).some((tab) => /设置|Settings/i.test(tab.title || '') || (tab.content || '').trim())) {
        throw new Error('Settings tab leaked into untitled after flush: ' + rawSession)
      }
      if (document.querySelector('.save-fab')) throw new Error('Settings changes marked document dirty')

      return {
        ok: true,
        lang: session.lang,
        settings: settings(),
        settingsTabCountAfterRefocus
      }
    })()`)

    if (!result?.ok) throw new Error('Settings view UI test failed')
    console.log(`settings view UI ok: lang ${result.lang}, font ${result.settings.fontSize}px`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
