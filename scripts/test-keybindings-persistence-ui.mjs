import { rm } from 'node:fs/promises'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const PROFILE_DIR = '/tmp/horsemd-keybindings-persistence-ui'
const CDP_PORT = 9333

function uiScript({ mode }) {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const storageKey = 'horsemd.keybindings.v1'
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
    const dispatchKey = async ({ key, code, metaKey = false, altKey = false }) => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key,
        code,
        metaKey,
        altKey,
        bubbles: true,
        cancelable: true
      }))
      await sleep(250)
    }
    const waitForMenu = async (expected) => {
      for (let i = 0; i < 25; i += 1) {
        const menu = await window.api.getMenuKeybindings()
        if (menu?.['file.save'] === expected) return menu
        await sleep(120)
      }
      return window.api.getMenuKeybindings()
    }

    await clickButton(
      (button) => button.title === '设置' || button.title === 'Settings' || textOf(button) === '设置' || textOf(button) === 'Settings',
      'settings'
    )
    await clickButton((button) => ['键盘快捷键', 'Keyboard'].includes(textOf(button)), 'keyboard section')
    await setSearch('保存')
    if (!rowByTitle(['保存', 'Save'])) await setSearch('save')
    const saveRow = rowByTitle(['保存', 'Save'])
    if (!saveRow) throw new Error('Missing save row')

    if (${JSON.stringify(mode)} === 'write') {
      await clickButton((button) => ['全部恢复默认', 'Reset all'].includes(textOf(button)), 'reset all')
      await setSearch('保存')
      if (!rowByTitle(['保存', 'Save'])) await setSearch('save')
      const row = rowByTitle(['保存', 'Save'])
      const recorder = row?.querySelector('.settings-shortcut-recorder')
      if (!recorder) throw new Error('Missing recorder')
      recorder.click()
      await sleep(160)
      await dispatchKey({ key: 's', code: 'KeyS', metaKey: true, altKey: true })
    }

    const rawStorage = localStorage.getItem(storageKey)
    const storage = JSON.parse(rawStorage || '{}')
    const binding = storage?.overrides?.['file.save']?.[0]
    if (binding !== 'Mod+Alt+S') {
      throw new Error('Expected persisted Mod+Alt+S, got ' + binding)
    }
    if (!/⌥|Alt/.test(textOf(saveRow))) {
      throw new Error('Save row does not display the customized shortcut: ' + textOf(saveRow))
    }
    const menu = await waitForMenu('CmdOrCtrl+Alt+S')
    if (menu?.['file.save'] !== 'CmdOrCtrl+Alt+S') {
      throw new Error('Menu accelerator was not synchronized: ' + JSON.stringify(menu))
    }
    return { ok: true, binding, menuSave: menu['file.save'] }
  })()`
}

async function main() {
  await rm(PROFILE_DIR, { recursive: true, force: true })

  let app = await launchBuiltElectron({
    profileDir: PROFILE_DIR,
    port: CDP_PORT,
    cleanProfile: false
  })
  try {
    const first = await app.evaluate(uiScript({ mode: 'write' }))
    if (!first?.ok) throw new Error('Initial persistence write failed')
  } finally {
    await stopBuiltElectron(app)
  }

  app = await launchBuiltElectron({
    profileDir: PROFILE_DIR,
    port: CDP_PORT,
    cleanProfile: false
  })
  try {
    const second = await app.evaluate(uiScript({ mode: 'read' }))
    if (!second?.ok) throw new Error('Persistence read after restart failed')
    console.log(`keybindings persisted after restart: ${second.binding}, menu ${second.menuSave}`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(PROFILE_DIR, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
