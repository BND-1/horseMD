import { sleep } from './lib/cdp.mjs'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { COMMAND_DEFINITIONS, getCommandTitle, isCommandAvailable } from '../src/renderer/src/lib/commands/command-definitions.js'
import { keybindingToDisplay } from '../src/renderer/src/lib/commands/keybinding-normalize.js'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PLATFORM = process.platform
const i18nSource = readFileSync(new URL('../src/renderer/src/i18n.jsx', import.meta.url), 'utf8')
const englishSource = i18nSource.slice(i18nSource.indexOf('  en: {'), i18nSource.indexOf('\n  zh: {'))
const englishStrings = Object.fromEntries(
  [...englishSource.matchAll(/'([^']+)':\s*'((?:\\'|[^'])*)'/g)].map((match) => [
    match[1],
    match[2].replace(/\\n/g, '\n').replace(/\\'/g, "'")
  ])
)
const translateEnglish = (key, vars) => {
  let text = englishStrings[key] || key
  if (vars) for (const name in vars) text = text.replace('{' + name + '}', vars[name])
  return text
}
const EXPECTED_COMMANDS = COMMAND_DEFINITIONS
  .filter((command) => isCommandAvailable(command, {
    folderWorkspace: true,
    watch: true,
    windowControls: true,
    pdfExport: true,
    imageHostExec: true,
    nativeMenus: true,
    externalShell: true,
    revealInFolder: true,
    splitView: true,
    fileAttachments: true
  }))
  .map((command) => ({
    id: command.id,
    title: getCommandTitle(command, translateEnglish),
    category: translateEnglish(`settings.keyboard.category.${command.category}`),
    configurable: command.configurable !== false,
    bindings: (command.defaultKeybindings || [])
      .map((binding) => keybindingToDisplay(binding, PLATFORM))
      .filter(Boolean)
  }))

