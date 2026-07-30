import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const waitFor = async (evaluate, expression, message, attempts = 160) => {
  for (let index = 0; index < attempts; index += 1) {
    if (await evaluate(expression)) return
    await sleep(200)
  }
  throw new Error(message)
}

const setInput = (evaluate, selector, value) => evaluate(`(() => {
  const input = document.querySelector(${JSON.stringify(selector)})
  if (!input) return false
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
    .set.call(input, ${JSON.stringify(value)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)

const buildDocument = () => [
  '# PDF 连续设置压力测试',
  '',
  ...Array.from({ length: 24 }, (_, index) => [
    `## 第 ${index + 1} 节`,
    '',
    `这是第 ${index + 1} 节的正文。HorseMD 必须等待旧打印任务完全清理后，才开始生成最新预览。`.repeat(3),
    '',
    '| ID | 名称 | 说明 |',
    '| ---: | --- | --- |',
    `| ${index + 1} | 项目 ${index + 1} | 用于增加真实分页和表格排版负载 |`,
    '',
    '```javascript',
    `const section${index + 1} = ${index + 1}`,
    '```',
    ''
  ].join('\n'))
].join('\n')

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'horsemd-pdf-churn-'))
const documentPath = path.join(tempDir, 'pdf-preview-churn.md')
await writeFile(documentPath, buildDocument(), 'utf8')

const app = await launchBuiltElectron({
  profileDir: path.join(tempDir, 'profile'),
  port: 9493,
  appArgs: [documentPath]
})

try {
  const { evaluate } = app
  await evaluate(`window.__HORSEMD_TEST_CAPTURE_PDF__ = true`)
  await waitFor(evaluate, `!!document.querySelector('.tab.active')`, 'Stress document did not open')
  await evaluate(`(() => {
    const tab = document.querySelector('.tab.active')
    tab.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: 200,
      clientY: 20,
      button: 2
    }))
  })()`)
  await waitFor(
    evaluate,
    `[...document.querySelectorAll('button')].some((node) => /PDF/i.test(node.textContent || ''))`,
    'PDF export command not found'
  )
  await evaluate(`([...document.querySelectorAll('button')]
    .find((node) => /PDF/i.test(node.textContent || ''))?.click(), true)`)
  await waitFor(evaluate, `!!document.querySelector('.hm-pdf-studio')`, 'PDF studio did not open')
  await evaluate(`(() => {
    window.__horsemdPdfChurnErrors = []
    const record = () => {
      const error = document.querySelector('.hm-pdf-preview-error')?.textContent?.trim()
      if (error && window.__horsemdPdfChurnErrors.at(-1) !== error) {
        window.__horsemdPdfChurnErrors.push(error)
      }
    }
    window.__horsemdPdfChurnObserver = new MutationObserver(record)
    window.__horsemdPdfChurnObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    })
    record()
  })()`)
  await waitFor(
    evaluate,
    `window.__horsemdLastPdfPreview?.result?.ok === true`,
    'Initial long-document PDF preview did not become ready'
  )

  for (const value of ['8', '9', '10', '11', '12', '13', '14', '15', '14']) {
    assert.equal(await setInput(evaluate, 'input[data-pdf-font-size]', value), true)
    await sleep(190)
  }

  try {
    await waitFor(
      evaluate,
      `window.__horsemdLastPdfPreview?.options?.fontSizePt === 14 &&
        window.__horsemdLastPdfPreview?.result?.ok === true &&
        !document.querySelector('.hm-pdf-preview-progress')`,
      'Long-document PDF churn did not settle on the latest font size',
      200
    )
  } catch (error) {
    const diagnostics = await evaluate(`(() => ({
      capture: window.__horsemdLastPdfPreview
        ? {
            options: window.__horsemdLastPdfPreview.options,
            result: window.__horsemdLastPdfPreview.result || null
          }
        : null,
      errors: window.__horsemdPdfChurnErrors || [],
      progress: document.querySelector('.hm-pdf-preview-progress')?.textContent || '',
      visibleError: document.querySelector('.hm-pdf-preview-error')?.textContent || '',
      input: document.querySelector('input[data-pdf-font-size]')?.value || ''
    }))()`)
    throw new Error(`${error.message}: ${JSON.stringify(diagnostics)}`)
  }
  const result = await evaluate(`(() => ({
    errors: window.__horsemdPdfChurnErrors || [],
    fontSizePt: window.__horsemdLastPdfPreview?.options?.fontSizePt,
    pages: document.querySelectorAll('.hm-pdf-page').length,
    visibleError: document.querySelector('.hm-pdf-preview-error')?.textContent || ''
  }))()`)
  assert.deepEqual(result.errors, [])
  assert.equal(result.fontSizePt, 14)
  assert.equal(result.visibleError, '')
  assert.ok(result.pages > 5, `Stress PDF was unexpectedly short: ${result.pages} pages`)
  console.log(`PASS PDF preview churn UI: ${JSON.stringify(result)}`)
} finally {
  try {
    await app.evaluate(`window.__horsemdPdfChurnObserver?.disconnect()`)
  } catch {}
  await stopBuiltElectron(app, { removeProfile: false })
  await rm(tempDir, { recursive: true, force: true })
}
