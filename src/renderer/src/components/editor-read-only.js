// Read-only mode still allows scrolling, selecting and copying. Keep this
// policy separate from DOM listeners so mobile regressions are unit-testable.
export function isReadOnlyMutationKey(event) {
  const key = String(event?.key || '').toLowerCase()
  const modifier = Boolean(event?.metaKey || event?.ctrlKey)
  if (modifier) return ['v', 'x', 'z', 'y'].includes(key)
  return key === 'backspace' || key === 'delete' || key === 'enter' || key === 'tab' || key.length === 1
}
