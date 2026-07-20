import assert from 'node:assert/strict'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const port = Number(process.env.CDP_PORT || 9486)

async function waitFor(check, message, attempts = 50) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

async function openEditorSettings(evaluate) {
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const textOf = (node) => node?.textContent?.replace(/\s+/g, ' ').trim() || ''
    const visible = (node) => {
      if (!node) return false
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    }
    const buttons = () => [...document.querySelectorAll('button')].filter(visible)
    const settings = buttons().find((button) => ['设置', 'Settings'].includes(button.title || textOf(button)))
    if (!settings) throw new Error('Missing settings button')
    settings.click()
    await sleep(250)
    const editor = buttons().find((button) => ['编辑器', 'Editor'].includes(textOf(button)))
    if (!editor) throw new Error('Missing Editor settings navigation')
    editor.click()
    await sleep(200)
  })()`)
}

async function checkPicker(evaluate, send, index, query) {
  assert.equal(await evaluate(`(() => {
    const field = document.querySelectorAll('.settings-font-field')[${index}]
    if (!field) return false
    field.click()
    return true
  })()`), true, `Missing font picker ${index}`)

  await waitFor(
    () => evaluate(`(() => {
      const input = document.querySelector('.settings-font-menu .settings-font-search')
      return input && document.activeElement === input
    })()`),
    `Font picker ${index} search field did not receive focus`
  )
  await send('Input.insertText', { text: query })
  await waitFor(
    () => evaluate(`document.querySelector('.settings-font-menu .settings-font-search')?.value === ${JSON.stringify(query)}`),
    `Font picker ${index} search field did not accept text`
  )
  const result = await evaluate(`(() => {
    const input = document.querySelector('.settings-font-menu .settings-font-search')
    const menu = input?.closest('.settings-font-menu')
    return {
      value: input?.value || '',
      focused: document.activeElement === input,
      visible: Boolean(menu?.offsetParent)
    }
  })()`)
  assert.deepEqual(result, { value: query, focused: true, visible: true }, `Font picker ${index} search state changed unexpectedly`)

  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await waitFor(
    () => evaluate(`!document.querySelector('.settings-font-menu')`),
    `Font picker ${index} did not close on Escape`
  )
}

async function main() {
  const app = await launchBuiltElectron({ profileDir: '/tmp/horsemd-font-picker-ui', port })
  try {
    const { evaluate, send } = app
    await openEditorSettings(evaluate)
    await checkPicker(evaluate, send, 0, 'source serif')
    await checkPicker(evaluate, send, 1, 'source code')
    console.log('PASS font picker UI: document and code font searches accept input and retain focus')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
