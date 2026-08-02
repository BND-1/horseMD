import { sleep } from './cdp.mjs'

export async function chooseContextExportFormat(evaluate, label, { attempts = 40 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    const opened = await evaluate(`(() => {
      const trigger = [...document.querySelectorAll('.context-submenu-trigger')]
        .find((node) => node.offsetParent)
      if (!trigger) return false
      trigger.focus()
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      return true
    })()`)
    if (opened) break
    await sleep(50)
    if (index === attempts - 1) throw new Error('Export submenu trigger not found')
  }

  for (let index = 0; index < attempts; index += 1) {
    const clicked = await evaluate(`(() => {
      const label = ${JSON.stringify(label)}.toLowerCase()
      const action = [...document.querySelectorAll('.context-submenu button')]
        .find((node) => (node.textContent || '').toLowerCase().includes(label))
      if (!action) return false
      action.click()
      return true
    })()`)
    if (clicked) return
    await sleep(50)
  }
  throw new Error(`Export submenu format not found: ${label}`)
}
