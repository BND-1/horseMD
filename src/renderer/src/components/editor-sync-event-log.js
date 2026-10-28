// Always-on, in-memory record of the last input events for the sync
// diagnostic report (lib/sync-diagnostics.js). Nothing is written anywhere;
// the user sees it only in the report they choose to open. Passive capture
// listeners: they never change what the editor does.

const blockPath = (view) => {
  try {
    const $head = view.state.selection.$head
    const names = []
    for (let depth = 1; depth <= $head.depth; depth += 1) names.push($head.node(depth).type.name)
    return names.join('>') || 'doc'
  } catch {
    return ''
  }
}

// Keys that produce no beforeinput, or whose handling decides structure.
const NAMED = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])

export function mountSyncEventLog({ view, log, cleanups }) {
  const dom = view?.dom
  if (!dom || !log) return
  const push = (entry) => {
    try { log.push({ ...entry, block: blockPath(view) }) } catch { /* never affect editing */ }
  }
  const onKeyDown = (event) => {
    const mods = [event.ctrlKey && 'Ctrl', event.metaKey && 'Cmd', event.altKey && 'Alt', event.shiftKey && 'Shift'].filter(Boolean)
    // Plain printable keys show up as beforeinput below.
    if (!NAMED.has(event.key) && !(mods.length && !(mods.length === 1 && mods[0] === 'Shift'))) return
    push({ type: 'key', key: [...mods, event.key].join('+') + (event.isComposing ? ' (IME)' : '') })
  }
  const onBeforeInput = (event) => push({ type: 'input', inputType: event.inputType, data: event.data || '' })
  const onComposition = (event) => push({ type: event.type, data: event.type === 'compositionend' ? event.data || '' : '' })
  const onClipboard = (event) => {
    const types = [...(event.clipboardData?.types || [])].join(',')
    const text = event.clipboardData?.getData?.('text/plain') || ''
    push({ type: event.type, mime: types, length: event.type === 'paste' ? text.length : undefined })
  }
  const onDrop = (event) => push({ type: 'drop', mime: [...(event.dataTransfer?.types || [])].join(',') })
  const onPointer = () => push({ type: 'click' })
  const listeners = [
    ['keydown', onKeyDown], ['beforeinput', onBeforeInput], ['compositionstart', onComposition],
    ['compositionend', onComposition], ['paste', onClipboard], ['cut', onClipboard], ['drop', onDrop],
    ['mouseup', onPointer]
  ]
  for (const [type, fn] of listeners) dom.addEventListener(type, fn, true)
  cleanups.push(() => { for (const [type, fn] of listeners) dom.removeEventListener(type, fn, true) })
}
