import assert from 'node:assert/strict'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const PROFILE_DIR = '/tmp/horsemd-system-theme-ui'
const port = Number(process.env.CDP_PORT || 9731)

const setScheme = async (app, value) => {
  await app.send('Emulation.setEmulatedMedia', {
    media: 'screen',
    features: [{ name: 'prefers-color-scheme', value }]
  })
  await sleep(350)
}

async function main() {
  const app = await launchBuiltElectron({ profileDir: PROFILE_DIR, port })

  try {
    await setScheme(app, 'light')
    const ready = await app.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const visible = (node) => !!node && node.offsetParent !== null
      const text = (node) => node?.textContent?.replace(/\s+/g, ' ').trim() || ''
      const click = (predicate, label) => {
        const button = [...document.querySelectorAll('button')].find((node) => visible(node) && predicate(node))
        if (!button) throw new Error('Missing ' + label + ': ' + [...document.querySelectorAll('button')].filter(visible).map(text).join(' | '))
        button.click()
      }

      click((node) => /settings|设置/i.test(node.title || text(node)), 'settings button')
      await sleep(250)
      click((node) => /general|通用/i.test(text(node)), 'general navigation')
      await sleep(150)
      click((node) => /Engli/.test(text(node)), 'English language')
      await sleep(200)
      click((node) => /appearance|外观/i.test(text(node)), 'appearance navigation')
      await sleep(250)

      const toggle = [...document.querySelectorAll('button[role="switch"]')]
        .find((node) => visible(node) && /follow system|跟随系统/i.test(node.getAttribute('aria-label') || ''))
      if (!toggle) throw new Error('Missing follow-system theme toggle')
      toggle.click()
      await sleep(250)

      const setSelect = (label, value) => {
        const select = [...document.querySelectorAll('select')]
          .find((node) => node.getAttribute('aria-label') === label)
        if (!select) throw new Error('Missing ' + label + ' selector')
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
        setter.call(select, value)
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
      setSelect('Light mode theme', 'morandi')
      setSelect('Dark mode theme', 'morandi-dark')
      await sleep(250)

      const settings = JSON.parse(localStorage.getItem('horsemd.settings.v1') || '{}')
      return {
        enabled: settings.themeMode === 'system',
        light: settings.systemLightTheme,
        dark: settings.systemDarkTheme,
        body: document.body.className
      }
    })()`)
    assert.deepEqual(ready, {
      enabled: true,
      light: 'morandi',
      dark: 'morandi-dark',
      body: 'light theme-morandi'
    }, `system theme settings did not apply in light mode: ${JSON.stringify(ready)}`)

    await setScheme(app, 'dark')
    const dark = await app.evaluate(`(() => ({
      body: document.body.className,
      mode: JSON.parse(localStorage.getItem('horsemd.settings.v1') || '{}').themeMode
    }))()`)
    assert.equal(dark.body, 'dark theme-morandi-dark', `dark OS preference did not apply selected dark theme: ${JSON.stringify(dark)}`)
    assert.equal(dark.mode, 'system', 'system theme mode did not persist')

    await setScheme(app, 'light')
    const light = await app.evaluate(`(() => document.body.className)()`)
    assert.equal(light, 'light theme-morandi', `light OS preference did not restore selected light theme: ${light}`)

    const manual = await app.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const button = [...document.querySelectorAll('button')]
        .find((node) => node.offsetParent !== null && /Warm Dark/.test(node.textContent || ''))
      if (!button) throw new Error('Missing manual theme swatch')
      button.click()
      await sleep(250)
      return {
        body: document.body.className,
        mode: JSON.parse(localStorage.getItem('horsemd.settings.v1') || '{}').themeMode
      }
    })()`)
    assert.deepEqual(manual, { body: 'dark', mode: 'manual' }, `manual theme did not leave system mode: ${JSON.stringify(manual)}`)

    console.log('PASS system theme UI: configured light/dark themes follow media changes and manual selection exits system mode')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
