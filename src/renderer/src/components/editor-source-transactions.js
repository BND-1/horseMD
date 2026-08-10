// ProseMirror's EditorState.applyTransaction() owns the complete root
// transaction plus every recursively appended transaction. Observing that
// result at dispatch time gives source synchronization one atomic batch before
// Milkdown's debounced markdownUpdated callback advances any source baseline.
export function createSourceTransactionDispatch(onTransactions) {
  return function dispatchSourceTransaction(transaction) {
    const view = this
    const oldState = view?.state
    if (!oldState || typeof oldState.applyTransaction !== 'function' || typeof view.updateState !== 'function') {
      throw new Error('Source transaction dispatch requires an EditorView')
    }

    const applied = oldState.applyTransaction(transaction)
    const changed = applied.transactions.some((candidate) => candidate.docChanged)

    // Explicit test-only trace. Production never initializes this array, so
    // document content is neither retained nor logged during normal use.
    if (changed && Array.isArray(globalThis.__hmSourceTransactionTrace)) {
      globalThis.__hmSourceTransactionTrace.push({
        transactions: applied.transactions.map((candidate) => ({
          docChanged: candidate.docChanged,
          steps: candidate.steps.map((step) => step.toJSON?.() || {
            kind: step?.constructor?.name || 'unknown'
          })
        })),
        oldDoc: oldState.doc.toJSON(),
        newDoc: applied.state.doc.toJSON()
      })
      if (globalThis.__hmSourceTransactionTrace.length > 100) {
        globalThis.__hmSourceTransactionTrace.shift()
      }
    }

    if (changed) onTransactions?.(applied.transactions, oldState, applied.state)
    view.updateState(applied.state)
  }
}
