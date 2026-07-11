const MIRROR_STYLES = [
  'direction', 'font-family', 'font-size', 'font-weight', 'font-style',
  'letter-spacing', 'line-height', 'padding-top', 'padding-right',
  'padding-bottom', 'padding-left', 'border-top-width', 'border-right-width',
  'border-bottom-width', 'border-left-width', 'box-sizing', 'white-space',
  'word-wrap', 'word-break', 'overflow-wrap', 'tab-size', 'text-indent', 'width'
]

export const syncTextareaMirrorStyle = (textarea, mirror) => {
  const cs = textarea.ownerDocument.defaultView.getComputedStyle(textarea)
  let css = ''
  for (const name of MIRROR_STYLES) css += `${name}:${cs.getPropertyValue(name)};`
  mirror.style.cssText = `${css}position:absolute;visibility:hidden;white-space:pre-wrap;top:0;left:0;`
  // Computed width includes the textarea's vertical scrollbar, while the
  // mirror has no scrollbar. Match the real client box explicitly or a ~10px
  // width error compounds into many wrapped-line errors in long documents.
  const px = (name) => parseFloat(cs.getPropertyValue(name)) || 0
  mirror.style.width = cs.boxSizing === 'border-box'
    ? `${textarea.clientWidth + px('border-left-width') + px('border-right-width')}px`
    : `${Math.max(0, textarea.clientWidth - px('padding-left') - px('padding-right'))}px`
  return cs
}

const createMirror = (textarea) => {
  const doc = textarea.ownerDocument
  const mirror = doc.createElement('div')
  syncTextareaMirrorStyle(textarea, mirror)
  doc.body.appendChild(mirror)
  return mirror
}

export const textareaOffsetY = (textarea, offset) => {
  const mirror = createMirror(textarea)
  try {
    const value = textarea.value || ''
    const text = textarea.ownerDocument.createTextNode(value + '\u200b')
    mirror.appendChild(text)
    const range = textarea.ownerDocument.createRange()
    range.setStart(text, Math.max(0, Math.min(offset, value.length)))
    range.collapse(true)
    return range.getBoundingClientRect().top - mirror.getBoundingClientRect().top
  } finally {
    mirror.remove()
  }
}

export const textareaOffsetAtScrollTop = (textarea) => {
  if (!textarea) return 0
  const value = textarea.value || ''
  const targetY = Math.max(0, textarea.scrollTop)
  if (!value || targetY <= 0) return 0
  const mirror = createMirror(textarea)
  try {
    const text = textarea.ownerDocument.createTextNode(value + '\u200b')
    mirror.appendChild(text)
    const range = textarea.ownerDocument.createRange()
    const baseTop = mirror.getBoundingClientRect().top
    const yAt = (offset) => {
      range.setStart(text, offset)
      range.collapse(true)
      return range.getBoundingClientRect().top - baseTop
    }
    let low = 0
    let high = value.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (yAt(mid) < targetY) low = mid + 1
      else high = mid
    }
    return low
  } finally {
    mirror.remove()
  }
}
