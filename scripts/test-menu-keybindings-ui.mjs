import { rm } from 'node:fs/promises'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const PROFILE_DIR = '/tmp/horsemd-menu-keybindings-ui'
const CDP_PORT = 9451

const uiScript = `(() => {
  const flatten = (items) => items.flatMap((item) => [item, ...flatten(item.submenu || [])])
  const topLabel = (snapshot, label) => snapshot.find((item) => item.label === label)
  const findLabel = (snapshot, label) => flatten(snapshot).find((item) => item.label === label)
  const labelsOf = (snapshot) => snapshot.map((item) => item.label || item.role).filter(Boolean)
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }

  return (async () => {
    const before = await window.api.getMenuSnapshot()
    assert(Array.isArray(before) && before.length >= 4, 'Menu snapshot is empty')
    assert(topLabel(before, 'File'), 'Missing File menu: ' + labelsOf(before).join(', '))
    assert(topLabel(before, 'Edit'), 'Missing Edit menu: ' + labelsOf(before).join(', '))
    assert(topLabel(before, 'View'), 'Missing View menu: ' + labelsOf(before).join(', '))
    assert(before.some((item) => item.label === 'Window' || item.role === 'windowMenu'), 'Missing Window menu')
    assert(findLabel(before, 'Save')?.accelerator === 'CmdOrCtrl+S', 'Unexpected default Save accelerator')
    assert(findLabel(before, 'Toggle Source Mode')?.accelerator === 'CmdOrCtrl+/', 'Unexpected default source accelerator')
    assert(flatten(before).some((item) => item.role === 'undo'), 'Missing native undo role')
    assert(flatten(before).some((item) => item.role === 'copy'), 'Missing native copy role')

    const update = await window.api.setMenuKeybindings({
      'file.save': 'CmdOrCtrl+Alt+S',
      'view.toggleSource': null,
      'unknown.command': 'CmdOrCtrl+X'
    })
    assert(update?.ok === true, 'Expected menu keybinding update to succeed: ' + JSON.stringify(update))
    assert(update.ignoredCommandIds?.includes('unknown.command'), 'Unknown menu command was not ignored')

    const after = await window.api.getMenuSnapshot()
    assert(topLabel(after, 'File'), 'File menu disappeared after rebuild')
    assert(topLabel(after, 'Edit'), 'Edit menu disappeared after rebuild')
    assert(topLabel(after, 'View'), 'View menu disappeared after rebuild')
    assert(after.some((item) => item.label === 'Window' || item.role === 'windowMenu'), 'Window menu disappeared after rebuild')
    assert(findLabel(after, 'Save')?.accelerator === 'CmdOrCtrl+Alt+S', 'Save accelerator did not update')
    assert(!findLabel(after, 'Toggle Source Mode')?.accelerator, 'Source accelerator was not cleared')
    assert(flatten(after).some((item) => item.role === 'undo'), 'Native undo role disappeared after rebuild')

    const rejected = await window.api.setMenuKeybindings({ 'file.save': '<script>' })
    assert(rejected?.ok === false && rejected.error === 'invalid-accelerator', 'Invalid accelerator was not rejected')
    const finalSnapshot = await window.api.getMenuSnapshot()
    assert(findLabel(finalSnapshot, 'Save')?.accelerator === 'CmdOrCtrl+Alt+S', 'Rejected update mutated menu accelerator')

    return {
      ok: true,
      topMenus: labelsOf(finalSnapshot),
      save: findLabel(finalSnapshot, 'Save')?.accelerator,
      source: findLabel(finalSnapshot, 'Toggle Source Mode')?.accelerator || ''
    }
  })()
})()`

async function main() {
  await rm(PROFILE_DIR, { recursive: true, force: true })
  const app = await launchBuiltElectron({
    profileDir: PROFILE_DIR,
    port: CDP_PORT,
    cleanProfile: true
  })
  try {
    const result = await app.evaluate(uiScript)
    if (!result?.ok) throw new Error('Menu keybinding UI test failed')
    console.log(`menu keybindings synced: save=${result.save}, source=${result.source || '(cleared)'}`)
    console.log(`menu structure: ${result.topMenus.join(', ')}`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(PROFILE_DIR, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
