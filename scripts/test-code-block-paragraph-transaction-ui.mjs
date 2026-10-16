import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-code-block-paragraph-transaction-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 15020 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

const fixture = '\uFEFFbefore\r\n\r\n~~~js\r\nalpha\r\n~~~\r\n\r\nafter\r\n'
const expected = '\uFEFFbefore\r\n\r\nalphaxy\r\n\r\nafter\r\n'
const expectedTextarea = expected.replace(/\r\n/g, '\n')
const rejectedFixture = '\uFEFFbefore\r\n\r\n~~~md\r\n# heading\r\n~~~\r\n\r\nafter\r\n'
const scenarios = [
  { name: 'code-paragraph-callback', immediateSourceToggle: false },
  { name: 'code-paragraph-forced-flush', immediateSourceToggle: true }
]

const waitFor = async (check, message, attempts = 180) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const visibleEditor = () => `(() => [...document.querySelectorAll('.ProseMirror')]
  .find((node) => node.offsetParent))()`

const openApp = async ({
  file,
  profile,
  port,
  expectedMode,
  expectedCodeText = 'alpha'
}) => {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  try {
    await waitFor(
      () => app.evaluate(`(() => {
        const editor = ${visibleEditor()}
        if (!editor) return false
        const code = [...editor.querySelectorAll('.milkdown-code-block .cm-content')]
          .find((node) => node.offsetParent)
        const paragraphs = [...editor.children]
          .filter((node) => node.tagName === 'P' && node.offsetParent)
          .map((node) => node.textContent || '')
        return ${JSON.stringify(expectedMode)} === 'code'
          ? code?.textContent === ${JSON.stringify(expectedCodeText)}
          : !code && JSON.stringify(paragraphs) ===
            JSON.stringify(['before', 'alphaxy', 'after'])
      })()`),
      `${expectedMode} editor did not mount for ${profile}`
    )
    await sleep(450)
    return app
  } catch (error) {
    await stopBuiltElectron(app, { removeProfile: true })
    throw error
  }
}

const clearDiagnostics = (app) => app.evaluate(`(() => {
  window.__hmPreserveLog = []
  window.__hmSourceIntegrityTrace = []
  window.__hmSourceIntegrityDiffTrace = []
  window.__hmSourceSyncCoordinatorTrace = []
  window.__hmSourceSyncTransactionJournalTrace = []
  window.__hmCodeBlockTransactionTrace = []
  window.__hmFlushTrace = []
})()`)

const codeLinePoint = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  const line = [...(editor?.querySelectorAll('.milkdown-code-block .cm-line') || [])]
    .filter((node) => node.offsetParent)
    .at(-1)
  const rect = line?.getBoundingClientRect()
  return rect ? {
    x: Math.max(rect.left + 3, rect.right - 3),
    y: (rect.top + rect.bottom) / 2
  } : null
})()`)

const focusCodeEnd = async (app) => {
  const point = await waitFor(() => codeLinePoint(app), 'code line endpoint missing')
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: point.x, y: point.y
  })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y,
    button: 'left', buttons: 1, clickCount: 1
  })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y,
    button: 'left', buttons: 0, clickCount: 1
  })
  await pressKey(app.send, { key: 'End', code: 'End', delayMs: 25 })
  return point
}

const openBlockContextMenu = async (app, point) => {
  const consumed = await app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const target = [...(editor?.querySelectorAll('.milkdown-code-block .cm-line') || [])]
      .filter((node) => node.offsetParent)
      .at(-1)
    if (!target) return false
    return target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: ${point.x},
      clientY: ${point.y},
      button: 2,
      buttons: 2
    })) === false
  })()`)
  assert.equal(consumed, true, 'code block contextmenu was not consumed')
  await waitFor(() => app.evaluate(`(() => {
    const menu = [...document.querySelectorAll('.block-ctxmenu')]
      .find((node) => {
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return rect.width > 0 && rect.height > 0 &&
          style.display !== 'none' && style.visibility !== 'hidden'
      })
    return Boolean(menu)
  })()`), 'block context menu did not open')
}

