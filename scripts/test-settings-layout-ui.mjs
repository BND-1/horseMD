import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, mobileClass: false },
  { name: 'narrow', width: 820, height: 720, mobileClass: false },
  { name: 'mobile', width: 390, height: 844, mobileClass: true }
]

const THEMES = [
  { id: 'light', body: ['light'] },
  { id: 'dark', body: ['dark'] },
  { id: 'morandi', body: ['light', 'theme-morandi'] },
  { id: 'morandi-rose', body: ['light', 'theme-morandi-rose'] },
  { id: 'morandi-blue', body: ['light', 'theme-morandi-blue'] },
  { id: 'morandi-dark', body: ['dark', 'theme-morandi-dark'] }
]

async function main() {
  const app = await launchBuiltElectron({
    profileDir: '/tmp/horsemd-settings-layout-ui',
    port: 9448
  })

  try {
    const failures = []
    for (const viewport of VIEWPORTS) {
      await app.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false
      })
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
        const settingsButton = buttons().find((button) =>
          button.title === '设置' || button.title === 'Settings' || textOf(button) === '设置' || textOf(button) === 'Settings'
        )
        if (!settingsButton) throw new Error('Missing settings button')
        settingsButton.click()
        await sleep(300)
        const keyboard = buttons().find((button) => ['键盘快捷键', 'Keyboard'].includes(textOf(button)))
        if (keyboard) {
          keyboard.click()
          await sleep(180)
        }
        return true
      })()`)

      for (const theme of THEMES) {
        const result = await app.evaluate(`(() => {
          const viewport = ${JSON.stringify(viewport)}
          const theme = ${JSON.stringify(theme)}
          const failures = []
          const app = document.querySelector('.app')
          if (app) {
            app.classList.toggle('is-mobile', viewport.mobileClass)
          }
          const managed = [...document.body.classList].filter((name) => name.startsWith('hm-'))
          document.body.className = [...theme.body, ...managed].join(' ')
          document.documentElement.style.overflowX = ''
          document.body.style.overflowX = ''

          const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect()
          const visible = (element) => {
            if (!element) return false
            const box = element.getBoundingClientRect()
            const style = getComputedStyle(element)
            return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
          }
          const assertWithinViewport = (selector, label) => {
            const element = document.querySelector(selector)
            if (!visible(element)) {
              failures.push(label + ' is not visible')
              return
            }
            const box = element.getBoundingClientRect()
            if (box.left < -2 || box.right > window.innerWidth + 2) {
              failures.push(label + ' exceeds viewport: ' + JSON.stringify({
                left: Math.round(box.left),
                right: Math.round(box.right),
                width: Math.round(box.width),
                viewport: window.innerWidth
              }))
            }
          }
          const overflowAllowance = viewport.mobileClass ? 4 : 2
          const documentOverflow = Math.max(
            document.documentElement.scrollWidth - window.innerWidth,
            document.body.scrollWidth - window.innerWidth
          )
          if (documentOverflow > overflowAllowance) {
            failures.push('global horizontal overflow ' + documentOverflow)
          }

          assertWithinViewport('.settings-page', 'settings page')
          assertWithinViewport('.settings-sections', 'settings sections')
          assertWithinViewport('.settings-shortcut-search', 'shortcut search')

          const navBox = rect('.settings-nav')
          if (!navBox || navBox.width < 48) failures.push('settings nav is collapsed')
          if (!viewport.mobileClass && navBox?.right > window.innerWidth + 2) {
            failures.push('desktop nav exceeds viewport')
          }

          const rows = [...document.querySelectorAll('.settings-shortcut-row')].filter(visible)
          if (!rows.length) failures.push('no shortcut rows visible')
          for (const row of rows.slice(0, 8)) {
            const box = row.getBoundingClientRect()
            if (box.right > window.innerWidth + 2) {
              failures.push('shortcut row exceeds viewport: ' + Math.round(box.right))
              break
            }
          }

          const controls = [...document.querySelectorAll('.settings-shortcut-controls')].filter(visible)
          for (const controlsBox of controls.slice(0, 8).map((node) => node.getBoundingClientRect())) {
            if (controlsBox.right > window.innerWidth + 2) {
              failures.push('shortcut controls exceed viewport: ' + Math.round(controlsBox.right))
              break
            }
          }

          const activeNav = document.querySelector('.settings-nav-item.active')
          if (!activeNav) failures.push('active nav is missing')
          const searchHeight = rect('.settings-shortcut-search')?.height || 0
          if (searchHeight < 24) failures.push('search input height is too small: ' + searchHeight)

          return {
            viewport: viewport.name,
            theme: theme.id,
            width: window.innerWidth,
            appClass: app?.className || '',
            bodyClass: document.body.className,
            failures
          }
        })()`)
        for (const failure of result.failures) {
          failures.push(`${result.viewport}/${result.theme}: ${failure}`)
        }
      }
    }

    if (failures.length) {
      throw new Error('Settings layout failures:\\n' + failures.join('\\n'))
    }
    console.log(`settings layout UI ok: ${VIEWPORTS.length} viewports x ${THEMES.length} themes`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
