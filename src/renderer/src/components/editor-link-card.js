// Link card (Feishu / Notion / Google Docs): a plain click opens a link, so
// editing goes through this card instead of a caret inside the link text.
//   hover a link (0.3 s) → [target] 复制 · 编辑 · 取消链接   (read-only: target · 复制)
//   编辑, or Mod+K with the caret in a link → text + link fields, Enter / 确定
//   Mod+K elsewhere → the same fields for a new link (the selection is its text)
// The card lives in document.body, outside the contenteditable (a DOM change
// inside it would be a ProseMirror mutation). Crepe's own hover preview is
// switched off (disableCrepeLinkPreview) so only one card shows.
import { TextSelection } from '@milkdown/prose/state'
import { copyToClipboard } from '../ui.js'

const SHOW_DELAY = 300
const HIDE_DELAY = 250

const svg = (inner) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`
const ICONS = {
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  remove: svg('<path d="M9 15l6-6"/><path d="M11 6l1.5-1.5a4 4 0 0 1 5.7 5.7L17 11.5"/><path d="M13 18l-1.5 1.5a4 4 0 0 1-5.7-5.7L7 12.5"/><path d="M4 4l16 16"/>')
}

// Turn off Crepe's link hover preview (copy / edit / remove, href-only
// edit). Its edit tooltip — used by the toolbar's link button — stays.
export function disableCrepeLinkPreview(ctx) {
  ctx.update('LINK_PREVIEW_TOOLTIP_SPEC', () => ({
    view: () => ({ update() {}, destroy() {} })
  }))
}

// The whole link-mark run around `pos` inside its textblock (a link with a
// bold word is several text nodes sharing one mark).
export function linkRangeAt(state, pos) {
  const type = state.schema.marks.link
  if (!type || pos < 0 || pos > state.doc.content.size) return null
  const $pos = state.doc.resolve(pos)
  const parent = $pos.parent
  if (!parent.inlineContent) return null
  let index = $pos.index()
  let mark = parent.maybeChild(index) && type.isInSet(parent.child(index).marks)
  if (!mark && index > 0) {
    index -= 1
    mark = type.isInSet(parent.child(index).marks)
  }
  if (!mark) return null
  let first = index
  let last = index
  while (first > 0 && mark.isInSet(parent.child(first - 1).marks)) first -= 1
  while (last < parent.childCount - 1 && mark.isInSet(parent.child(last + 1).marks)) last += 1
  let from = $pos.start()
  for (let i = 0; i < first; i++) from += parent.child(i).nodeSize
  let to = from
  for (let i = first; i <= last; i++) to += parent.child(i).nodeSize
  return { from, to, mark, text: state.doc.textBetween(from, to, '', '') }
}

const linkRangeOfAnchor = (view, anchor) => {
  try {
    return linkRangeAt(view.state, view.posAtDOM(anchor, 0))
  } catch {
    return null
  }
}

export function mountLinkCard({ view, cleanups, getT, isReadOnly, markUserEdit, openHref }) {
  if (typeof window === 'undefined') return
  const hoverable = Boolean(window.matchMedia?.('(hover: hover)').matches)
  const t = (key) => String(getT(key) ?? key)
  let card = null
  let mode = 'hidden' // 'preview' | 'edit'
  let anchorEl = null
  let range = null // { from, to, mark, text } of the link, or a new link's range
  let showTimer = 0
  let pending = null // the anchor a show is scheduled for
  let hideTimer = 0

  const ensureCard = () => {
    if (card) return card
    card = document.createElement('div')
    card.className = 'hm-link-card'
    card.hidden = true
    card.addEventListener('mouseenter', () => clearTimeout(hideTimer))
    card.addEventListener('mouseleave', () => { if (mode === 'preview') scheduleHide() })
    // Keep the editor's selection while clicking the card's buttons.
    card.addEventListener('mousedown', (event) => {
      if (!event.target.closest('input')) event.preventDefault()
    })
    card.addEventListener('click', onCardClick)
    card.addEventListener('keydown', onCardKey)
    document.body.appendChild(card)
    return card
  }

  const place = (rect) => {
    if (!card || !rect) return
    const box = card.getBoundingClientRect()
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8))
    const below = rect.bottom + 4
    const top = below + box.height > window.innerHeight - 8 ? Math.max(8, rect.top - box.height - 4) : below
    card.style.left = `${Math.round(left)}px`
    card.style.top = `${Math.round(top)}px`
  }

  const hide = () => {
    clearTimeout(showTimer)
    pending = null
    clearTimeout(hideTimer)
    const wasEdit = mode === 'edit'
    mode = 'hidden'
    anchorEl = null
    range = null
    if (card) {
      card.hidden = true
      card.replaceChildren()
    }
    return wasEdit
  }
  const scheduleHide = () => {
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => { if (mode === 'preview') hide() }, HIDE_DELAY)
  }

  const button = (act, label, html) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'hm-link-card-btn'
    b.dataset.linkAct = act
    b.title = label
    b.setAttribute('aria-label', label)
    b.innerHTML = html
    return b
  }

  const showPreview = (anchor) => {
    const href = anchor.getAttribute('href') || ''
    if (!href || !anchor.isConnected) return
    const el = ensureCard()
    mode = 'preview'
    anchorEl = anchor
    range = linkRangeOfAnchor(view, anchor)
    let shown = href
    try { shown = decodeURI(href) } catch { /* as written */ }
    const url = document.createElement('button')
    url.type = 'button'
    url.className = 'hm-link-card-url'
    url.dataset.linkAct = 'open'
    url.title = t('link.open')
    url.textContent = shown
    const parts = [url, button('copy', t('link.copy'), ICONS.copy)]
    // Raw HTML <a> (no link mark) and read-only documents: open / copy only.
    if (range && view.editable && !isReadOnly?.()) {
      parts.push(button('edit', t('link.edit'), ICONS.edit), button('remove', t('link.remove'), ICONS.remove))
    }
    el.className = 'hm-link-card'
    el.replaceChildren(...parts)
    el.hidden = false
    place(anchor.getClientRects()[0] || anchor.getBoundingClientRect())
  }

  // Text + link fields. `target` = an existing link range, or { from, to }
  // of the selection for a new link.
  const showEdit = (target, isNew) => {
    clearTimeout(showTimer)
    clearTimeout(hideTimer)
    const el = ensureCard()
    mode = 'edit'
    range = { ...target, isNew }
    const field = (name, label, value, placeholder) => {
      const row = document.createElement('label')
      row.className = 'hm-link-card-field'
      const caption = document.createElement('span')
      caption.textContent = label
      const input = document.createElement('input')
      input.type = 'text'
      input.dataset.linkField = name
      input.value = value
      input.placeholder = placeholder
      input.spellcheck = false
      row.append(caption, input)
      return row
    }
    const actions = document.createElement('div')
    actions.className = 'hm-link-card-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.dataset.linkAct = 'cancel'
    cancel.textContent = t('link.cancel')
    const apply = document.createElement('button')
    apply.type = 'button'
    apply.className = 'primary'
    apply.dataset.linkAct = 'apply'
    apply.textContent = t('link.apply')
    actions.append(cancel, apply)
    el.className = 'hm-link-card hm-link-card-edit'
    el.replaceChildren(
      field('text', t('link.text'), target.text || '', t('link.textPlaceholder')),
      field('href', t('link.href'), target.mark?.attrs?.href || '', t('link.hrefPlaceholder')),
      actions
    )
    el.hidden = false
    const start = view.coordsAtPos(target.from)
    const end = view.coordsAtPos(target.to)
    place({ left: start.left, top: start.top, bottom: Math.max(start.bottom, end.bottom) })
    const href = el.querySelector('[data-link-field="href"]')
    const text = el.querySelector('[data-link-field="text"]')
    const focus = isNew && !target.text ? text : href
    focus.focus()
    focus.select()
  }

  const backToEditor = (pos) => {
    view.focus()
    if (pos != null) {
      const at = Math.min(pos, view.state.doc.content.size)
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)))
    }
  }

  const apply = () => {
    if (mode !== 'edit' || !range || !card) return
    const text = card.querySelector('[data-link-field="text"]').value
    const href = card.querySelector('[data-link-field="href"]').value.trim()
    const { from, to, isNew } = range
    const state = view.state
    const type = state.schema.marks.link
    // The document may have changed while the card was open.
    const current = isNew ? null : linkRangeAt(state, from)
    if (!isNew && (!current || current.from !== from || current.to !== to || !current.mark.eq(range.mark))) {
      hide()
      return
    }
    if (isNew && !href) { hide(); backToEditor(to); return }
    const oldText = isNew ? state.doc.textBetween(from, to, '', '') : current.text
    const newText = text || oldText || href
    const mark = href ? type.create({ ...(current?.mark.attrs || {}), href }) : null
    let tr = state.tr
    let end = to
    if (newText !== oldText) {
      // New text keeps the marks of the link's first character.
      const $from = state.doc.resolve(from)
      const first = $from.nodeAfter?.isText ? $from.nodeAfter.marks : $from.marks()
      const marks = first.filter((m) => m.type !== type)
      tr = tr.replaceWith(from, to, state.schema.text(newText, mark ? mark.addToSet(marks) : marks))
      end = from + newText.length
    } else {
      tr = tr.removeMark(from, to, type)
      if (mark) tr = tr.addMark(from, to, mark)
    }
    hide()
    markUserEdit?.()
    tr.setSelection(TextSelection.create(tr.doc, end))
    // Typing right after continues as plain text (Feishu / Notion).
    if (mark) tr.setStoredMarks(tr.doc.resolve(end).marks().filter((m) => m.type !== type))
    view.dispatch(tr.scrollIntoView())
    view.focus()
  }

  const removeLink = () => {
    if (!range || range.isNew) return
    const current = linkRangeAt(view.state, range.from)
    hide()
    if (!current) return
    markUserEdit?.()
    view.dispatch(view.state.tr.removeMark(current.from, current.to, view.state.schema.marks.link))
  }

  const openEditor = () => {
    if (!view.editable || isReadOnly?.()) return false
    const { from, to, empty } = view.state.selection
    const existing = linkRangeAt(view.state, from)
    if (existing && (empty || (to <= existing.to && from >= existing.from))) {
      showEdit(existing, false)
      return true
    }
    // A selection across blocks cannot become one link.
    const $from = view.state.doc.resolve(from)
    if (!$from.parent.inlineContent || !$from.sameParent(view.state.doc.resolve(to))) return false
    showEdit({ from, to, text: view.state.doc.textBetween(from, to, '', '') }, true)
    return true
  }

  const onCardClick = (event) => {
    const act = event.target.closest?.('[data-link-act]')?.dataset.linkAct
    if (!act) return
    event.preventDefault()
    if (act === 'open') {
      const href = anchorEl?.getAttribute('href')
      hide()
      if (href) openHref(href)
    } else if (act === 'copy') {
      const href = anchorEl?.getAttribute('href') || ''
      hide()
      copyToClipboard(href, t('link.copied'))
    } else if (act === 'edit') {
      if (range) showEdit(range, false)
    } else if (act === 'remove') {
      removeLink()
    } else if (act === 'apply') {
      apply()
    } else if (act === 'cancel') {
      const pos = range?.to
      hide()
      backToEditor(pos)
    }
  }
  const onCardKey = (event) => {
    if (mode !== 'edit') return
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault()
      apply()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      const pos = range?.to
      hide()
      backToEditor(pos)
    }
  }

  // mousemove, not mouseover: after a click on a link (the card hides on
  // press) a pointer that stays on it must bring the card back.
  const onMove = (event) => {
    if (!hoverable || mode === 'edit' || event.buttons) return
    const anchor = event.target.closest?.('a[href]')
    if (!anchor || !view.dom.contains(anchor)) return
    if (mode === 'preview' && anchor === anchorEl) { clearTimeout(hideTimer); return }
    if (pending === anchor) return
    clearTimeout(showTimer)
    clearTimeout(hideTimer)
    pending = anchor
    showTimer = setTimeout(() => { pending = null; showPreview(anchor) }, mode === 'preview' ? 0 : SHOW_DELAY)
  }
  const onOut = (event) => {
    if (mode === 'edit') return
    const from = event.target.closest?.('a[href]')
    if (!from) return
    const to = event.relatedTarget
    if (to && (from.contains(to) || card?.contains(to))) return
    clearTimeout(showTimer)
    pending = null
    if (mode === 'preview') scheduleHide()
  }
  const onKey = (event) => {
    const mod = window.api?.platform === 'darwin' ? event.metaKey : event.ctrlKey
    if (mod && !event.shiftKey && !event.altKey && (event.key === 'k' || event.key === 'K') && !event.isComposing) {
      if (openEditor()) {
        event.preventDefault()
        event.stopPropagation()
      }
      return
    }
    if (mode === 'preview') hide()
  }
  const onPointerDown = (event) => {
    if (card?.contains(event.target)) return
    if (mode !== 'hidden') hide()
  }
  const onScroll = (event) => {
    if (card?.contains(event.target)) return
    if (mode === 'preview') hide()
    else if (mode === 'edit' && range) {
      try {
        const start = view.coordsAtPos(range.from)
        place({ left: start.left, top: start.top, bottom: start.bottom })
      } catch { hide() }
    }
  }
  const onBlur = () => { if (mode === 'preview') hide() }

  view.dom.addEventListener('mousemove', onMove)
  view.dom.addEventListener('mouseout', onOut)
  view.dom.addEventListener('keydown', onKey, true)
  document.addEventListener('mousedown', onPointerDown, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('blur', onBlur)
  cleanups.push(() => {
    hide()
    view.dom.removeEventListener('mousemove', onMove)
    view.dom.removeEventListener('mouseout', onOut)
    view.dom.removeEventListener('keydown', onKey, true)
    document.removeEventListener('mousedown', onPointerDown, true)
    window.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('blur', onBlur)
    card?.remove()
    card = null
  })
}
