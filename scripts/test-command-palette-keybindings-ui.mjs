import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const PRIMARY_MOD = process.platform === 'darwin' ? { metaKey: true } : { ctrlKey: true }

async function main() {
  const app = await launchBuiltElectron({
    profileDir: '/tmp/horsemd-command-palette-keybindings-ui-' + process.pid + '-' + Date.now(),
    port: 9449
  })

  try {
    const result = await app.evaluate(`(async () => {
      const primaryMod = ${JSON.stringify(PRIMARY_MOD)}
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const visible = (element) => {
        if (!element) return false
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      }
      const textOf = (element) => element?.textContent?.replace(/\\s+/g, ' ').trim() || ''
      const buttons = () => [...document.querySelectorAll('button')].filter(visible)
      const clickButton = async (predicate, label) => {
        const button = buttons().find(predicate)
        if (!button) throw new Error('Missing button: ' + label)
        button.click()
        await sleep(220)
        return button
      }
      const setNativeValue = (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter.call(input, value)
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
      const setShortcutSearch = async (value) => {
        const input = document.querySelector('.settings-shortcut-search')
        if (!input) throw new Error('Missing shortcut search')
        input.focus()
        setNativeValue(input, value)
        await sleep(220)
      }
      const rows = () => [...document.querySelectorAll('.settings-shortcut-row')].filter(visible)
      const rowByTitle = (candidates) => rows().find((row) => {
        const title = textOf(row.querySelector('.settings-shortcut-title')).toLowerCase()
        return candidates.some((candidate) => title === candidate.toLowerCase())
      })
      const dispatchKey = async ({ key, code, metaKey = false, ctrlKey = false, altKey = false, shiftKey = false }) => {
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key,
          code,
          metaKey,
          ctrlKey,
          altKey,
          shiftKey,
          bubbles: true,
          cancelable: true
        }))
        await sleep(260)
      }
      const sidebarState = () => {
        const button = buttons().find((item) => /侧边栏|Sidebar/i.test(item.title) && item.className.includes('activity-item'))
        if (!button) throw new Error('Missing sidebar toggle button')
        return button.title
      }
      const openPalette = async () => {
        await clickButton(
          (button) => /命令面板|Command Palette/i.test(button.title) || /命令面板|Command Palette/i.test(textOf(button)),
          'command palette'
        )
        await sleep(260)
      }
      const paletteItems = () => [...document.querySelectorAll('.palette-item')].filter(visible)

      await clickButton(
        (button) => button.title === '设置' || button.title === 'Settings' || textOf(button) === '设置' || textOf(button) === 'Settings',
        'settings'
      )
      await clickButton((button) => /键盘快捷键|Keyboard/.test(textOf(button)), 'keyboard section')
      await clickButton((button) => ['全部恢复默认', 'Reset all'].includes(textOf(button)), 'reset all')
      await setShortcutSearch('保存')
      if (!rowByTitle(['保存', 'Save'])) await setShortcutSearch('save')
      const saveRow = rowByTitle(['保存', 'Save'])
      if (!saveRow) throw new Error('Missing save row')
      const recorder = saveRow.querySelector('.settings-shortcut-recorder')
      if (!recorder) throw new Error('Missing save recorder')
      recorder.click()
      await sleep(140)
      await dispatchKey({ key: 's', code: 'KeyS', ...primaryMod, altKey: true })
      if (JSON.parse(localStorage.getItem('horsemd.keybindings.v1') || '{"overrides":{}}')?.overrides?.['file.save']?.[0] !== 'Mod+Alt+S') {
        throw new Error('Save shortcut was not persisted as Mod+Alt+S')
      }
      const updatedSaveRow = rowByTitle(['保存', 'Save'])
      if (!updatedSaveRow?.querySelector('kbd')) throw new Error('Save row did not show custom shortcut')

      await clickButton((button) => button.title === '主页' || button.title === 'Home', 'home')
      await sleep(260)
      await openPalette()
      const palette = document.querySelector('.palette')
      const overlay = document.querySelector('.palette-overlay')
      if (!palette || !overlay) throw new Error('Command palette surface did not open')
      const stablePaletteWidth = palette.getBoundingClientRect().width
      const itemsBeforeHover = paletteItems()
      if (itemsBeforeHover.length < 3) throw new Error('Command palette has too few items for hover regression')
      for (const item of itemsBeforeHover.slice(0, 3)) {
        item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
        await sleep(40)
      }
      if (palette.getBoundingClientRect().width !== stablePaletteWidth) {
        throw new Error('Command palette resized while changing hovered items')
      }
      const appRoot = document.querySelector('.app')
      if (!appRoot) throw new Error('Missing app root')
      const originalClass = appRoot.className
      appRoot.classList.add('is-win')
      const windowsBackdropFilter = getComputedStyle(overlay).backdropFilter
      appRoot.className = originalClass
      if (windowsBackdropFilter !== 'none') {
        throw new Error('Windows command palette still uses a backdrop filter')
      }
      const savePaletteItem = paletteItems().find((item) => /保存|Save/i.test(textOf(item)))
      if (!savePaletteItem) throw new Error('Missing Save item in command palette')
      const saveShortcutLabel = textOf(updatedSaveRow.querySelector('kbd'))
      if (!textOf(savePaletteItem).includes(saveShortcutLabel)) {
        throw new Error('Palette Save hint did not reflect custom shortcut: ' + textOf(savePaletteItem))
      }
      document.querySelector('.palette-overlay')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await sleep(240)

      await openPalette()
      let sidebarItem = paletteItems().find((item) => /侧边栏|Sidebar/i.test(textOf(item)))
      if (!sidebarItem) throw new Error('Missing Toggle Sidebar item in command palette')
      const before = sidebarState()
      sidebarItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
      sidebarItem.click()
      await sleep(350)
      const after = sidebarState()
      if (after === before) throw new Error('Palette Toggle Sidebar did not execute')
      await dispatchKey({ key: 'B', code: 'KeyB', ...primaryMod, shiftKey: true })
      const afterShortcut = sidebarState()
      if (afterShortcut !== before) {
        throw new Error('Palette execution appears to have double-fired or left sidebar in wrong state')
      }

      return { ok: true, saveHint: textOf(savePaletteItem), before, after, afterShortcut }
    })()`)

    if (!result?.ok) throw new Error('Command palette keybinding UI test failed')
    console.log(`command palette keybindings UI ok: ${result.saveHint}`)
  } finally {
    await stopBuiltElectron(app)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
