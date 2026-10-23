// Code-block folding: a toolbar button collapses a long code block to a
// scrollable window of its first lines with a "N lines folded" bar under them. View-only: nothing is
// written to the Markdown, so the document never turns dirty, and the state
// lives on the node view's DOM (lost on reopen, like an editor's code folds).
// Putting the caret inside folded code (click, arrow keys, Tab into it)
// unfolds it, so nothing is ever typed into hidden lines.
//
// Milkdown's code block toolbar is a compiled Vue component; the button is
// added to its `.tools-button-group` from outside (Vue only patches its own
// nodes there, the optional preview button is appended after ours).
import { EditorView as CodeMirrorView } from '@codemirror/view'

// Lines left visible while folded.
export const FOLD_VISIBLE_LINES = 5
// Folding must hide at least a few lines to be worth a button.
export const FOLD_MIN_LINES = FOLD_VISIBLE_LINES + 3

const FOLDED = 'hm-code-folded'
const BUTTON = 'hm-code-fold-button'
const BAR = 'hm-code-fold-bar'

const chevron = (open) => open
  ? '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M6 15l6-6 6 6"/></svg>'
  : '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>'

export function mountCodeBlockFold({ view, cleanups, getT }) {
  const dom = view.dom
  const t = (key, fallback, n) => {
    const value = getT?.(key)
    return String(!value || value === key ? fallback : value).replace('{n}', String(n ?? ''))
  }

  const lineCount = (block) => {
    const editor = block.querySelector('.cm-editor')
    const cm = editor ? CodeMirrorView.findFromDOM(editor) : null
    if (cm) return cm.state.doc.lines
    return (block.querySelector('.cm-content')?.innerText || '').split('\n').length
  }

  const refresh = (block) => {
    const lines = lineCount(block)
    const folded = block.classList.contains(FOLDED)
    // A short block cannot stay folded (e.g. lines were deleted meanwhile).
    if (folded && lines < FOLD_MIN_LINES) return setFolded(block, false)
    // Write only what changed: these writes are seen by the observer below.
    if (block.classList.contains('hm-code-foldable') !== (lines >= FOLD_MIN_LINES)) {
      block.classList.toggle('hm-code-foldable', lines >= FOLD_MIN_LINES)
    }
    const button = block.querySelector(`.${BUTTON}`)
    const state = folded ? 'folded' : 'open'
    if (button && button.dataset.state !== state) {
      const label = folded ? t('code.unfold', 'Expand code') : t('code.fold', 'Fold code')
      button.dataset.state = state
      button.title = label
      button.setAttribute('aria-label', label)
      button.setAttribute('aria-expanded', folded ? 'false' : 'true')
      button.innerHTML = chevron(!folded)
    }
    const label = block.querySelector(`:scope > .${BAR} > span`)
    const text = t('code.foldedLines', '{n} more lines — click to expand', Math.max(0, lines - FOLD_VISIBLE_LINES))
    if (label && label.textContent !== text) label.textContent = text
  }

  // Height of the first FOLD_VISIBLE_LINES lines plus a little room under the
  // last one, measured (fonts and line height are user settings), falling
  // back to the content's line height.
  const visibleHeight = (block) => {
    const host = block.querySelector('.codemirror-host')
    const lines = block.querySelectorAll('.cm-content > .cm-line')
    const last = lines[Math.min(FOLD_VISIBLE_LINES, lines.length) - 1]
    if (host && last) return Math.ceil(last.getBoundingClientRect().bottom - host.getBoundingClientRect().top) + 10
    const content = block.querySelector('.cm-content')
    const lineHeight = content ? parseFloat(getComputedStyle(content).lineHeight) || 22 : 22
    return Math.ceil(lineHeight * FOLD_VISIBLE_LINES) + 34
  }

  // The page's scrolling ancestor (the folded window itself scrolls too).
  const pageScroller = (el) => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const { overflowY } = getComputedStyle(node)
      if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
    }
    return document.scrollingElement
  }

  const setFolded = (block, folded) => {
    const host = block.querySelector('.codemirror-host')
    if (host) {
      // Unfolding a window scrolled down would move its lines down by that
      // much (e.g. under the click that put the caret there): scroll the
      // page by the same amount so the code stays where it was.
      const offset = !folded ? host.scrollTop : 0
      host.style.maxHeight = folded ? `${visibleHeight(block)}px` : ''
      if (!folded) host.scrollTop = 0
      if (offset) pageScroller(block)?.scrollBy(0, offset)
    }
    block.classList.toggle(FOLDED, folded)
    let bar = block.querySelector(`:scope > .${BAR}`)
    if (folded && !bar) {
      bar = document.createElement('div')
      bar.className = BAR
      bar.setAttribute('role', 'button')
      bar.tabIndex = -1
      bar.contentEditable = 'false'
      bar.innerHTML = `${chevron(false)}<span></span>`
      block.appendChild(bar)
    } else if (!folded && bar) {
      bar.remove()
    }
    refresh(block)
  }

  const ensureButton = (block) => {
    const group = block.querySelector('.tools .tools-button-group')
    if (!group || group.querySelector(`.${BUTTON}`)) return
    const button = document.createElement('button')
    button.type = 'button'
    button.className = BUTTON
    group.insertBefore(button, group.firstChild)
    refresh(block)
  }

  const scan = () => {
    for (const block of dom.querySelectorAll('.milkdown-code-block')) {
      ensureButton(block)
      refresh(block)
    }
  }

  const onClick = (event) => {
    const button = event.target?.closest?.(`.${BUTTON}`)
    const bar = event.target?.closest?.(`.${BAR}`)
    const block = (button || bar)?.closest('.milkdown-code-block')
    if (!block || !dom.contains(block)) return
    event.preventDefault()
    event.stopPropagation()
    setFolded(block, bar ? false : !block.classList.contains(FOLDED))
  }
  const foldedCodeAt = (target) => {
    const block = target?.closest?.(`.milkdown-code-block.${FOLDED}`)
    return block && target.closest('.cm-editor') ? block : null
  }
  // Keep the toolbar button from taking ProseMirror's selection. A press in
  // folded code unfolds it first (CodeMirror may already have focus, so no
  // focusin follows); the page scroll compensation keeps the line under the
  // pointer, so the caret still lands where clicked.
  const onMouseDown = (event) => {
    if (event.target?.closest?.(`.${BUTTON}, .${BAR}`)) return event.preventDefault()
    const block = foldedCodeAt(event.target)
    if (block) setFolded(block, false)
  }
  const onFocusIn = (event) => {
    const block = foldedCodeAt(event.target)
    if (block) setFolded(block, false)
  }
  // Typing or moving the caret inside folded code (focus stayed there while
  // it was folded) unfolds it too.
  const onKeyDown = (event) => {
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return
    const block = foldedCodeAt(event.target)
    if (block) setFolded(block, false)
  }

  let pending = 0
  const schedule = () => {
    if (pending) return
    pending = requestAnimationFrame(() => {
      pending = 0
      scan()
    })
  }
  const observer = new MutationObserver(schedule)
  observer.observe(dom, { childList: true, subtree: true })
  scan()

  dom.addEventListener('mousedown', onMouseDown, true)
  dom.addEventListener('click', onClick, true)
  dom.addEventListener('focusin', onFocusIn, true)
  dom.addEventListener('keydown', onKeyDown, true)
  cleanups.push(() => {
    observer.disconnect()
    if (pending) cancelAnimationFrame(pending)
    dom.removeEventListener('mousedown', onMouseDown, true)
    dom.removeEventListener('click', onClick, true)
    dom.removeEventListener('focusin', onFocusIn, true)
    dom.removeEventListener('keydown', onKeyDown, true)
  })
}