async function main() {
  const profileDir = await mkdtemp(join(tmpdir(), 'horsemd-keybindings-ui-'))
  const app = await launchBuiltElectron({
    profileDir,
    port: Number(process.env.CDP_PORT || 9449),
    cleanProfile: true
  })
  const { evaluate } = app

  try {
    const expectedCommands = JSON.stringify(EXPECTED_COMMANDS)
    const primaryMod = PLATFORM === 'darwin' ? { metaKey: true } : { ctrlKey: true }
    const result = await evaluate(`(async () => {
      const expectedCommands = ${expectedCommands}
      const primaryMod = ${JSON.stringify(primaryMod)}
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const storageKey = 'horsemd.keybindings.v1'
      const beforeStorage = localStorage.getItem(storageKey)
      const storedOverrides = () => JSON.parse(localStorage.getItem(storageKey) || '{"overrides":{}}')?.overrides || {}

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
        await sleep(180)
        return button
      }
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
        await sleep(160)
      }
      const setSearch = async (value) => {
        const input = document.querySelector('.settings-shortcut-search')
        if (!input) throw new Error('Missing shortcut search')
        input.focus()
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter.call(input, value)
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
        await sleep(180)
      }
      const rows = () => [...document.querySelectorAll('.settings-shortcut-row')].filter(visible)
      const rowByTitle = (candidates) => rows().find((row) => {
        const title = textOf(row.querySelector('.settings-shortcut-title')).toLowerCase()
        return candidates.some((candidate) => title === candidate.toLowerCase())
      })
      const rowTexts = () => rows().map(textOf)
      const clickRecorder = async (row) => {
        const button = row?.querySelector('.settings-shortcut-recorder')
        if (!button) throw new Error('Missing recorder')
        button.click()
        await sleep(120)
      }
      const assertDefaultRows = () => {
        const currentRows = rows()
        if (currentRows.length !== expectedCommands.length) {
          throw new Error('Shortcut command row count mismatch: expected ' + expectedCommands.length + ', got ' + currentRows.length)
        }
        const titles = currentRows.map((row) => textOf(row.querySelector('.settings-shortcut-title')))
        const duplicateTitles = titles.filter((title, index) => titles.indexOf(title) !== index)
        if (duplicateTitles.length) throw new Error('Duplicate shortcut titles in settings UI: ' + duplicateTitles.join(', '))
        for (const expected of expectedCommands) {
          const row = currentRows.find((candidate) => textOf(candidate.querySelector('.settings-shortcut-title')) === expected.title)
          if (!row) throw new Error('Missing shortcut row for command ' + expected.id + ' (' + expected.title + ')')
          const groupTitle = textOf(row.closest('.settings-shortcut-group')?.querySelector('.settings-shortcut-group-title'))
          if (groupTitle !== expected.category) {
            throw new Error('Shortcut category mismatch for ' + expected.id + ': expected ' + expected.category + ', got ' + groupTitle)
          }
          const recorder = row.querySelector('.settings-shortcut-recorder')
          if (!recorder) throw new Error('Missing shortcut recorder for ' + expected.id)
          if (recorder.disabled === expected.configurable) {
            throw new Error('Shortcut configurable state mismatch for ' + expected.id)
          }
          const labels = [...recorder.querySelectorAll('kbd')].map(textOf)
          if (expected.bindings.length) {
            const actual = labels.join(' | ')
            const wanted = expected.bindings.join(' | ')
            if (actual !== wanted) {
              throw new Error('Shortcut default binding mismatch for ' + expected.id + ': expected ' + wanted + ', got ' + actual)
            }
          } else if (!/Unassigned/.test(textOf(recorder))) {
            throw new Error('Shortcut unassigned state mismatch for ' + expected.id + ': ' + textOf(recorder))
          }
          const fixed = !!row.querySelector('.settings-shortcut-fixed')
          if (fixed === expected.configurable) {
            throw new Error('Shortcut fixed marker mismatch for ' + expected.id)
          }
        }
      }

      await clickButton(
        (button) => button.title === '设置' || button.title === 'Settings' || textOf(button) === '设置' || textOf(button) === 'Settings',
        'settings'
      )
      await clickButton((button) => ['通用', '常规', 'General'].includes(textOf(button)), 'general section')
      await clickButton((button) => /^English$/.test(textOf(button)), 'English language')
      await sleep(300)
      await clickButton((button) => ['键盘快捷键', 'Keyboard'].includes(textOf(button)), 'keyboard section')
      await clickButton((button) => ['全部恢复默认', 'Reset all'].includes(textOf(button)), 'reset all')
      await setSearch('')
      await sleep(250)

      const commandCount = rows().length
      if (commandCount < 30) throw new Error('Expected shortcut rows, got ' + commandCount)
      assertDefaultRows()

      await setSearch('保存')
      let filteredRows = rowTexts()
      if (!filteredRows.length) {
        await setSearch('save')
        filteredRows = rowTexts()
      }
      if (!filteredRows.some((text) => /保存|Save/.test(text))) {
        throw new Error('Search did not keep save command')
      }
      if (filteredRows.some((text) => /打开文件夹|Open Folder/i.test(text))) {
        throw new Error('Search leaked unrelated open-folder command')
      }

      const saveRow = rowByTitle(['保存', 'Save'])
      if (!saveRow) throw new Error('Missing save row')

      await clickRecorder(saveRow)
      await dispatchKey({ key: 'Enter', code: 'Enter' })
      if (!document.querySelector('.settings-shortcut-conflict')) {
        throw new Error('Reserved shortcut warning did not appear')
      }
      if (Object.prototype.hasOwnProperty.call(storedOverrides(), 'file.save')) {
        throw new Error('Reserved shortcut changed storage')
      }

      await clickRecorder(saveRow)
      await dispatchKey({ key: 'a', code: 'KeyA' })
      const textInputReserved = textOf(document.querySelector('.settings-shortcut-conflict'))
      if (!/text|文本|文字|输入/i.test(textInputReserved)) {
        throw new Error('Plain letter shortcut warning did not explain text-input reservation: ' + textInputReserved)
      }
      if (Object.prototype.hasOwnProperty.call(storedOverrides(), 'file.save')) {
        throw new Error('Plain letter shortcut changed storage')
      }

      await clickRecorder(saveRow)
      await dispatchKey({ key: 'o', code: 'KeyO', ...primaryMod })
      const conflictText = textOf(document.querySelector('.settings-shortcut-conflict'))
      if (!conflictText || !/打开|Open/.test(conflictText)) {
        throw new Error('Conflict warning did not mention open command: ' + conflictText)
      }
      await sleep(80)
      const saveRowWithConflict = rowByTitle(['淇濆瓨', 'Save'])
      const inlineConflictText = textOf(saveRowWithConflict?.querySelector('.settings-shortcut-inline-error'))
      if (!inlineConflictText || !/鎵撳紑|Open/.test(inlineConflictText)) {
        throw new Error('Inline conflict warning did not mention open command: ' + inlineConflictText)
      }
      if (!saveRowWithConflict?.classList.contains('has-error') || !saveRowWithConflict.querySelector('.settings-shortcut-recorder.error')) {
        throw new Error('Conflicting shortcut did not mark the edited row')
      }
      if (Object.prototype.hasOwnProperty.call(storedOverrides(), 'file.save')) {
        throw new Error('Conflicting shortcut changed storage')
      }

      await clickRecorder(saveRow)
      await dispatchKey({ key: 's', code: 'KeyS', ...primaryMod, altKey: true })
      const saveBinding = storedOverrides()?.['file.save']?.[0]
      if (saveBinding !== 'Mod+Alt+S') {
        throw new Error('Custom save shortcut was not stored: ' + saveBinding)
      }
      if (!textOf(saveRow).includes('⌥') && !textOf(saveRow).includes('Alt')) {
        throw new Error('Custom shortcut display did not update')
      }

      const beforeEscape = localStorage.getItem(storageKey)
      await clickRecorder(saveRow)
      await dispatchKey({ key: 'Escape', code: 'Escape' })
      const afterEscape = localStorage.getItem(storageKey)
      if (afterEscape !== beforeEscape) {
        throw new Error('Escape changed storage unexpectedly')
      }

      await clickRecorder(saveRow)
      await clickButton((button) => ['通用', '常规', 'General'].includes(textOf(button)), 'general section')
      await dispatchKey({ key: 'n', code: 'KeyN', ...primaryMod, altKey: true })
      const afterLeavingKeyboard = localStorage.getItem(storageKey)
      if (afterLeavingKeyboard !== afterEscape) {
        throw new Error('Recorder listener stayed active after leaving keyboard page')
      }

      await clickButton((button) => ['键盘快捷键', 'Keyboard'].includes(textOf(button)), 'keyboard section again')
      await setSearch('保存')
      if (!rowByTitle(['保存', 'Save'])) await setSearch('save')
      const saveRowAfterReturn = rowByTitle(['保存', 'Save'])
      if (!saveRowAfterReturn) throw new Error('Missing save row after returning')
      const clearButton = [...saveRowAfterReturn.querySelectorAll('.settings-shortcut-action')]
        .find((button) => /清空|Clear/.test(textOf(button)))
      if (!clearButton) throw new Error('Missing clear action')
      clearButton.click()
      await sleep(180)
      const cleared = storedOverrides()?.['file.save']
      if (!Array.isArray(cleared) || cleared.length !== 0) {
        throw new Error('Clear did not store an explicit empty binding')
      }
      if (!/未分配|Unassigned/.test(textOf(saveRowAfterReturn))) {
        throw new Error('Clear did not show unassigned state')
      }

      await clickButton((button) => ['全部恢复默认', 'Reset all'].includes(textOf(button)), 'reset all final')
      await sleep(220)
      if (Object.keys(storedOverrides()).length) {
        throw new Error('Reset all did not remove keybinding overrides')
      }

      if (beforeStorage == null) localStorage.removeItem(storageKey)
      else localStorage.setItem(storageKey, beforeStorage)

      return { ok: true, commandCount, filteredCount: filteredRows.length }
    })()`)

    if (!result?.ok) throw new Error('Settings keybindings UI test failed')
    console.log(`settings keybindings UI ok: ${result.commandCount} commands, ${result.filteredCount} filtered rows`)
  } finally {
    await stopBuiltElectron(app)
    await sleep(50)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
