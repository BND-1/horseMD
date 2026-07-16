import { connectCdp, sleep } from './lib/cdp.mjs'

async function main() {
  const { ws, evaluate } = await connectCdp({ attempts: 30, intervalMs: 500 })

  const fixture = [
    '# Review UI regression',
    '',
    '{==first==}{>>first comment<<} and {==second==}{>>second comment<<}',
    '',
    '{~~old~>new~~} {++added++} {--deleted--}'
  ].join('\n')

  await evaluate(`(() => {
    const textarea = document.querySelector('textarea.source-editor')
    if (textarea) return true
    const toggle = [...document.querySelectorAll('.status-btn')]
      .find((button) => button.title?.includes('Ctrl+/'))
    if (!toggle) throw new Error('Source-mode toggle not found')
    toggle.click()
    return true
  })()`)
  await sleep(900)
  await evaluate(`(() => {
    const textarea = document.querySelector('textarea.source-editor')
    if (!textarea) throw new Error('Source textarea not found')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(textarea, ${JSON.stringify(fixture)})
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    return true
  })()`)
  await evaluate(`(() => {
    const toggle = [...document.querySelectorAll('.status-btn')]
      .find((button) => button.title?.includes('Ctrl+/'))
    toggle.click()
    return true
  })()`)
  await sleep(1400)

  const rendered = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    return {
      proseMirror: editor ? 1 : 0,
      highlights: editor?.querySelectorAll('.hm-review-highlight').length || 0,
      stacks: editor?.querySelectorAll('.hm-review-stack').length || 0,
      noteButtons: editor?.querySelectorAll('.hm-review-note-button').length || 0,
      substitutionOld: editor?.querySelectorAll('.hm-review-sub-old').length || 0,
      substitutionNew: editor?.querySelectorAll('.hm-review-sub-new').length || 0,
      additions: editor?.querySelectorAll('.hm-review-add').length || 0,
      deletions: editor?.querySelectorAll('.hm-review-del').length || 0
    }
  })()`)

  await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const buttons = editor?.querySelectorAll('.hm-review-stack .hm-review-note-button') || []
    if (buttons.length < 2) throw new Error('Review stack buttons missing')
    buttons[1].click()
    return true
  })()`)
  await sleep(300)
  const opened = await evaluate(`(() => ({
    cards: document.querySelectorAll('.hm-review-card[role="dialog"]').length,
    text: document.querySelector('.hm-review-card-text')?.textContent || '',
    comment: document.querySelector('.hm-review-card-comment')?.textContent || '',
    number: document.querySelector('.hm-review-card-number')?.textContent || ''
  }))()`)

  await evaluate(`(() => {
    const edit = document.querySelector('.hm-review-card-actions .hm-review-card-action')
    if (!edit) throw new Error('Review edit action missing')
    edit.click()
    return true
  })()`)
  await sleep(150)
  const editing = await evaluate(`(() => ({
    text: document.querySelector('.hm-review-card-input')?.value || '',
    comment: document.querySelector('.hm-review-card-textarea')?.value || '',
    actions: document.querySelectorAll('.hm-review-card-actions .hm-review-card-action').length
  }))()`)
  await evaluate(`(() => {
    const actions = document.querySelectorAll('.hm-review-card-actions .hm-review-card-action')
    if (actions.length !== 2) throw new Error('Review edit actions missing')
    actions[1].click()
    return true
  })()`)
  await sleep(150)
  const cancelled = await evaluate(`(() => ({
    text: document.querySelector('.hm-review-card-text')?.textContent || '',
    comment: document.querySelector('.hm-review-card-comment')?.textContent || ''
  }))()`)
  await evaluate(`(() => {
    const actions = document.querySelectorAll('.hm-review-card-actions .hm-review-card-action')
    if (actions.length < 2) throw new Error('Review done action missing')
    actions[1].click()
    return true
  })()`)
  await sleep(350)
  const completed = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    return {
      highlights: editor?.querySelectorAll('.hm-review-highlight').length || 0,
      noteButtons: editor?.querySelectorAll('.hm-review-note-button').length || 0,
      remainingText: editor?.textContent || ''
    }
  })()`)

  const passed =
    rendered.proseMirror === 1 &&
    rendered.highlights >= 2 &&
    rendered.stacks === 1 &&
    rendered.noteButtons === 2 &&
    rendered.substitutionOld === 1 &&
    rendered.substitutionNew === 1 &&
    rendered.additions >= 2 &&
    rendered.deletions >= 2 &&
    opened.cards === 1 &&
    opened.text === 'second' &&
    opened.comment === 'second comment' &&
    opened.number === '2 / 2' &&
    editing.text === 'second' &&
    editing.comment === 'second comment' &&
    editing.actions === 2 &&
    cancelled.text === 'second' &&
    cancelled.comment === 'second comment' &&
    completed.highlights === 1 &&
    completed.noteButtons === 1 &&
    completed.remainingText.includes('second')

  console.log(JSON.stringify({ passed, rendered, opened, editing, cancelled, completed }, null, 2))
  ws.close()
  process.exit(passed ? 0 : 2)
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
