import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-diverged-ordinary-save-${process.pid}`
const port = Number(process.env.CDP_PORT || 10057)
const keyDelay = Number(process.env.DIVERGED_SAVE_KEY_DELAY || 35)
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''

// This is a minimized form of the user's real file. Several untouched regions
// intentionally serialize differently in Crepe: nested `- - text`, literal
// triple-backtick inline text, and a trailing syntax-only quote row. The plain
// paragraph “测试” is repeated throughout other structures, so a whole-source
// substring lookup cannot identify the edited occurrence.
const initial = [
  '# 测试',
  '',
  '## 你好',
  '',
  '- 你好 1. 2. 测试',
  '- - 测试 1. 你好',
  '- 测试 - 测试 1. 2. 测试',
  '',
  '```你好```',
  '',
  '`nihao`你好',
  '',
  '1. 你是谁 ？      你好',
  '',
  '```',
  '你好',
  '你是谁',
  '你还',
  '```',
  '',
  '> 你是谁',
  '>',
  '> 你好',
  '>',
  '> 1',
  '>',
  '> 2',
  '>',
  '> 3',
  '>',
  '>',
  '',
  '测试',
  '',
  '> 测试',
  '>',
  '> 测试',
  '>',
  '> 测试',
  ''
].join('\n')
const scenarios = [
  {
    name: 'standalone-paragraph',
    selector: ':scope > p',
    text: '测试',
    ordinal: 0,
    inserted: '普通编辑X',
    expected: initial.replace('\n测试\n\n> 测试', '\n测试普通编辑X\n\n> 测试')
  },
  {
    name: 'nested-bullet-item',
    selector: 'li p',
    text: '测试 1. 你好',
    ordinal: 0,
    inserted: 'X',
    expected: initial.replace('- - 测试 1. 你好', '- - 测试 1. 你好X')
  },
  {
    name: 'sibling-after-nested-bullet',
    selector: 'li p',
    text: '测试 - 测试 1. 2. 测试',
    ordinal: 0,
    inserted: 'X',
    expected: initial.replace('- 测试 - 测试 1. 2. 测试', '- 测试 - 测试 1. 2. 测试X')
  },
  {
    name: 'batched-blockquote-paragraphs',
    edits: [
      { selector: 'blockquote p', text: '你是谁', ordinal: 0, inserted: 'A' },
      { selector: 'blockquote p', text: '你好', ordinal: 0, inserted: 'B' },
      { selector: 'blockquote p', text: '3', ordinal: 0, inserted: 'C' }
    ],
    expected: initial
      .replace('> 你是谁', '> 你是谁A')
      .replace('> 你好', '> 你好B')
      .replace('> 3', '> 3C')
  },
  {
    name: 'exit-repeated-blockquote',
    selector: 'blockquote p',
    text: '测试',
    ordinal: 2,
    inserted: 'ceeavvß/',
    exitBlockquote: true,
    expected: initial + '\nceeavvß/\n'
  },
  {
    name: 'type-in-trailing-empty-after-blockquote',
    selector: ':scope > p',
    text: '',
    ordinal: 0,
    inserted: '引用后直接输入',
    emptyBlock: true,
    expected: initial + '\n引用后直接输入\n'
  }
]
const selectedScenario = process.env.DIVERGED_SAVE_SCENARIO || ''
const activeScenarios = selectedScenario
  ? scenarios.filter((scenario) => scenario.name === selectedScenario)
  : scenarios

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', ...point, button: 'left', clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', ...point, button: 'left', clickCount: 1
  })
}

async function clickTextBlockEnd(app, scenario, settleMs = 180) {
  const found = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)
    const matches = [...editor.querySelectorAll(${JSON.stringify(scenario.selector)})]
      .filter((node) => node.textContent === ${JSON.stringify(scenario.text)})
    const target = matches[${scenario.ordinal}]
    target?.scrollIntoView({ block: 'center' })
    return matches.length
  })()`)
  assert.ok(found > scenario.ordinal, `${scenario.name}: target text block missing`)
  if (settleMs) await sleep(settleMs)
  const point = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)
    const target = [...editor.querySelectorAll(${JSON.stringify(scenario.selector)})]
      .filter((node) => node.textContent === ${JSON.stringify(scenario.text)})[${scenario.ordinal}]
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
    let textNode = null
    let candidate
    while ((candidate = walker.nextNode())) textNode = candidate
    if (!textNode) return null
    const range = document.createRange()
    range.setStart(textNode, textNode.nodeValue.length)
    range.collapse(true)
    const rect = range.getBoundingClientRect()
    return { x: rect.left + 1, y: rect.top + Math.max(3, rect.height / 2) }
  })()`)
  assert.ok(point, `${scenario.name}: caret point was not measurable`)
  await click(app.send, point)
  await pressKey(app.send, { key: 'End', code: 'End', delayMs: keyDelay })
}

