// #154: the LapisCV résumé theme (works in Typora) rendered as an unstyled
// page in HorseMD: its rules sat behind a relative @import that never loaded,
// its icon font URL carried `?t=…`, raw `<img>` HTML showed as text, and
// bare `h2 { … }` / `p { margin: 0 }` rules lost to our more specific editor
// styles. This fixture mirrors LapisCV's structure and checks the rendered
// result through the real theme picker, plus that the file stays untouched.
import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-theme-typora-base-${process.pid}`
const port = Number(process.env.CDP_PORT || 16120 + (process.pid % 40))
const waitFor = async (check, message, attempts = 200) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}
const editor = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`

const doc = [
  '# Octocat', '',
  '<img alt="avatar" src="avatar.png">', '',
  '## Section', '',
  '<div alt="entry-title">',
  '    <h3>Company</h3>',
  '    <p>2008.03 - 2009.07</p>',
  '</div>', '',
  'Paragraph after the entry.', '',
  '- item one',
  '- item two', ''
].join('\n')

const theme = [
  '@import "lapis-like/styles/main.css";',
  ':root { --lapis-accent: rgb(72, 112, 173); }',
  "@font-face { font-family: 'HM Theme Icon'; src: url('lapis-like/fonts/icon.woff2?t=1727014108932') format('woff2'); }",
  '@media screen { #write { padding-left: 20mm; padding-right: 20mm; box-shadow: 0 0 4mm 0 #a7bbc969; } }'
].join('\n')
const main = [
  "p, li { font-family: 'HM Theme Icon', sans-serif; font-size: 13px; line-height: 1.8; }",
  'h1 { text-align: center; font-size: 21px; }',
  'h2 { color: var(--lapis-accent); font-size: 16px; }',
  'h3, p, li p { margin-top: 0; margin-bottom: 0; }',
  'img[alt="avatar"] { float: right; width: 80px; height: 80px; border-radius: 50%; }',
  'div[alt="entry-title"] { display: flex; justify-content: space-between; align-items: center; }',
  'button { letter-spacing: 7px; }'
].join('\n')
const darkTheme = ':root { --bg-color: #363b40; }\nbody { background: var(--bg-color); }\nh2 { color: rgb(200, 10, 10); }'
// 1×1 PNG.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const pickTheme = async (app, name) => {
  await app.evaluate(`[...document.querySelectorAll('.status-btn')].find((node) => node.offsetParent && /主题|Theme/i.test(node.title || node.textContent || ''))?.click()`)
  await waitFor(() => app.evaluate(`Boolean(document.querySelector('.theme-menu .block-menu-item .theme-swatch-custom'))`), 'custom themes not listed')
  const clicked = await app.evaluate(`(() => {
    const item = [...document.querySelectorAll('.theme-menu .block-menu-item')].find((node) => (node.title || '').endsWith(${JSON.stringify(name)}))
    item?.click()
    return Boolean(item)
  })()`)
  assert.ok(clicked, `theme ${name} not in the picker`)
}

await rm(root, { recursive: true, force: true })
const profileDir = join(root, 'profile')
const themes = join(profileDir, 'themes')
await mkdir(join(themes, 'lapis-like', 'styles'), { recursive: true })
await mkdir(join(themes, 'lapis-like', 'fonts'), { recursive: true })
await writeFile(join(themes, 'lapis-like.css'), theme)
await writeFile(join(themes, 'lapis-like', 'styles', 'main.css'), main)
await copyFile('node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2', join(themes, 'lapis-like', 'fonts', 'icon.woff2'))
await writeFile(join(themes, 'dark-bg.css'), darkTheme)
const file = join(root, 'resume.md')
await writeFile(file, doc, 'utf8')
await writeFile(join(root, 'avatar.png'), png)

