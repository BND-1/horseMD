import { COMMAND_BY_ID, COMMAND_CONTEXTS } from './command-definitions.js'
import { normalizeKeybindings, resolveMod } from './keybinding-normalize.js'

function contextsConflict(leftId, rightId) {
  const left = COMMAND_BY_ID[leftId]
  const right = COMMAND_BY_ID[rightId]
  if (!left || !right) return true
  if (left.context === COMMAND_CONTEXTS.APP || right.context === COMMAND_CONTEXTS.APP) return true
  return left.context === right.context
}

export function findKeybindingConflicts(keybindingMap, platform = 'darwin') {
  const claims = new Map()
  for (const [commandId, bindings] of Object.entries(keybindingMap || {})) {
    for (const binding of normalizeKeybindings(bindings)) {
      const resolved = resolveMod(binding, platform)
      if (!resolved) continue
      if (!claims.has(resolved)) claims.set(resolved, [])
      claims.get(resolved).push(commandId)
    }
  }
  return [...claims.entries()]
    .flatMap(([binding, ids]) => {
      const conflictingIds = ids.filter((id, index) =>
        ids.some((otherId, otherIndex) => otherIndex !== index && contextsConflict(id, otherId))
      )
      return conflictingIds.length > 1 ? [{ binding, commandIds: conflictingIds }] : []
    })
}

export function getConflictsForCommand(commandId, candidateBindings, keybindingMap, platform = 'darwin') {
  const candidates = normalizeKeybindings(candidateBindings).map((binding) => resolveMod(binding, platform))
  if (!candidates.length) return []
  const conflicts = []
  for (const [otherId, bindings] of Object.entries(keybindingMap || {})) {
    if (otherId === commandId) continue
    if (!contextsConflict(commandId, otherId)) continue
    for (const binding of normalizeKeybindings(bindings)) {
      const resolved = resolveMod(binding, platform)
      if (resolved && candidates.includes(resolved)) {
        conflicts.push({
          binding: resolved,
          commandId: otherId,
          command: COMMAND_BY_ID[otherId] || null
        })
      }
    }
  }
  return conflicts
}