const blockSubmenuTrigger = (app) => app.evaluate(`(() => {
  const node = [...document.querySelectorAll('[data-context-submenu-trigger="block"]')]
    .find((candidate) => {
      const rect = candidate.getBoundingClientRect()
      const style = getComputedStyle(candidate)
      return rect.width > 0 && rect.height > 0 &&
        style.display !== 'none' && style.visibility !== 'hidden'
    })
  const rect = node?.getBoundingClientRect()
  return rect ? {
    x: (rect.left + rect.right) / 2,
    y: (rect.top + rect.bottom) / 2
  } : null
})()`)

const paragraphMenuCandidate = (app) => app.evaluate(`(() => {
  const nodes = [...document.querySelectorAll('[data-context-submenu="block"] .block-menu-item')]
  const node = nodes.find((candidate) => {
    const rect = candidate.getBoundingClientRect()
    const style = getComputedStyle(candidate)
    const short = candidate.querySelector('.block-menu-short')?.textContent?.trim()
    return short === '¶' && rect.width > 0 && rect.height > 0 &&
      style.display !== 'none' && style.visibility !== 'hidden'
  })
  const rect = node?.getBoundingClientRect()
  if (!rect) return null
  const x = (rect.left + rect.right) / 2
  const y = (rect.top + rect.bottom) / 2
  const hit = document.elementFromPoint(x, y)
  return {
    x,
    y,
    text: (node.textContent || '').trim(),
    rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
    viewport: { width: innerWidth, height: innerHeight },
    hitWithin: Boolean(hit && node.contains(hit)),
    hit: hit ? {
      tag: hit.tagName,
      className: hit.className || '',
      text: (hit.textContent || '').trim()
    } : null
  }
})()`)

const chooseParagraph = async (app) => {
  const trigger = await waitFor(() => blockSubmenuTrigger(app), 'block submenu trigger missing')
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: trigger.x, y: trigger.y, button: 'none'
  })
  const candidate = await waitFor(
    () => paragraphMenuCandidate(app),
    'paragraph menu item did not become visible'
  )
  assert.equal(candidate.hitWithin, true,
    `paragraph menu coordinate is obscured: ${JSON.stringify(candidate)}`)
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: candidate.x, y: candidate.y, button: 'none'
  })
  await sleep(80)
  const clicked = await app.evaluate(`(() => {
    const hit = document.elementFromPoint(${candidate.x}, ${candidate.y})
    const button = hit?.closest?.('button.block-menu-item')
    if (!button || !button.querySelector('.block-menu-short')?.textContent?.includes('¶')) {
      return false
    }
    button.click()
    return true
  })()`)
  assert.equal(clicked, true,
    `paragraph menu button was not clickable: ${JSON.stringify(candidate)}`)
  return candidate
}

const focusParagraphEnd = async (app, text) => {
  const point = await waitFor(() => app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const paragraph = [...(editor?.children || [])]
      .find((node) => node.tagName === 'P' && node.offsetParent &&
        (node.textContent || '') === ${JSON.stringify(text)})
    if (!paragraph) return null
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    const rect = range.getBoundingClientRect()
    const fallback = paragraph.getBoundingClientRect()
    const target = rect.width && rect.height ? rect : fallback
    return {
      x: Math.max(target.left + 3, target.right - 3),
      y: (target.top + target.bottom) / 2
    }
  })()`), `paragraph endpoint missing for ${text}`)
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: point.x, y: point.y
  })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y,
    button: 'left', buttons: 1, clickCount: 1
  })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y,
    button: 'left', buttons: 0, clickCount: 1
  })
  await pressKey(app.send, { key: 'End', code: 'End', delayMs: 25 })
}

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(
      node.title || node.textContent || ''
    ))
  button?.click()
  return Boolean(button)
})()`)

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const snapshot = (app) => app.evaluate(`(() => {
  const editor = ${visibleEditor()}
  return {
    paragraphs: [...(editor?.children || [])]
      .filter((node) => node.tagName === 'P' && node.offsetParent)
      .map((node) => node.textContent || ''),
    codeBlockCount: [...(editor?.querySelectorAll('.milkdown-code-block') || [])]
      .filter((node) => node.offsetParent).length,
    saveVisible: Boolean(document.querySelector('.hm-save-fab')),
    preserve: (window.__hmPreserveLog || []).slice(-100)
      .map(({ source, previous, next, markdown, ...entry }) => entry),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-100).map((entry) => ({
      ok: entry.ok,
      semanticOk: entry.semanticOk,
      listSlotsMatch: entry.listSlotsMatch,
      preservationReason: entry.preservationReason,
      validationSite: entry.validationSite
    })),
    semanticDiff: (window.__hmSourceIntegrityDiffTrace || []).slice(-20),
    coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-100),
    journal: (window.__hmSourceSyncTransactionJournalTrace || []).slice(-180),
    owner: (window.__hmCodeBlockTransactionTrace || []).slice(-180),
    flush: (window.__hmFlushTrace || []).slice(-100),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || '')
  }
})()`)

