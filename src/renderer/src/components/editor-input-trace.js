const traceEnabled = () => window.api?.inputTraceEnabled === true && typeof window.api?.writeInputTrace === 'function'

const selectionSnapshot = (view) => {
  try {
    const selection = view?.state?.selection
    const head = selection?.$head
    return {
      anchor: selection?.anchor ?? null,
      head: selection?.head ?? null,
      from: selection?.from ?? null,
      to: selection?.to ?? null,
      empty: selection?.empty ?? null,
      parentType: head?.parent?.type?.name || null,
      parentText: head?.parent?.textContent || '',
      depth: head?.depth ?? null
    }
  } catch {
    return null
  }
}

const targetSnapshot = (target) => {
  if (!(target instanceof Element)) return null
  return {
    tag: target.tagName,
    id: target.id || '',
    className: typeof target.className === 'string' ? target.className.slice(0, 240) : '',
    role: target.getAttribute('role') || '',
    text: (target.textContent || '').slice(0, 120)
  }
}

export const traceEditorEvent = (type, payload = {}) => {
  if (!traceEnabled()) return
  try {
    void window.api.writeInputTrace({
      type,
      at: new Date().toISOString(),
      ...payload
    })
  } catch {
    // Tracing must never affect editing.
  }
}

export function mountEditorInputTrace({ host, view, cleanups }) {
  if (!traceEnabled() || !host) return

  const log = (type, payload = {}) => traceEditorEvent(type, {
    selection: selectionSnapshot(view),
    ...payload
  })

  const onKeyDown = (event) => log('keydown', {
    key: event.key,
    code: event.code,
    repeat: event.repeat,
    composing: event.isComposing,
    modifiers: {
      ctrl: event.ctrlKey,
      meta: event.metaKey,
      shift: event.shiftKey,
      alt: event.altKey
    }
  })
  const onKeyUp = (event) => log('keyup', {
    key: event.key,
    code: event.code,
    composing: event.isComposing
  })
  const onBeforeInput = (event) => log('beforeinput', {
    inputType: event.inputType,
    data: event.data ?? null,
    composing: event.isComposing
  })
  const onInput = (event) => log('input', {
    inputType: event.inputType || null,
    data: event.data ?? null,
    composing: event.isComposing
  })
  const onCompositionStart = (event) => log('compositionstart', { data: event.data ?? '' })
  const onCompositionUpdate = (event) => log('compositionupdate', { data: event.data ?? '' })
  const onCompositionEnd = (event) => log('compositionend', { data: event.data ?? '' })
  const onPaste = (event) => log('paste', {
    text: event.clipboardData?.getData('text/plain') || '',
    html: event.clipboardData?.getData('text/html') || ''
  })
  const onDrop = (event) => log('drop', {
    types: [...(event.dataTransfer?.types || [])],
    text: event.dataTransfer?.getData('text/plain') || ''
  })
  const onPointerDown = (event) => log('pointerdown', {
    button: event.button,
    x: event.clientX,
    y: event.clientY,
    target: targetSnapshot(event.target)
  })
  const onClick = (event) => log('click', {
    x: event.clientX,
    y: event.clientY,
    target: targetSnapshot(event.target)
  })
  const onSelectionChange = () => {
    const selection = document.getSelection()
    if (!selection || !host.contains(selection.anchorNode)) return
    log('selectionchange', {
      dom: {
        text: selection.toString().slice(0, 240),
        anchorOffset: selection.anchorOffset,
        focusOffset: selection.focusOffset,
        collapsed: selection.isCollapsed
      }
    })
  }

  host.addEventListener('keydown', onKeyDown, true)
  host.addEventListener('keyup', onKeyUp, true)
  host.addEventListener('beforeinput', onBeforeInput, true)
  host.addEventListener('input', onInput, true)
  host.addEventListener('compositionstart', onCompositionStart, true)
  host.addEventListener('compositionupdate', onCompositionUpdate, true)
  host.addEventListener('compositionend', onCompositionEnd, true)
  host.addEventListener('paste', onPaste, true)
  host.addEventListener('drop', onDrop, true)
  host.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('selectionchange', onSelectionChange, true)

  cleanups.push(() => {
    host.removeEventListener('keydown', onKeyDown, true)
    host.removeEventListener('keyup', onKeyUp, true)
    host.removeEventListener('beforeinput', onBeforeInput, true)
    host.removeEventListener('input', onInput, true)
    host.removeEventListener('compositionstart', onCompositionStart, true)
    host.removeEventListener('compositionupdate', onCompositionUpdate, true)
    host.removeEventListener('compositionend', onCompositionEnd, true)
    host.removeEventListener('paste', onPaste, true)
    host.removeEventListener('drop', onDrop, true)
    host.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('selectionchange', onSelectionChange, true)
  })

  traceEditorEvent('input-trace-mounted', {
    selection: selectionSnapshot(view),
    host: targetSnapshot(host)
  })
}
