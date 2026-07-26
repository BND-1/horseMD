import assert from 'node:assert/strict'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const port = Number(process.env.CDP_PORT || 9696)
const fixture = join(process.cwd(), 'scripts', 'fixtures', 'frontmatter-edit.md')

async function waitFor(check, message, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

async function main() {
  const app = await launchBuiltElectron({
    profileDir: `/tmp/horsemd-frontmatter-edit-ui-${process.pid}`,
    port,
    appArgs: [fixture]
  })
  const { evaluate } = app

  try {
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.hm-frontmatter-wrap')].find((node) => node.offsetParent)`),
      'frontmatter card did not render in rich mode'
    )
    assert.equal(await evaluate(`(() => {
      const card = [...document.querySelectorAll('.hm-frontmatter-wrap')].find((node) => node.offsetParent)
      return card?.textContent.includes('deploy') && !!card.querySelector('.hm-frontmatter-action')
    })()`), true, 'frontmatter card did not expose the editable rich-mode control')

    assert.equal(await evaluate(`(() => {
      const card = [...document.querySelectorAll('.hm-frontmatter-wrap')].find((node) => node.offsetParent)
      card?.querySelector('.hm-frontmatter-action')?.click()
      return !!card?.querySelector('.hm-frontmatter-input')
    })()`), true, 'frontmatter edit action did not enter edit mode')

    assert.equal(await evaluate(`(() => {
      const input = [...document.querySelectorAll('.hm-frontmatter-input')].find((node) => node.offsetParent)
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(input, 'name: publish\\ndescription: Edited in rich mode')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`), true, 'could not update frontmatter textarea')
    await sleep(180)

    assert.equal(await evaluate(`(() => {
      const card = [...document.querySelectorAll('.hm-frontmatter-wrap')].find((node) => node.offsetParent)
      card?.querySelector('.hm-frontmatter-action')?.click()
      return card?.textContent.includes('publish') && card?.textContent.includes('Edited in rich mode')
    })()`), true, 'frontmatter card did not render its edited YAML')

    assert.equal(await evaluate(`(() => {
      const button = [...document.querySelectorAll('.status-btn')]
        .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\//.test(node.title || node.textContent || ''))
      button?.click()
      return !!button
    })()`), true, 'could not switch to source mode')
    const source = await waitFor(
      () => evaluate(`[...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value || null`),
      'source editor did not open after YAML edit'
    )
    assert.match(source, /^---\nname: publish\ndescription: Edited in rich mode\n---/)
    assert.match(source, /# Frontmatter fixture/)

    console.log('PASS frontmatter UI: card edit, render refresh, and Markdown round-trip')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