const assertDocument = (state, label) => {
  assert.deepEqual(state.paragraphs, ['before', 'alphaxy', 'after'],
    `${label} paragraphs: ${JSON.stringify(state)}`)
  assert.equal(state.codeBlockCount, 0, `${label} retained a code block`)
}

const assertSource = (source, label) => {
  assert.equal(source, expectedTextarea, `${label} source mismatch`)
  assert.equal(source.charCodeAt(0), 0xFEFF, `${label} lost BOM`)
  assert.equal(source.includes('\r'), false, `${label} textarea exposed CR bytes`)
  assert.equal(source.includes('~~~'), false, `${label} retained tilde fences`)
  assert.equal(source.includes('```'), false, `${label} retained backtick fences`)
  assert.equal(source.endsWith('alphaxy\n\nafter\n'), true)
}

const assertPublication = (state, scenario, boundary) => {
  assertDocument(state, scenario.name)
  assert.equal(state.integrity.some((entry) => entry.ok === false), false,
    `${scenario.name} integrity failure: ${JSON.stringify(state.integrity)}`)
  assert.deepEqual(state.semanticDiff, [], `${scenario.name} semantic diff`)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), false)
  const preservation = state.preserve.find((entry) =>
    entry.reason === 'code-block-converted-to-paragraph' &&
    entry.preserved === true &&
    entry.integrityProof?.kind === 'transaction-code-block-paragraph-proof'
  )
  assert.ok(preservation,
    `${scenario.name} missing focused owner: ${JSON.stringify(state.preserve)}`)
  const proof = preservation.integrityProof
  assert.equal(proof.family, 'code-block-to-paragraph')
  assert.equal(proof.topLevelIndex, 1)
  assert.deepEqual(proof.nodePath, [1])
  assert.equal(proof.previousLanguage, 'js')
  assert.equal(proof.previousText, 'alpha')
  assert.equal(proof.finalText, 'alphaxy')
  assert.equal(proof.conversionStep.name, 'ReplaceAroundStep')
  assert.equal(proof.conversionStep.structure, true)
  assert.equal(proof.textSteps.length, 2)
  assert.equal(proof.stepCount, 3)
  assert.equal(proof.sourceRange.marker, '~')
  assert.equal(proof.sourceRange.info, 'js')
  assert.equal(proof.sourceRange.eol, '\r\n')
  assert.equal(proof.transactionJournal?.stepCount, 3)
  assert.equal(state.integrity.some((entry) =>
    entry.preservationReason === 'code-block-converted-to-paragraph' &&
    entry.semanticOk === true && entry.listSlotsMatch === true && entry.ok === true
  ), true, `${scenario.name} missing full integrity success`)
  const publications = state.coordinator.filter((entry) =>
    entry.phase === 'published' && entry.owner === 'transaction' &&
    entry.family === 'code-block-to-paragraph'
  )
  assert.equal(publications.length, 1,
    `${scenario.name} publication count: ${JSON.stringify(publications)}`)
  assert.equal(publications[0].boundary, boundary)
  const ownerPublications = state.owner.filter((entry) =>
    entry.phase === 'published' && entry.ok === true &&
    entry.family === 'code-block-to-paragraph'
  )
  assert.equal(ownerPublications.length, 1,
    `${scenario.name} owner publication count: ${JSON.stringify(ownerPublications)}`)
  assert.equal(ownerPublications[0].boundary, boundary)
}