async function clickEmptyBlock(app, scenario) {
  const point = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)
    const matches = [...editor.querySelectorAll(${JSON.stringify(scenario.selector)})]
      .filter((node) => node.textContent === ${JSON.stringify(scenario.text)})
    const target = matches[${scenario.ordinal}]
    target?.scrollIntoView({ block: 'center' })
    const rect = target?.getBoundingClientRect()
    if (!rect) return null
    return { x: rect.left + Math.max(4, Math.min(16, rect.width / 2)), y: rect.top + rect.height / 2 }
  })()`)
  assert.ok(point, `${scenario.name}: empty text block was not measurable`)
  await click(app.send, point)
  await sleep(120)
}

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

async function openApp(profile, file, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  await waitFor(
    () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)?.textContent.includes('你还')`),
    'diverged ordinary-save fixture did not mount'
  )
  await sleep(300)
  return app
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  try {
    assert.ok(activeScenarios.length, `unknown scenario: ${selectedScenario}`)
    for (let index = 0; index < activeScenarios.length; index += 1) {
      const scenario = activeScenarios[index]
      const scenarioRoot = join(root, scenario.name)
      const file = join(scenarioRoot, 'diverged-ordinary-save.md')
      await mkdir(scenarioRoot, { recursive: true })
      await writeFile(file, initial)
      let app
      try {
        app = await openApp(join(scenario.name, 'edit'), file, port + index * 2)
        await app.evaluate('window.__hmPreserveLog = []')
        if (scenario.exitBlockquote) {
          await clickTextBlockEnd(app, scenario)
          await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: keyDelay })
          await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: keyDelay })
          await typeTextLikeUser(app.send, scenario.inserted, { delayMs: keyDelay })
        } else if (scenario.emptyBlock) {
          await clickEmptyBlock(app, scenario)
          await typeTextLikeUser(app.send, scenario.inserted, { delayMs: keyDelay })
        } else {
          const edits = scenario.edits || [scenario]
          for (const edit of edits) {
            await clickTextBlockEnd(app, edit, scenario.edits ? 0 : 180)
            await typeTextLikeUser(app.send, edit.inserted, {
              delayMs: scenario.edits ? 8 : keyDelay
            })
          }
        }
        await waitFor(
          () => app.evaluate(`!!document.querySelector('.hm-save-fab')`),
          `${scenario.name}: rich edit did not become dirty`
        )

        // Save directly from rich mode. No source-mode round trip is allowed
        // to heal or mask the pending preservation transaction first.
        await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
        await waitFor(
          () => app.evaluate(`!document.querySelector('.hm-save-fab')`),
          `${scenario.name}: direct rich save stayed paused`
        ).catch(async (error) => {
          const diagnostics = await app.evaluate(`(() => ({
            toasts: [...document.querySelectorAll('[class*=toast]')].map((node) => node.textContent),
            log: window.__hmPreserveLog || []
          }))()`)
          console.error(`${scenario.name} diagnostics:`, JSON.stringify(diagnostics, null, 2))
          throw error
        })

        const diskMarkdown = await readFile(file, 'utf8')
        if (diskMarkdown !== scenario.expected) {
          const log = await app.evaluate('window.__hmPreserveLog || []')
          console.error(`${scenario.name} preservation log:`, JSON.stringify(log, null, 2))
        }
        assert.equal(diskMarkdown, scenario.expected, `${scenario.name}: direct rich save did not write the exact local edit`)
        const diagnostics = await app.evaluate(`(() => ({
          warning: [...document.querySelectorAll('[class*=toast]')]
            .some((node) => /保存已暂停|Save paused/.test(node.textContent || '')),
          log: window.__hmPreserveLog || []
        }))()`)
        assert.equal(diagnostics.warning, false, `${scenario.name}: source-sync warning was displayed`)
        assert.equal(
          diagnostics.log.some((entry) => entry.preserved === false),
          false,
          `${scenario.name}: an intermediate transaction failed closed`
        )

        assert.equal(await toggleSource(app), true, `${scenario.name}: source toggle missing after save`)
        assert.equal(
          await waitFor(() => visibleSource(app), `${scenario.name}: source mode did not open`),
          scenario.expected,
          `${scenario.name}: source mode differs from the saved rich document`
        )

        await stopBuiltElectron(app, { removeProfile: true })
        app = await openApp(join(scenario.name, 'reopen'), file, port + index * 2 + 1)
        assert.equal(await toggleSource(app), true, `${scenario.name}: source toggle missing after reopen`)
        assert.equal(
          await waitFor(() => visibleSource(app), `${scenario.name}: reopened source did not open`),
          scenario.expected,
          `${scenario.name}: cold reopen changed the saved Markdown bytes`
        )
      } finally {
        if (app) await stopBuiltElectron(app, { removeProfile: true })
      }
    }
    console.log('PASS diverged ordinary save: paragraph and nested-list edits save directly without normalizing untouched Markdown')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
