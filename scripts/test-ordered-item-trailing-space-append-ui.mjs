import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-ordered-tail-space-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 11520 + (process.pid % 40))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''

const fixture = `# 尾空格继续输入回归

- 可就是被科技部
- 老板老板娘
  - s 入了你看你了

吗；啊嗯

- 看了呢分

1. \\-

- u高科技

\`\`\`
尼玛，吗了解
了几百块
\`\`\`

1. 吗。不开机；口红

2. 斯卡洛尼快乐
3. 是干嘛的了；吗
4. ​ 热度三个代表

- 是v的；发布

- 露娜了

啊额绿化

1

-   1. 二哥你来拿如果
  - ​     就了解了呢
  * 如果可能老顾客

安乐分
`

const waitFor = async (check, message, attempts = 180) => {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const key = async (app, keyValue, code, keyCode, text = keyValue, after = 18) => {
  const common = { key: keyValue, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  if (text) await app.send('Input.dispatchKeyEvent', { type: 'char', ...common, text, unmodifiedText: text })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(after)
}

const diagnostics = (app) => app.evaluate(`(() => ({
  preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, ...e }) => e),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-20).map(({ parsed, expected, ...e }) => ({
    ...e,
    candidate: String(e.candidate || '').slice(0, 900),
    canonical: String(e.canonical || '').slice(0, 900)
  })),
  toasts: [...document.querySelectorAll('[class*="toast"]')].map((n) => n.textContent || '')
}))()`)

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  app = await launchBuiltElectron({
    profileDir: join(root, 'profile'),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })

  await waitFor(() => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')]
    .find((n) => n.offsetParent && n.textContent.includes('看了呢分') && n.textContent.includes('二哥你来拿如果')))`), 'fixture did not mount')

  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    const editor = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
    const p = [...editor.querySelectorAll('ol li p')].find((n) => (n.textContent || '') === '-')
    if (!p) throw new Error('target ordered item not found')
    const sel = getSelection(); sel.removeAllRanges()
    const range = document.createRange(); range.selectNodeContents(p); range.collapse(false); sel.addRange(range)
    editor.focus(); document.dispatchEvent(new Event('selectionchange'))
  })()`)

  await key(app, 's', 'KeyS', 83)
  await key(app, 'f', 'KeyF', 70)
  await sleep(500)
  await key(app, ' ', 'Space', 32)
  await waitFor(() => app.evaluate(`(window.__hmSourceIntegrityTrace || []).some((e) =>
    e.ok === true && String(e.candidate || '').includes('\\n1. -sf \\n'))`), 'trailing-space frame did not sync')

  const spaceState = await diagnostics(app)
  console.log('ORDERED_TAIL_SPACE_STATE:', JSON.stringify(spaceState))
  assert.equal(spaceState.integrity.some((e) => e.ok === false), false, 'space frame failed source integrity')
  assert.equal(spaceState.toasts.some((t) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(t)), false, 'space frame showed warning')

  await key(app, 'a', 'KeyA', 65)
  await key(app, 'e', 'KeyE', 69)
  await key(app, 'f', 'KeyF', 70)
  await waitFor(() => app.evaluate(`(window.__hmSourceIntegrityTrace || []).some((e) =>
    e.ok === true && String(e.candidate || '').includes('\\n1. -sf aef\\n'))`), 'continued body frame did not sync')
  await sleep(500)

  const bodyState = await diagnostics(app)
  console.log('ORDERED_TAIL_BODY_STATE:', JSON.stringify(bodyState))
  assert.equal(bodyState.integrity.some((e) => e.ok === false), false, 'body append after trailing space failed source integrity')
  assert.equal(bodyState.toasts.some((t) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(t)), false, 'body append showed warning')
  assert.equal(bodyState.integrity.some((e) => e.candidate.includes('\n1. -sf aef\n')), true, 'body text was not appended after the authored space')
  assert.equal(bodyState.integrity.some((e) => e.candidate.includes('```\n尼玛，吗了解\n了几百块\n```')), true, 'authored fence changed')
  console.log('PASS ordered item trailing space -> body append stays source-equivalent')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