const app = await launchBuiltElectron({ profileDir, port, appArgs: [file, '--horsemd-input-trace'], cleanProfile: false })
try {
  await waitFor(() => app.evaluate(`Boolean(${editor}?.querySelector('h2'))`), 'editor did not mount')
  await pickTheme(app, 'lapis-like.css')
  await waitFor(() => app.evaluate(`getComputedStyle(${editor}.querySelector('h2')).color === 'rgb(72, 112, 173)'`),
    'bare `h2` rule from the @import-ed file did not apply')

  const state = await app.evaluate(`(async () => {
    const ed = ${editor}
    const rect = (node) => node.getBoundingClientRect()
    const h1 = ed.querySelector('h1')
    const avatar = ed.querySelector('img[alt="avatar"]')
    if (avatar && !avatar.complete) await new Promise((resolve) => { avatar.onload = avatar.onerror = resolve })
    const entry = ed.querySelector('div[alt="entry-title"]')
    const entryParagraph = entry.closest('.hm-html-block').parentElement
    const date = entry.querySelector('p')
    const item = ed.querySelector('.milkdown-list-item-block li')
    const label = item.querySelector('.label-wrapper')
    const text = item.querySelector('.children p')
    await document.fonts.load("13px 'HM Theme Icon'")
    const button = [...document.querySelectorAll('.status-btn')].find((node) => node.offsetParent)
    return {
      h1Align: getComputedStyle(h1).textAlign,
      avatarLoaded: Boolean(avatar && avatar.naturalWidth > 0),
      avatarFloat: avatar ? getComputedStyle(avatar).float : null,
      avatarText: ed.textContent.includes('<img'),
      entryDisplay: getComputedStyle(entry).display,
      dateRightGap: rect(entry).right - rect(date).right,
      entryParagraphExtra: rect(entryParagraph).height - rect(entry).height,
      labelCenter: (rect(label).top + rect(label).bottom) / 2 - rect(text).top,
      textLine: parseFloat(getComputedStyle(text).lineHeight),
      paragraphMargin: getComputedStyle(ed.querySelector(':scope > p:not(:has(.hm-html-block))')).marginTop,
      writePaddingLeft: parseFloat(getComputedStyle(ed).paddingLeft),
      defaultBg: document.body.classList.contains('hm-theme-default-bg'),
      pageBg: getComputedStyle(ed.closest('.editor-scroll')).backgroundColor,
      iconFont: [...document.fonts].some((face) => face.family.replace(/["']/g, '') === 'HM Theme Icon' && face.status === 'loaded'),
      chromeLetterSpacing: button ? getComputedStyle(button).letterSpacing : 'normal',
      dirty: Boolean(document.querySelector('.tab.active .tab-dirty, .tab.active.dirty'))
    }
  })()`)
  console.log(JSON.stringify(state))
  assert.equal(state.h1Align, 'center', 'imported h1 rule')
  assert.ok(state.avatarLoaded && !state.avatarText, 'raw <img> renders (relative src resolved), not as text')
  assert.equal(state.avatarFloat, 'right', 'img[alt="avatar"] styled by the theme')
  assert.equal(state.entryDisplay, 'flex', 'div[alt="entry-title"] keeps its alt attribute and theme layout')
  assert.ok(Math.abs(state.dateRightGap) <= 1, `date sits at the right edge (gap ${state.dateRightGap})`)
  assert.ok(Math.abs(state.entryParagraphExtra) <= 1, `raw-HTML block adds no empty line (${state.entryParagraphExtra}px)`)
  assert.ok(state.labelCenter > 0 && state.labelCenter < state.textLine, `bullet sits on the first text line (${state.labelCenter} of ${state.textLine})`)
  assert.equal(state.paragraphMargin, '0px', 'theme `p { margin: 0 }` beats our paragraph spacing')
  assert.ok(Math.abs(state.writePaddingLeft - 75.59) < 1, `theme #write padding applies (${state.writePaddingLeft})`)
  assert.ok(state.defaultBg && state.pageBg === 'rgb(255, 255, 255)', 'a theme without a background gets Typora\'s white page')
  assert.ok(state.iconFont, 'font URL with ?t= query loads')
  assert.notEqual(state.chromeLetterSpacing, '7px', 'theme element rules stay out of the app chrome')
  assert.equal(state.dirty, false, 'theme rendering does not dirty the document')

  await pickTheme(app, 'dark-bg.css')
  await waitFor(() => app.evaluate(`getComputedStyle(${editor}.querySelector('h2')).color === 'rgb(200, 10, 10)'`), 'second theme did not apply')
  const dark = await app.evaluate(`({ defaultBg: document.body.classList.contains('hm-theme-default-bg'), pageBg: getComputedStyle(document.body).backgroundColor })`)
  assert.equal(dark.defaultBg, false, 'a theme with its own body background keeps it')
  assert.equal(dark.pageBg, 'rgb(54, 59, 64)', 'theme body background shows')

  assert.equal(await readFile(file, 'utf8'), doc, 'file on disk unchanged')
  const toasts = await app.evaluate(`[...document.querySelectorAll('.toast, .hm-toast')].map((node) => node.textContent).join(' | ')`)
  assert.ok(!/不一致|mismatch/i.test(toasts), `no source mismatch toast: ${toasts}`)
  console.log('PASS custom theme Typora base: @import + ?t= font load, bare element rules win, raw <img>, compact HTML blocks, outside bullets, white default page, chrome untouched')
} finally {
  await stopBuiltElectron(app)
  await rm(root, { recursive: true, force: true })
}
