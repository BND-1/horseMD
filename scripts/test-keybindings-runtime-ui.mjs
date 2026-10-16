import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const primaryMod = process.platform === 'darwin' ? { metaKey: true } : { ctrlKey: true }

async function main() {
  const app = await launchBuiltElectron({
    profileDir: `/tmp/horsemd-keybindings-runtime-ui-${process.pid}-${Date.now()}`,
    port: 9445
  })

  try {
    const result = await app.evaluate(`(async () => {
      const primaryMod = ${JSON.stringify(primaryMod)}
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
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
        await sleep(220)
        return button
      }
      const setSearch = async (value) => {
        const input = document.querySelector('.settings-shortcut-search')
        if (!input) throw new Error('Missing shortcut search')
        input.focus()
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter.call(input, value)
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
        await sleep(220)
      }
      const rows = () => [...document.querySelectorAll('.settings-shortcut-row')].filter(visible)
      const rowByTitle = (candidates) => rows().find((row) => {
        const title = textOf(row.querySelector('.settings-shortcut-title')).toLowerCase()
        return candidates.some((candidate) => title === candidate.toLowerCase())
      })
      const sidebarState = () => {
        const button = buttons().find((item) => /侧边栏|Sidebar/i.test(item.title) && item.className.includes('activity-item'))
        if (!button) throw new Error('Missing sidebar toggle button')
        return button.title
      }
      const dispatchSidebarShortcut = async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'B',
          code: 'KeyB',
          ...primaryMod,
          shiftKey: true,
          bubbles: true,
          cancelable: true
        }))
        await sleep(260)
      }
      const dispatchFindShortcut = async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'F',
          code: 'KeyF',
          ...primaryMod,
          bubbles: true,
          cancelable: true
        }))
        await sleep(260)
      }

      await clickButton(
        (button) => button.title === '设置' || button.title === 'Settings' || textOf(button) === '设置' || textOf(button) === 'Settings',
        'settings'
      )
      await clickButton((button) => /键盘快捷键|Keyboard/.test(textOf(button)), 'keyboard section')
      await clickButton((button) => ['全部恢复默认', 'Reset all'].includes(textOf(button)), 'reset all')
      await setSearch('侧边栏')
      if (!rowByTitle(['切换侧边栏', 'Toggle Sidebar'])) await setSearch('sidebar')
      const sidebarRow = rowByTitle(['切换侧边栏', 'Toggle Sidebar'])
      if (!sidebarRow) throw new Error('Missing toggle sidebar row')

      const clearButton = [...sidebarRow.querySelectorAll('.settings-shortcut-action')]
        .find((button) => /清空|Clear/.test(textOf(button)))
      if (!clearButton) throw new Error('Missing clear button')
      clearButton.click()
      await sleep(220)

      const beforeClearedShortcut = sidebarState()
      await dispatchSidebarShortcut()
      const afterClearedShortcut = sidebarState()
      if (afterClearedShortcut !== beforeClearedShortcut) {
        throw new Error('Cleared sidebar shortcut still toggled the sidebar')
      }

      const resetButton = [...sidebarRow.querySelectorAll('.settings-shortcut-action')]
        .find((button) => /恢复|Reset/.test(textOf(button)))
      if (!resetButton) throw new Error('Missing per-command reset button after clear')
      resetButton.click()
      await sleep(220)

      const beforeSettingsShortcut = sidebarState()
      await dispatchSidebarShortcut()
      const afterSettingsShortcut = sidebarState()
      if (afterSettingsShortcut !== beforeSettingsShortcut) {
        throw new Error('Settings page allowed sidebar shortcut to execute in the background')
      }
      await dispatchFindShortcut()
      if (document.querySelector('.findbar')) {
        throw new Error('Settings page allowed document find shortcut to open in the background')
      }

      await clickButton((button) => button.title === '主页' || button.title === 'Home', 'home')
      await sleep(260)
      const beforeDefaultShortcut = sidebarState()
      await dispatchSidebarShortcut()
      const afterDefaultShortcut = sidebarState()
      if (afterDefaultShortcut === beforeDefaultShortcut) {
        throw new Error('Restored default sidebar shortcut did not toggle the sidebar')
      }

      await dispatchSidebarShortcut()
      const afterSecondDefaultShortcut = sidebarState()
      if (afterSecondDefaultShortcut !== beforeDefaultShortcut) {
        throw new Error('Sidebar shortcut did not return to the original state on the second press')
      }

      return {
        ok: true,
        beforeClearedShortcut,
        afterDefaultShortcut,
        afterSecondDefaultShortcut
      }
    })()`)

    if (!result?.ok) throw new Error('Runtime keybinding UI test failed')
    console.log('keybindings runtime UI ok: clear disables, reset restores, shortcut toggles once')
  } finally {
    await stopBuiltElectron(app)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
