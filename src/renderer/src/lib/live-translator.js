// A translator for app-wide singletons (document listeners, module caches)
// that are shared by every editor. Each editor's `getT` closes over that
// editor's whole setup scope, so holding one strongly keeps a closed tab's
// editor in memory. Editors register their `getT` here; it is held weakly
// and the first one still alive answers.
const live = new Set()

export function rememberTranslator(getT) {
  if (typeof getT !== 'function') return
  for (const ref of live) if (ref.deref() === getT) return
  live.add(new WeakRef(getT))
}

export function translate(key) {
  for (const ref of live) {
    const getT = ref.deref()
    if (getT) return getT(key)
    live.delete(ref)
  }
  return key
}
