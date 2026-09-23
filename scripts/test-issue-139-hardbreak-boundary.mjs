import assert from 'node:assert/strict'
import { preserveRichMarkdownSource } from '../src/renderer/src/markdown-source-preservation.js'

const previous = '# AUDIT\n\nLEFT\n\nTAIL\n'
let checked = 0
for (const eol of ['\n', '\r\n']) {
  const source = previous.replace(/\n/g, eol)
  for (const marker of ['  ', '   ', '\\']) {
    for (const continuation of ['RIGHT', 'RIGHT\n\nSECOND\n\n<br />']) {
      const next = `# AUDIT\n\nLEFT${marker}\n${continuation}\n\nTAIL\n`
      const expected = next.replace('\n\n<br />', '').replace(/\n/g, eol)
      const result = preserveRichMarkdownSource(source, previous, next)
      assert.equal(result.preserved, true)
      assert.equal(result.reason, 'middle-continuation-inserted')
      assert.equal(result.markdown, expected, 'hard break must remain a same-paragraph continuation, preserving EOL and following paragraphs')
      checked += 1
    }
  }
  const paragraph = '# AUDIT\n\nLEFT\n\nRIGHT\n\nTAIL\n'
  const result = preserveRichMarkdownSource(source, previous, paragraph)
  assert.equal(result.preserved, true)
  assert.equal(result.reason, 'middle-block-inserted')
  assert.equal(result.markdown, paragraph.replace(/\n/g, eol), 'a real paragraph insertion must not become a hard break')
  checked += 1
}
console.log(`PASS middle hard break: ${checked} LF/CRLF cases; both spellings, multi-paragraph paste, placeholder cleanup and real paragraph boundaries`)
