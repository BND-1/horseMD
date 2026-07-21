import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-heading-case-'))
const file = join(root, 'headings.md')
const port = 9500 + (process.pid % 300)

const waitFor = async (check, message) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

let app
try {
  await writeFile(file, '# Title\n\n##### MixedCase h5\n\n###### camelCase h6\n', 'utf8')
  app = await launchBuiltElectron({
    profileDir: join(root, 'profile'),
    port,
    appArgs: [file]
  })
  const result = await waitFor(() => app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const h5 = editor?.querySelector('h5')
    const h6 = editor?.querySelector('h6')
    if (!h5 || !h6) return null
    return {
      h5: { text: h5.textContent, transform: getComputedStyle(h5).textTransform },
      h6: { text: h6.textContent, transform: getComputedStyle(h6).textTransform }
    }
  })()`), 'H5/H6 did not render')

  assert.deepEqual(result, {
    h5: { text: 'MixedCase h5', transform: 'none' },
    h6: { text: 'camelCase h6', transform: 'none' }
  })
  console.log('PASS heading case UI: H5/H6 preserve authored letter case')
} finally {
  if (app) await stopBuiltElectron(app)
  await rm(root, { recursive: true, force: true })
}
