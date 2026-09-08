// E2E (P8b regression): the editor's lazy chunk injects Crepe stylesheets
// (tables.css, code-mirror.css, …) into <head> at runtime — AFTER the custom
// theme style was appended at startup. Equal-specificity ties then resolved
// to the later sheet and the user's custom CSS "stopped working" (reported
// against tables.css). The fix keeps the owned styles (#hm-custom-theme,
// #hm-user-css) as the tail of <head> via a MutationObserver installed by
// customThemes.js.
//
// Real path: the theme css is scanned from the profile's themes/ dir and
// activated by clicking the StatusBar theme picker (the app itself calls
// applyCustomTheme). The regression direction — a stylesheet arriving AFTER
// the theme — is reproduced by appending one more sheet afterwards, exactly
// like a lazily loaded chunk css would.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-theme-order-${process.pid}`
const port = Number(process.env.CDP_PORT || 15985 + (process.pid % 20))

const waitFor = async (check, message, attempts = 200) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}
const visibleEditor = () => `(() => [...document.querySelectorAll('.ProseMirror')]
  .find((node) => node.offsetParent))()`

const doc = [
  '# 自定义主题样式顺序回归', '',
  '| 列A | 列B |', '| --- | --- |', '| 甲 | 乙 |', ''
].join('\n')

// Typora-style theme: `#write` hooks (the content element carries them) with a
// table rule whose specificity ties with Crepe's `.milkdown table` rules — a
// tie, so ORDER alone decides the winner.
const themeCss = [
  '#write table { background: rgb(255, 208, 208); }',
  '#write table th, #write table td { border: 1px solid rgb(200, 0, 0); }'
].join('\n')

const main = async () => {
  await rm(root, { recursive: true, force: true })
  const dir = join(root, 'd')
  const profileDir = join(dir, 'p')
  const themesDir = join(profileDir, 'themes')
  const file = join(dir, 'doc.md')
  await mkdir(themesDir, { recursive: true })
  await writeFile(file, doc, 'utf8')
  await writeFile(join(themesDir, 'ordertheme.css'), themeCss, 'utf8')

  // cleanProfile defaults to true and would wipe the themes/ dir we just
  // wrote — the root is freshly created above, so no cleanup is needed.
  const app = await launchBuiltElectron({ profileDir, port, appArgs: [file], cleanProfile: false })
  try {
    // First boot: editor mounts, Crepe's stylesheets are all in <head>.
    await waitFor(() => app.evaluate(`Boolean(${visibleEditor}())`), 'editor did not mount')
    await waitFor(() => app.evaluate(`Boolean(document.querySelector('.ProseMirror table'))`), 'table did not render')

    // Activate through the real UI: OPEN the StatusBar theme sheet first —
    // the custom swatches only render inside it — then click our theme.
    const opened = await app.evaluate(`(() => {
      const button = [...document.querySelectorAll('.status-btn')]
        .find((node) => node.offsetParent && /主题|Theme/i.test(node.title || node.textContent || ''))
      button?.click()
      return Boolean(button)
    })()`)
    if (opened !== true) throw new Error('status bar theme button not found')
    // The status-bar theme popover lists custom themes as .block-menu-item
    // rows carrying a .theme-swatch-custom icon and the file name as title.
    await waitFor(() => app.evaluate(`Boolean(document.querySelector('.theme-menu .block-menu-item .theme-swatch-custom'))`),
      'custom theme not listed in the picker')
    const clicked = await app.evaluate(`(() => {
      const item = [...document.querySelectorAll('.theme-menu .block-menu-item')]
        .find((node) => (node.title || '').endsWith('ordertheme.css'))
      item?.click()
      return Boolean(item)
    })()`)
    if (clicked !== true) throw new Error('custom theme item not clickable')

    await waitFor(() => app.evaluate(`(() => {
      const style = document.getElementById('hm-custom-theme')
      return Boolean(style && style.textContent.includes('#write table'))
    })()`), 'custom theme style never activated')

    // The theme must already win over Crepe's (earlier) stylesheets.
    const before = await app.evaluate(`(() => {
      const table = document.querySelector('.ProseMirror table')
      return table ? getComputedStyle(table).backgroundColor : null
    })()`)
    if (before !== 'rgb(255, 208, 208)') {
      throw new Error(`theme table rule did not apply: ${before}`)
    }

    // Regression direction: a stylesheet appended AFTER the theme (any lazily
    // loaded chunk css) with the SAME specificity must not steal the win.
    await app.evaluate(`(() => {
      const foreign = document.createElement('style')
      foreign.id = 'order-foreign-style'
      foreign.textContent = '#write table { background: rgb(0, 0, 255); }'
      document.head.appendChild(foreign)
      return true
    })()`)
    await sleep(400)

    const state = await app.evaluate(`(() => {
      const head = document.head
      const table = document.querySelector('.ProseMirror table')
      const style = document.getElementById('hm-custom-theme')
      const foreign = document.getElementById('order-foreign-style')
      const order = [...head.children].map((n) => n.id || n.tagName)
      return {
        styleIsLast: head.lastElementChild === style,
        customAfterForeign: style && foreign && order.indexOf('hm-custom-theme') > order.indexOf('order-foreign-style'),
        computed: table ? getComputedStyle(table).backgroundColor : null
      }
    })()`)
    if (!state.customAfterForeign) {
      throw new Error(`late stylesheet still overrides the custom theme: ${JSON.stringify(state)}`)
    }
    if (state.computed !== 'rgb(255, 208, 208)') {
      throw new Error(`equal-specificity tie lost to the later stylesheet: ${JSON.stringify(state)}`)
    }

    await rm(root, { recursive: true, force: true })
    console.log('PASS custom theme style order UI: stylesheets arriving after the custom theme can no longer override it; the observer keeps the owned style at the head tail')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

main().catch(async (error) => {
  console.error(error.message || error)
  await rm(root, { recursive: true, force: true })
  process.exit(1)
})
