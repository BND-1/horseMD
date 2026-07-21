// #25 regression: content-visibility may estimate off-screen block heights,
// but scrolling to and selecting a CodeMirror block must not move the visible
// document after the scroll has stopped.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = '/tmp/horsemd-codeblock-scroll-stability'
const port = 9495
const fixture = join(root, 'scroll-stability.md')

const markdown = Array.from({ length: 1300 }, (_, index) => [
  `Paragraph ${index}: stable scrolling marker with enough text to wrap inside the editor surface.`,
  index % 100 === 0
    ? `\n\`\`\`javascript\nconst codeBlock${index} = 'code-block-scroll-target-${index}'\nconsole.log(codeBlock${index})\n\`\`\``
    : ''
].join('\n')).join('\n\n')

const waitFor = async (check, message, attempts = 100) => {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const click = async (send, point) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

const targetScrollTop = (app, target) => app.evaluate(`((target) => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
  const scroller = editor?.closest('.editor-scroll')
  const line = [...(editor?.querySelectorAll('.milkdown-code-block .cm-line') || [])]
    .find((node) => node.textContent.includes(target))
  if (!editor || !scroller || !line) return null
  return Math.max(0, line.offsetTop - scroller.clientHeight / 2)
})(${JSON.stringify(target)})`)

const measure = (app, target) => app.evaluate(`((target) => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
  const scroller = editor?.closest('.editor-scroll')
  const line = [...(editor?.querySelectorAll('.milkdown-code-block .cm-line') || [])]
    .find((node) => node.textContent.includes(target))
  const rect = line?.getBoundingClientRect()
  const host = scroller?.getBoundingClientRect()
  return rect && host ? {
    point: { x: Math.round(rect.left + Math.min(80, rect.width / 2)), y: Math.round(rect.top + rect.height / 2) },
    relativeTop: Math.round(rect.top - host.top),
    scrollTop: Math.round(scroller.scrollTop),
    usesContentVisibility: scroller.classList.contains('hm-cv')
  } : null
})(${JSON.stringify(target)})`)

const scrollProgressively = async (app, target) => {
  const goal = await targetScrollTop(app, target)
  assert.ok(Number.isFinite(goal), `Target code block not found: ${target}`)
  const current = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
    return editor?.closest('.editor-scroll')?.scrollTop || 0
  })()`)
  const direction = goal >= current ? 1 : -1
  for (let top = current; direction > 0 ? top < goal : top > goal; top += direction * 180) {
    await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
      const scroller = editor?.closest('.editor-scroll')
      if (scroller) scroller.scrollTop = ${Math.max(0, Math.round(direction > 0 ? Math.min(top, goal) : Math.max(top, goal)))}
    })()`)
    await sleep(20)
  }
  await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
    const scroller = editor?.closest('.editor-scroll')
    if (scroller) scroller.scrollTop = ${Math.round(goal)}
  })()`)
  await sleep(350)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(fixture, markdown, 'utf8')
  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [fixture] })
  try {
    await waitFor(
      () => app.evaluate(`(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
        return !!editor && editor.querySelectorAll('.milkdown-code-block .cm-editor').length === 13
      })()`),
      'All CodeMirror blocks did not eagerly mount'
    )
    const results = []
    for (const index of [100, 500, 900, 1200]) {
      const target = `code-block-scroll-target-${index}`
      await scrollProgressively(app, target)
      const before = await measure(app, target)
      assert.ok(before?.usesContentVisibility, 'Large fixture did not enable content-visibility')
      await click(app.send, before.point)
      await sleep(1200)
      const after = await measure(app, target)
      const delta = Math.abs(after.relativeTop - before.relativeTop)
      assert.ok(delta <= 3, `Visible document jumped ${delta}px at ${target}: ${JSON.stringify({ before, after })}`)
      results.push({ target, delta, before, after })
    }
    console.log(`PASS code-block scroll stability UI: ${results.length} content-visibility positions, max delta ${Math.max(...results.map((item) => item.delta))}px`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
