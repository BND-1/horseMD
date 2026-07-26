// Milkdown hides table row/column action groups on every pointer move inside a
// table. Keep a group briefly after a deliberate row/column selection so the
// pointer can travel from the small handle to its alignment/delete actions.
const MENU_GRACE_MS = 1400

const isActionGroup = (element) => element?.matches?.(
  '.milkdown-table-block .cell-handle > .button-group'
)

export function mountTableActionMenuRetention({ host, cleanups }) {
  let active = null
  const internalWrites = new WeakMap()

  const setShown = (element, shown) => {
    if (!element || element.dataset.show === String(shown)) return
    internalWrites.set(element, (internalWrites.get(element) || 0) + 1)
    element.dataset.show = String(shown)
  }

  const consumeInternalWrite = (element) => {
    const count = internalWrites.get(element) || 0
    if (!count) return false
    if (count === 1) internalWrites.delete(element)
    else internalWrites.set(element, count - 1)
    return true
  }

  const clear = (state, hide = false) => {
    if (!state) return
    clearTimeout(state.timer)
    state.group.removeEventListener('pointerenter', state.onEnter)
    state.group.removeEventListener('pointerleave', state.onLeave)
    if (active === state) active = null
    if (hide) {
      setShown(state.group, false)
      setShown(state.handle, false)
    }
  }

  const keepShown = (state) => {
    if (active !== state || !state.group.isConnected || !state.handle.isConnected) {
      clear(state)
      return
    }
    setShown(state.handle, true)
    setShown(state.group, true)
  }

  const armDismiss = (state) => {
    clearTimeout(state.timer)
    state.timer = window.setTimeout(() => {
      // Pointer enter can be missed when Milkdown repositions the group under
      // an already-moving cursor. CSS hover is the authoritative fallback.
      if (state.hovered || state.group.matches(':hover')) {
        state.hovered = true
        return
      }
      clear(state, true)
    }, MENU_GRACE_MS)
  }

  const activate = (group) => {
    const handle = group.closest('.cell-handle')
    if (!handle || !host.contains(handle)) return
    if (active?.group === group) {
      keepShown(active)
      armDismiss(active)
      return
    }
    clear(active, true)
    const state = {
      group,
      handle,
      hovered: false,
      timer: 0,
      onEnter: null,
      onLeave: null
    }
    state.onEnter = () => {
      state.hovered = true
      clearTimeout(state.timer)
      keepShown(state)
    }
    state.onLeave = () => {
      state.hovered = false
      armDismiss(state)
    }
    group.addEventListener('pointerenter', state.onEnter)
    group.addEventListener('pointerleave', state.onLeave)
    active = state
    keepShown(state)
    armDismiss(state)
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const element = mutation.target
      if (consumeInternalWrite(element)) continue
      if (isActionGroup(element) && element.dataset.show === 'true') {
        activate(element)
        continue
      }
      if (active?.group === element && element.dataset.show === 'false') {
        keepShown(active)
      } else if (active?.handle === element && element.dataset.show === 'false') {
        keepShown(active)
      }
    }
  })
  observer.observe(host, {
    subtree: true,
    attributes: true,
    attributeFilter: ['data-show']
  })

  cleanups.push(() => {
    observer.disconnect()
    clear(active)
  })
}