const runRejectedScenario = async (port) => {
  const name = 'code-paragraph-semantic-rejection'
  const file = join(root, `${name}.md`)
  await writeFile(file, rejectedFixture, 'utf8')
  const app = await openApp({
    file,
    profile: `${name}-edit`,
    port,
    expectedMode: 'code',
    expectedCodeText: '# heading'
  })
  try {
    await clearDiagnostics(app)
    const point = await focusCodeEnd(app)
    await openBlockContextMenu(app, point)
    await chooseParagraph(app)
    await waitFor(() => app.evaluate(`(() => {
      const editor = ${visibleEditor()}
      return !editor?.querySelector('.milkdown-code-block') &&
        [...(editor?.children || [])].some((node) =>
          node.tagName === 'P' && (node.textContent || '') === '# heading'
        )
    })()`), 'semantic rejection did not leave the converted paragraph visible')
    await waitFor(() => app.evaluate(`(() =>
      (window.__hmCodeBlockTransactionTrace || []).some((entry) =>
        entry.phase === 'plan' &&
        entry.family === 'code-block-to-paragraph' &&
        entry.reason === 'code-block-paragraph-semantic-document-mismatch' &&
        entry.recognized === true &&
        entry.legacyBlocked === true
      )
    )()`), 'semantic rejection did not block retired legacy fallback')

    const state = await snapshot(app)
    assert.deepEqual(state.paragraphs, ['before', '# heading', 'after'])
    assert.equal(state.codeBlockCount, 0)
    const blocked = state.owner.filter((entry) =>
      entry.phase === 'plan' &&
      entry.family === 'code-block-to-paragraph' &&
      entry.reason === 'code-block-paragraph-semantic-document-mismatch'
    )
    assert.equal(blocked.length >= 1, true, JSON.stringify(state.owner))
    assert.equal(blocked.every((entry) =>
      entry.recognized === true && entry.legacyBlocked === true
    ), true, JSON.stringify(blocked))
    assert.equal(state.preserve.some((entry) =>
      entry.reason === 'code-block-converted-to-paragraph'
    ), false, `unsafe conversion unexpectedly published source: ${JSON.stringify(state.preserve)}`)
    assert.equal(state.coordinator.some((entry) =>
      entry.phase === 'published' &&
      (entry.family === 'code-block-to-paragraph' || entry.owner === 'legacy')
    ), false, `unsafe conversion reached publication: ${JSON.stringify(state.coordinator)}`)
    assert.equal(state.toasts.some((text) => warningPattern.test(text)), true,
      `unsafe conversion did not warn: ${JSON.stringify(state.toasts)}`)
    assert.equal(await visibleSource(app), null,
      'fail-closed conversion exposed a stale source textarea')
    assert.equal(await readFile(file, 'utf8'), rejectedFixture,
      'fail-closed conversion overwrote the authored file')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

const runScenario = async (scenario, port) => {
  const file = join(root, `${scenario.name}.md`)
  await writeFile(file, fixture, 'utf8')
  let app = await openApp({
    file,
    profile: `${scenario.name}-edit`,
    port,
    expectedMode: 'code'
  })
  try {
    await clearDiagnostics(app)
    const point = await focusCodeEnd(app)
    await openBlockContextMenu(app, point)
    const chosen = await chooseParagraph(app)
    try {
      await waitFor(() => app.evaluate(`(() => {
        const editor = ${visibleEditor()}
        return !editor?.querySelector('.milkdown-code-block') &&
          [...(editor?.children || [])].some((node) =>
            node.tagName === 'P' && (node.textContent || '') === 'alpha'
          )
      })()`), `${scenario.name} did not convert code block`)
    } catch (error) {
      const diagnostic = await app.evaluate(`(() => {
        const editor = ${visibleEditor()}
        return {
          chosen: ${JSON.stringify(chosen)},
          topLevel: [...(editor?.children || [])].map((node) => ({
            tag: node.tagName,
            className: node.className || '',
            text: node.textContent || ''
          })),
          codeTexts: [...(editor?.querySelectorAll('.milkdown-code-block .cm-content') || [])]
            .map((node) => node.textContent || ''),
          visibleMenus: [...document.querySelectorAll('.block-ctxmenu,[data-context-submenu]')]
            .filter((node) => {
              const rect = node.getBoundingClientRect()
              const style = getComputedStyle(node)
              return rect.width > 0 && rect.height > 0 &&
                style.display !== 'none' && style.visibility !== 'hidden'
            })
            .map((node) => node.textContent || ''),
          status: [...document.querySelectorAll('.status-btn')]
            .filter((node) => node.offsetParent)
            .map((node) => node.textContent || ''),
          owner: (window.__hmCodeBlockTransactionTrace || []).slice(-60),
          journal: (window.__hmSourceSyncTransactionJournalTrace || []).slice(-60),
          bodyText: document.body?.innerText || ''
        }
      })()`)
      console.error('CODE_BLOCK_PARAGRAPH_CONVERSION_DIAGNOSTIC', JSON.stringify({ chosen, diagnostic }))
      throw error
    }
    await focusParagraphEnd(app, 'alpha')
    await typeTextLikeUser(app.send, 'xy', { delayMs: 25 })
    await waitFor(() => app.evaluate(`(() => {
      const editor = ${visibleEditor()}
      return [...(editor?.children || [])].some((node) =>
        node.tagName === 'P' && (node.textContent || '') === 'alphaxy'
      )
    })()`), `${scenario.name} rapid text did not reach paragraph`)

    let source = null
    if (scenario.immediateSourceToggle) {
      assert.equal(await toggleSource(app), true, `${scenario.name} source toggle failed`)
      source = await waitFor(() => visibleSource(app), `${scenario.name} forced source missing`)
      assertSource(source, scenario.name)
      assert.equal(await toggleSource(app), true, `${scenario.name} rich toggle failed`)
      await sleep(700)
    } else {
      await sleep(1100)
    }

    const state = await snapshot(app)
    assertPublication(
      state,
      scenario,
      scenario.immediateSourceToggle
        ? 'transaction-code-block-to-paragraph-forced-flush'
        : 'transaction-code-block-to-paragraph-markdown-updated'
    )
    assert.equal(state.saveVisible, true, `${scenario.name} did not mark source dirty`)
    if (!scenario.immediateSourceToggle) {
      assert.equal(await toggleSource(app), true, `${scenario.name} source toggle failed`)
      source = await waitFor(() => visibleSource(app), `${scenario.name} source missing`)
      assertSource(source, scenario.name)
      assert.equal(await toggleSource(app), true, `${scenario.name} rich toggle failed`)
    }

    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`),
      `${scenario.name} save did not complete`)
    assert.equal(await readFile(file, 'utf8'), expected, `${scenario.name} disk mismatch`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }

  app = await openApp({
    file,
    profile: `${scenario.name}-reopen`,
    port: port + 1,
    expectedMode: 'paragraph'
  })
  try {
    const reopened = await snapshot(app)
    assertDocument(reopened, `${scenario.name} cold reopen`)
    assert.equal(await toggleSource(app), true)
    const source = await waitFor(() => visibleSource(app),
      `${scenario.name} cold source missing`)
    assertSource(source, `${scenario.name} cold reopen`)
    assert.equal(await readFile(file, 'utf8'), expected)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

let completed = false
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  for (let index = 0; index < scenarios.length; index += 1) {
    await runScenario(scenarios[index], basePort + index * 10)
  }
  await runRejectedScenario(basePort + scenarios.length * 10)
  completed = true
  console.log('PASS transaction-owned code block to paragraph UI: the real HorseMD context menu plus physical xy publishes exactly once through callback or forced flush, atomically removes the authored fence, preserves BOM/CRLF, saves and cold reopens; a Markdown-sensitive paragraph is recognized, blocks legacy fallback, warns and leaves source/disk untouched')
} finally {
  if (completed) await rm(root, { recursive: true, force: true })
}
