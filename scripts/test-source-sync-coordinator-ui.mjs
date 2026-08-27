import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-source-sync-coordinator-ui-${process.pid}`
const file = join(root, 'coordinator.md')
const port = Number(process.env.CDP_PORT || 10218)
const source = '# Coordinator\n\nalpha\n\n- dash\n'
const expected = '# Coordinator\n\nalphaX\n\n- dash\n'

async function waitFor(check, message, attempts = 120) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...point,
    button: 'left',
    clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...point,
    button: 'left',
    clickCount: 1
  })
}

async function clickTextEnd(evaluate, send, text) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)
    const paragraph = [...(editor?.querySelectorAll('p') || [])]
      .find((node) => node.textContent === ${JSON.stringify(text)})
    if (!paragraph) return null
    const rect = paragraph.getBoundingClientRect()
    return {
      x: Math.max(rect.left + 4, rect.right - 2),
      y: rect.top + rect.height / 2
    }
  })()`)
  assert.ok(point, `missing paragraph: ${text}`)
  await click(send, point)
  await pressKey(send, { key: 'End', code: 'End', delayMs: 25 })
}

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
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
    appArgs: [file]
  })
  await waitFor(
    () => app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')]
        .find((node) => node.offsetParent)
      return editor?.dataset.horsemdReady === 'true' && editor.textContent.includes('alpha')
    })()`),
    'coordinator fixture did not mount'
  )
  return app
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, source)

  let app
  try {
    app = await openApp('profile-1', port)
    const { evaluate, send } = app
    await evaluate(`(() => {
      window.__hmSourceSyncCoordinatorTrace = []
      window.__hmSourceIntegrityTrace = []
      window.__hmSourceIntegrityDiffTrace = []
    })()`)

    await clickTextEnd(evaluate, send, 'alpha')
    await typeTextLikeUser(send, 'X', { delayMs: 35 })

    const publication = await waitFor(
      async () => {
        const trace = await evaluate(`window.__hmSourceSyncCoordinatorTrace || []`)
        return trace.find((entry) =>
          entry.phase === 'published' &&
          entry.boundary === 'markdown-updated' &&
          entry.owner === 'legacy' &&
          entry.family === 'legacy-preservation'
        ) || null
      },
      'ordinary markdownUpdated did not publish through SourceSyncCoordinator'
    )
    assert.ok(publication.revision >= 1)
    assert.notEqual(publication.reason, 'source-sync-candidate-invalid')

    const integrityFailures = await evaluate(`
      (window.__hmSourceIntegrityTrace || []).filter((entry) => entry?.ok === false)
    `)
    assert.equal(
      integrityFailures.length,
      0,
      `ordinary coordinator publication had first-divergence integrity failures: ${JSON.stringify(integrityFailures)}`
    )
    assert.equal((await warningToasts(evaluate)).length, 0, 'ordinary coordinator publication showed a warning toast')

    assert.equal(await toggleSource(evaluate), true, 'could not switch coordinator fixture to source mode')
    const actualSource = await waitFor(() => visibleSource(evaluate), 'coordinator source textarea did not appear')
    assert.equal(actualSource, expected)
    assert.equal(await toggleSource(evaluate), true, 'could not return coordinator fixture to rich mode')

    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'coordinator save button did not appear')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'coordinator save did not finish')
    assert.equal(await readFile(file, 'utf8'), expected, 'coordinator publication did not reach disk exactly')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('profile-2', port + 1)
    assert.equal(await toggleSource(app.evaluate), true, 'could not open source after coordinator cold reopen')
    const reopenedSource = await waitFor(() => visibleSource(app.evaluate), 'coordinator reopened source missing')
    assert.equal(reopenedSource, expected)

    console.log('PASS source sync coordinator UI: ordinary markdownUpdated publishes one legacy candidate through the coordinator; source, save, and cold reopen are exact')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
