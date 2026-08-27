import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const port = Number(process.env.CDP_PORT || 9696)
const template = join(process.cwd(), 'scripts', 'fixtures', 'frontmatter-edit.md')
const root = `/tmp/horsemd-frontmatter-edit-ui-${process.pid}`
const fixture = join(root, 'frontmatter-edit.md')

async function waitFor(check, message, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const warningToasts = (evaluate) => evaluate(`
  [...document.querySelectorAll('[class*="toast"]')]
    .map((node) => node.textContent || '')
    .filter((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused|rich text.*source/i.test(text))
`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [fixture]
  })
  await waitFor(
    () => app.evaluate(`!![...document.querySelectorAll('.hm-frontmatter-wrap')].find((node) => node.offsetParent)`),
    'frontmatter card did not render in rich mode'
  )
  return app
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(fixture, await readFile(template))

  let app
  try {
    app = await openApp('profile-1', port)
    const { evaluate } = app
    await evaluate(`(() => {
      window.__hmSourceSyncCoordinatorTrace = []
      window.__hmSourceIntegrityTrace = []
      window.__hmSourceIntegrityDiffTrace = []
    })()`)
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
    const publication = await waitFor(async () => {
      const trace = await evaluate(`window.__hmSourceSyncCoordinatorTrace || []`)
      return trace.find((entry) =>
        entry.phase === 'published' &&
        entry.boundary === 'frontmatter-value-change' &&
        entry.owner === 'legacy' &&
        entry.family === 'legacy-preservation' &&
        entry.reason === 'frontmatter-block-change'
      ) || null
    }, 'frontmatter node-view publication bypassed SourceSyncCoordinator')
    assert.ok(publication.revision >= 1)

    assert.equal(await evaluate(`(() => {
      const card = [...document.querySelectorAll('.hm-frontmatter-wrap')].find((node) => node.offsetParent)
      card?.querySelector('.hm-frontmatter-action')?.click()
      return card?.textContent.includes('publish') && card?.textContent.includes('Edited in rich mode')
    })()`), true, 'frontmatter card did not render its edited YAML')

    const integrityFailures = await evaluate(`
      (window.__hmSourceIntegrityTrace || []).filter((entry) => entry?.ok === false)
    `)
    assert.equal(
      integrityFailures.length,
      0,
      `frontmatter publication had first-divergence failures: ${JSON.stringify(integrityFailures)}`
    )
    assert.equal((await warningToasts(evaluate)).length, 0, 'frontmatter publication showed a warning toast')

    assert.equal(await toggleSource(evaluate), true, 'could not switch to source mode')
    const source = await waitFor(
      () => visibleSource(evaluate),
      'source editor did not open after YAML edit'
    )
    assert.match(source, /^---\nname: publish\ndescription: Edited in rich mode\n---/)
    assert.match(source, /# Frontmatter fixture/)

    assert.equal(await toggleSource(evaluate), true, 'could not return to rich mode before frontmatter save')
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'frontmatter save button did not appear')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'frontmatter save did not finish')
    assert.equal(await readFile(fixture, 'utf8'), source, 'frontmatter Coordinator publication did not reach disk exactly')

    await stopBuiltElectron(app, { removeProfile: true })
    app = null
    app = await openApp('profile-2', port + 1)
    const reopenedCard = await app.evaluate(`(() => {
      const card = [...document.querySelectorAll('.hm-frontmatter-wrap')].find((node) => node.offsetParent)
      return card?.textContent || ''
    })()`)
    assert.match(reopenedCard, /publish/)
    assert.match(reopenedCard, /Edited in rich mode/)
    assert.equal(await toggleSource(app.evaluate), true, 'could not open source after frontmatter cold reopen')
    const reopenedSource = await waitFor(
      () => visibleSource(app.evaluate),
      'frontmatter cold-reopen source did not appear'
    )
    assert.equal(reopenedSource, source, 'frontmatter source changed after cold reopen')

    console.log('PASS frontmatter UI: node-view publication uses SourceSyncCoordinator; source, save, and cold reopen are exact')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
