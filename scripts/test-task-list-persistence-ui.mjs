import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-task-list-persistence-${process.pid}`
const fixture = join(root, 'tasks.md')
const profile = join(root, 'profile')
const port = 9650 + (process.pid % 200)
const original = [
  '# Tasks',
  '',
  '- [ ] First task',
  '- [x] Existing checked',
  ''
].join('\n')

const waitFor = async (check, message, attempts = 80) => {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const click = async (app, point) => {
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

const taskState = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')]
    .find((node) => node.offsetParent !== null)
  return [...(editor?.querySelectorAll('.milkdown-list-item-block') || [])]
    .map((item) => ({
      text: item.querySelector('.children')?.textContent?.trim() || '',
      checked: Boolean(item.querySelector('.label.checked')),
      unchecked: Boolean(item.querySelector('.label.unchecked'))
    }))
})()`)

const taskPoint = (app, text) => app.evaluate(`((text) => {
  const editor = [...document.querySelectorAll('.ProseMirror')]
    .find((node) => node.offsetParent !== null)
  const item = [...(editor?.querySelectorAll('.milkdown-list-item-block') || [])]
    .find((node) => node.querySelector('.children')?.textContent?.trim() === text)
  const label = item?.querySelector('.label-wrapper')
  const rect = label?.getBoundingClientRect()
  return rect
    ? { x: Math.round((rect.left + rect.right) / 2), y: Math.round((rect.top + rect.bottom) / 2) }
    : null
})(${JSON.stringify(text)})`)

async function launchAndWait({ cleanProfile }) {
  const app = await launchBuiltElectron({
    profileDir: profile,
    port,
    cleanProfile,
    appArgs: [fixture]
  })
  await waitFor(async () => {
    const state = await taskState(app)
    return state.length === 2 ? state : null
  }, 'Task list did not render')
  return app
}

async function save(app) {
  const point = await waitFor(() => app.evaluate(`(() => {
    const button = document.querySelector('.hm-save-fab')
    const rect = button?.getBoundingClientRect()
    return rect
      ? { x: Math.round((rect.left + rect.right) / 2), y: Math.round((rect.top + rect.bottom) / 2) }
      : null
  })()`), 'Task checkbox change did not mark the document dirty')
  await click(app, point)
  await waitFor(
    () => app.evaluate(`!document.querySelector('.hm-save-fab')`),
    'Save state did not clear after writing the task list'
  )
}

async function toggleAndSave(app, expectedChecked) {
  const point = await taskPoint(app, 'First task')
  assert.ok(point, 'First task checkbox was not hit-testable')
  await click(app, point)
  await waitFor(async () => {
    const [first] = await taskState(app)
    return first?.checked === expectedChecked
  }, `Task checkbox did not become ${expectedChecked ? 'checked' : 'unchecked'}`)
  await save(app)
  const disk = await readFile(fixture, 'utf8')
  assert.equal(
    disk,
    original.replace('- [ ] First task', `- [${expectedChecked ? 'x' : ' '}] First task`),
    'Saving a task checkbox must change only its Markdown marker'
  )
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(fixture, original, 'utf8')

  let app = await launchAndWait({ cleanProfile: true })
  try {
    assert.deepEqual(
      await taskState(app),
      [
        { text: 'First task', checked: false, unchecked: true },
        { text: 'Existing checked', checked: true, unchecked: false }
      ],
      'Initial task states did not match the Markdown source'
    )
    await toggleAndSave(app, true)
  } finally {
    await stopBuiltElectron(app)
  }

  app = await launchAndWait({ cleanProfile: false })
  try {
    assert.equal((await taskState(app))[0]?.checked, true, 'Checked task did not survive close and reopen')
    await toggleAndSave(app, false)
  } finally {
    await stopBuiltElectron(app)
  }

  app = await launchAndWait({ cleanProfile: false })
  try {
    assert.equal((await taskState(app))[0]?.unchecked, true, 'Unchecked task did not survive close and reopen')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }

  console.log('Task-list persistence UI regression passed: check, save, reopen, uncheck, save, and reopen.')
}

main().catch(async (error) => {
  await rm(root, { recursive: true, force: true })
  console.error(error)
  process.exitCode = 1
})
