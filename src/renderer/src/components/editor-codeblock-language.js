// Code-block language: accept any name (Typora parity). Milkdown's picker only
// selects from its built-in list: Enter in its search box did nothing and a
// name it doesn't know showed "No result", so a niche language could not be
// set. Enter in the search box, or a click on the row under it, now sets the
// typed name as-is (the fence info string). Highlighting still works for
// names and aliases the list knows; any other name is plain text.

// The info-string word: first token, no backticks or tildes (they would end
// or break the fence).
export function languageFromInput(value) {
  return String(value || '').trim().split(/\s+/)[0].replace(/[`~]/g, '')
}

const SEARCH = '.milkdown-code-block .language-picker .search-input'

export function mountCodeBlockLanguageInput({ view, cleanups, getT, isReadOnly }) {
  const dom = view.dom
  const t = (key, name) => String(getT?.(key) ?? key).replace('{name}', name ?? '')

  const codeBlockPos = (blockEl) => {
    let found = null
    view.state.doc.descendants((node, pos) => {
      if (found !== null) return false
      if (node.type.name === 'code_block' && view.nodeDOM(pos) === blockEl) found = pos
      return node.isBlock && !node.isTextblock
    })
    return found
  }

  const apply = (input) => {
    if (isReadOnly?.()) return false
    const language = languageFromInput(input.value)
    const blockEl = input.closest('.milkdown-code-block')
    if (!language || !blockEl) return false
    const pos = codeBlockPos(blockEl)
    if (pos === null) return false
    const node = view.state.doc.nodeAt(pos)
    if (node && node.attrs.language !== language) {
      view.dispatch(view.state.tr.setNodeAttribute(pos, 'language', language))
    }
    // Close the picker the way its own button does.
    blockEl.querySelector('.language-button')?.click()
    return true
  }

  // Show "Use “name”" in place of "No result" while the typed name matches
  // nothing (the row is rendered by Milkdown's picker; we only relabel it).
  const relabel = (input) => {
    const row = input.closest('.language-picker')?.querySelector('.language-list-item.no-result')
    if (!row) return
    const language = languageFromInput(input.value)
    row.textContent = language ? t('code.useLanguage', language) : t('code.noLanguage')
    row.classList.toggle('hm-use-language', !!language)
  }

  const onKeyDown = (event) => {
    const input = event.target
    if (!(input instanceof HTMLInputElement) || !input.matches(SEARCH)) return
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return
    if (apply(input)) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  const onInput = (event) => {
    const input = event.target
    if (!(input instanceof HTMLInputElement) || !input.matches(SEARCH)) return
    // The picker re-renders its list after this event.
    requestAnimationFrame(() => relabel(input))
  }
  const onClick = (event) => {
    const row = event.target?.closest?.('.language-picker .language-list-item.no-result')
    if (!row) return
    const input = row.closest('.language-picker')?.querySelector('.search-input')
    if (input && apply(input)) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  dom.addEventListener('keydown', onKeyDown, true)
  dom.addEventListener('input', onInput, true)
  dom.addEventListener('click', onClick, true)
  cleanups.push(() => {
    dom.removeEventListener('keydown', onKeyDown, true)
    dom.removeEventListener('input', onInput, true)
    dom.removeEventListener('click', onClick, true)
  })
}
