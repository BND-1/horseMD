// Milkdown hides table row/column controls as soon as the pointer leaves a
// table. Keep each visible handle briefly so the user can move to a nearby
// control without losing it; action groups use the same grace period.
const CONTROL_GRACE_MS = 2000

const isCellHandle = (element) => element?.matches?.(
  '.milkdown-table-block .cell-handle'
)

const isActionGroup = (element) => element?.matches?.(
  '.milkdown-table-block .cell-handle > .button-group'
)

export function mountTableActionMenuRetention({ host, cleanups }) {
  const states = new Map()
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
    state.handle.removeEventListener('pointerenter', state.onEnter)
    state.handle.removeEventListener('pointerleave', state.onLeave)
    state.group?.removeEventListener('pointerenter', state.onEnter)
    state.group?.removeEventListener('pointerleave', state.onLeave)
    if (states.get(state.handle) === state) states.delete(state.handle)
    if (hide) {
      setShown(state.handle, false)
      if (state.groupShown) setShown(state.group, false)
    }
  }

  const keepShown = (state) => {
    if (!state || !state.handle.isConnected || !host.contains(state.handle)) {
      clear(state)
      return
    }
    setShown(state.handle, true)
    if (state.groupShown && state.group?.isConnected) setShown(state.group, true)
  }

  const isHovered = (state) => (
    state.handle.matches(':hover') ||
    state.group?.matches(':hover')
  )

  const armDismiss = (state, reset = false) => {
    const now = performance.now()
    if (!reset && state.dismissAt > now) return
    clearTimeout(state.timer)
    state.dismissAt = now + CONTROL_GRACE_MS
    state.timer = window.setTimeout(() => {
      // Pointer enter can be missed when Milkdown repositions a control under
      // an already-moving cursor. CSS hover is the authoritative fallback.
      state.timer = 0
      state.dismissAt = 0
      if (isHovered(state)) {
        armDismiss(state)
        return
      }
      clear(state, true)
    }, CONTROL_GRACE_MS)
  }

  const hideOtherActionGroups = (group) => {
    for (const state of states.values()) {
      if (state.groupShown && state.group !== group) {
        state.groupShown = false
        setShown(state.group, false)
      }
    }
  }

  const activate = (handle, group = handle?.querySelector('.button-group')) => {
    if (!handle || !host.contains(handle)) return
    let state = states.get(handle)
    if (!state) {
      state = {
        handle,
        group: group || null,
        groupShown: group?.dataset.show === 'true',
        hovered: false,
        timer: 0,
        dismissAt: 0,
        onEnter: null,
        onLeave: null
      }
      state.onEnter = () => {
        state.hovered = true
        clearTimeout(state.timer)
        state.dismissAt = 0
        keepShown(state)
      }
      state.onLeave = () => {
        state.hovered = false
        armDismiss(state, true)
      }
      state.handle.addEventListener('pointerenter', state.onEnter)
      state.handle.addEventListener('pointerleave', state.onLeave)
      if (state.group && state.group !== state.handle) {
        state.group.addEventListener('pointerenter', state.onEnter)
        state.group.addEventListener('pointerleave', state.onLeave)
      }
      states.set(handle, state)
    } else if (group) {
      state.group = group
    }

    if (group?.dataset.show === 'true') {
      hideOtherActionGroups(group)
      state.groupShown = true
    }
    keepShown(state)
    armDismiss(state)
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const element = mutation.target
      if (consumeInternalWrite(element)) continue

      const handle = isCellHandle(element)
        ? element
        : isActionGroup(element)
          ? element.closest('.cell-handle')
          : null
      const state = handle ? states.get(handle) : null
      if (isActionGroup(element) && element.dataset.show === 'true') {
        activate(handle, element)
        continue
      }
      if (isCellHandle(element) && element.dataset.show === 'true') {
        activate(element)
        continue
      }
      if (state && (
        (state.handle === element && element.dataset.show === 'false') ||
        (state.group === element && element.dataset.show === 'false')
      )) {
        state.hovered = false
        keepShown(state)
        armDismiss(state)
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
    for (const state of [...states.values()]) clear(state)
  })
}
