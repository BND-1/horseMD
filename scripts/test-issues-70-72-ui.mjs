// Real Electron regression for #70 outline fold state and #72 task-list input.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const dir = join(tmpdir(), 'horsemd-issues-70-72')
const visiblePm = `[...document.querySelectorAll('.ProseMirror')].find((pm) => pm.offsetParent !== null)`

async function waitFor(evaluate, expr, label, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    if (await evaluate(expr)) return true
    await sleep(250)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function activateTab(evaluate, name) {
  await evaluate(`([...document.querySelectorAll('.tab')].find((tab) => tab.textContent.includes(${JSON.stringify(name)}))?.click(), true)`)
  await sleep(300)
}

async function testOutlineFoldState() {
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'outline-issue70.md')
  await writeFile(file, '# Top\n\n## Parent title\n\n### Child should stay visible\n\nbody\n')

  const app = await launchBuiltElectron({
    profileDir: join(dir, 'profile-outline'),
    port: Number(process.env.CDP_PORT || 9470),
    appArgs: [file]
  })
  try {
    await sleep(1200)
    await activateTab(app.evaluate, '欢迎')
    await activateTab(app.evaluate, 'outline-issue70')
    await waitFor(app.evaluate, `!!(${visiblePm})?.querySelector('h2')?.textContent.includes('Parent title')`, 'outline fixture editor')
    await waitFor(app.evaluate, `document.querySelectorAll('.outline-item .outline-item-text').length >= 2`, 'outline rows')

    const before = await app.evaluate(`(() => [...document.querySelectorAll('.outline-item .outline-item-text')].map((node) => node.textContent.trim()).join('|'))()`)
    if (!before.includes('Parent title') || before.includes('Child should stay visible')) {
      throw new Error(`Unexpected default outline state: ${before}`)
    }

    await app.evaluate(`(() => {
      const parent = [...document.querySelectorAll('.outline-item')]
        .find((row) => row.textContent.includes('Parent title'))
      parent?.querySelector('.outline-twisty')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return true
    })()`)
    await sleep(400)

    const expanded = await app.evaluate(`(() => [...document.querySelectorAll('.outline-item .outline-item-text')].map((node) => node.textContent.trim()).join('|'))()`)
    if (!expanded.includes('Child should stay visible')) throw new Error(`Outline expand failed: ${expanded}`)

    await app.evaluate(`(() => {
      const pm = ${visiblePm}
      const h2 = [...pm.querySelectorAll('h2')].find((node) => node.textContent.includes('Parent title'))
      const text = h2?.firstChild
      if (!text) throw new Error('Missing editable H2 text')
      const range = document.createRange()
      range.setStart(text, 0)
      range.setEnd(text, text.textContent.length)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      pm.focus()
      return true
    })()`)
    await app.send('Input.insertText', { text: 'Renamed parent title' })
    await sleep(900)

    const after = await app.evaluate(`(() => [...document.querySelectorAll('.outline-item .outline-item-text')].map((node) => node.textContent.trim()).join('|'))()`)
    if (!after.includes('Renamed parent title') || !after.includes('Child should stay visible')) {
      throw new Error(`Issue #70 still reproduces: ${after}`)
    }
    return after
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

async function testTaskListInput() {
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'task-issue72.md')
  await writeFile(file, '')

  const app = await launchBuiltElectron({
    profileDir: join(dir, 'profile-task'),
    port: Number(process.env.CDP_PORT_TASK || 9471),
    appArgs: [file]
  })
  try {
    await sleep(1200)
    await activateTab(app.evaluate, '欢迎')
    await activateTab(app.evaluate, 'task-issue72')
    await waitFor(app.evaluate, `!!(${visiblePm})`, 'task fixture editor')

    await app.evaluate(`(() => {
      const pm = ${visiblePm}
      pm.focus()
      const range = document.createRange()
      range.selectNodeContents(pm)
      range.collapse(false)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      return true
    })()`)
    await app.send('Input.insertText', { text: '- [ ] ' })
    await sleep(600)

    const snapshot = JSON.parse(await app.evaluate(`(() => {
      const pm = ${visiblePm}
      return JSON.stringify({
        taskControls: pm.querySelectorAll('.milkdown-list-item-block .label.unchecked, .milkdown-list-item-block .label.checked, .task-list-item, li[data-item-type="task"], input[type="checkbox"]').length,
        html: pm.innerHTML.slice(0, 500)
      })
    })()`))
    if (snapshot.taskControls < 1) throw new Error(`Issue #72 still reproduces: ${JSON.stringify(snapshot)}`)

    await app.evaluate(`(() => {
      const pm = ${visiblePm}
      pm.focus()
      const range = document.createRange()
      range.selectNodeContents(pm)
      range.collapse(false)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      return true
    })()`)
    await app.send('Input.insertText', { text: '- [x] ' })
    await sleep(600)

    const checkedSnapshot = JSON.parse(await app.evaluate(`(() => {
      const pm = ${visiblePm}
      return JSON.stringify({
        checkedControls: pm.querySelectorAll('.milkdown-list-item-block .label.checked, input[type="checkbox"]:checked, li[data-checked="true"]').length,
        taskControls: pm.querySelectorAll('.milkdown-list-item-block .label.unchecked, .milkdown-list-item-block .label.checked, .task-list-item, li[data-item-type="task"], input[type="checkbox"]').length,
        html: pm.innerHTML.slice(0, 800)
      })
    })()`))
    if (checkedSnapshot.taskControls < 2 || checkedSnapshot.checkedControls < 1) {
      throw new Error(`Issue #72 checked task conversion failed: ${JSON.stringify(checkedSnapshot)}`)
    }
    return checkedSnapshot.taskControls
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

const outline = await testOutlineFoldState()
const taskControls = await testTaskListInput()
console.log(`PASS issues 70-72 UI: ${JSON.stringify({ outline, taskControls })}`)
