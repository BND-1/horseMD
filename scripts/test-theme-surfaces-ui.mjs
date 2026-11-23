// Theme surfaces (user report 2026-11-23): Crepe painted the area around a
// code block (language row, toolbar, padding) with one fixed warm white /
// brown, a cream or brown slab on the Morandi themes. In every built-in
// theme: the code block lets the page show through, and Crepe's floating
// panels (selection toolbar, slash menu, table handles) use the theme's own
// panel colours (--popover-bg, --hover-elevated).
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = await fs.mkdtemp(join(tmpdir(), 'horsemd-theme-surfaces-'))
const file = join(root, 'doc.md')
await fs.writeFile(file, ['# 主题', '', '正文。', '', '```js', 'const a = 1', '```', ''].join('\n'))
const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port: 9790 + Math.floor(Math.random() * 30), appArgs: [file] })
const THEMES = [['light', ''], ['dark', ''], ['light', 'theme-morandi'], ['light', 'theme-morandi-rose'], ['light', 'theme-morandi-blue'], ['dark', 'theme-morandi-dark']]

try {
  for (let i = 0; i < 80; i++) {
    if (await app.evaluate(`Boolean([...document.querySelectorAll('.milkdown-code-block')].find((n) => n.offsetParent))`)) break
    await sleep(150)
  }
  await sleep(500)
  for (const [base, cls] of THEMES) {
    const got = await app.evaluate(`(() => {
      document.body.classList.remove('light', 'dark', 'theme-morandi', 'theme-morandi-rose', 'theme-morandi-blue', 'theme-morandi-dark')
      document.body.classList.add(${JSON.stringify(base)})
      ${cls ? `document.body.classList.add(${JSON.stringify(cls)})` : ''}
      const block = [...document.querySelectorAll('.milkdown-code-block')].find((n) => n.offsetParent)
      const milkdown = block.closest('.milkdown')
      // Resolve a colour expression to rgb() on a probe inside .milkdown.
      const probe = document.createElement('div')
      milkdown.appendChild(probe)
      const rgb = (value) => { probe.style.color = value; return getComputedStyle(probe).color }
      const out = {
        block: getComputedStyle(block).backgroundColor,
        surface: rgb('var(--crepe-color-surface)'),
        popover: rgb('var(--popover-bg)'),
        surfaceLow: rgb('var(--crepe-color-surface-low)'),
        hoverElevated: rgb('var(--hover-elevated)')
      }
      probe.remove()
      return out
    })()`)
    const name = cls || base
    assert.equal(got.block, 'rgba(0, 0, 0, 0)', `${name}: the code block lets the page show through`)
    assert.equal(got.surface, got.popover, `${name}: Crepe's panels use the theme's panel colour`)
    assert.equal(got.surfaceLow, got.hoverElevated, `${name}: and its raised tone`)
    console.log(`  ✓ ${name}`)
  }
  console.log('PASS theme surfaces: code blocks show the page in every built-in theme; Crepe panels follow the theme')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await fs.rm(root, { recursive: true, force: true })
}
