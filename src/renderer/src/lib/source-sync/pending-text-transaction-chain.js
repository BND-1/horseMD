import { sameSourceSyncDocument } from './top-level-subtree.js'

const rejected = (reason, proof = null) => Object.freeze({ ok: false, reason, proof })

const closedPlainTextSlice = (slice) => {
  if (!slice || slice.size === 0 || slice.content?.size === 0) return true
  if (slice.openStart || slice.openEnd) return false
  let plain = true
  slice.content.forEach?.((node) => {
    if (!node?.isText || (node.marks?.length || 0) > 0) plain = false
  })
  return plain
}

const plainTextReplaceStep = (step) => Boolean(
  step?.constructor?.name === 'ReplaceStep' &&
  step.structure !== true &&
  Number.isFinite(step.from) &&
  Number.isFinite(step.to) &&
  closedPlainTextSlice(step.slice)
)

const stepProof = (step) => Object.freeze({
  name: step?.constructor?.name || 'UnknownStep',
  from: Number.isFinite(step?.from) ? step.from : null,
  to: Number.isFinite(step?.to) ? step.to : null,
  structure: step?.structure === true,
  sliceSize: Number.isFinite(step?.slice?.size) ? step.slice.size : null,
  openStart: Number.isFinite(step?.slice?.openStart) ? step.slice.openStart : null,
  openEnd: Number.isFinite(step?.slice?.openEnd) ? step.slice.openEnd : null
})

/**
 * Proves one revision-bound Journal as:
 *
 *   0..N closed plain-text ReplaceSteps + optional one terminal Step.
 *
 * This helper deliberately does not know about blockquote/list/table topology or
 * Markdown. Family owners provide terminal matching and a post-replay target
 * validator. Publication remains family-specific and happens only after this
 * proof succeeds.
 */
export function provePendingTextTransactionChain({
  journal,
  expectedDoc,
  reasonPrefix = 'pending-text-chain',
  matchTerminalStep = null,
  requireTerminal = false,
  requireTerminalOwnTransaction = true,
  validateTextChain = null
} = {}) {
  if (!journal?.oldDoc || !expectedDoc || !Array.isArray(journal.entries)) {
    return rejected(`${reasonPrefix}-document-missing`)
  }
  if (requireTerminal && typeof matchTerminalStep !== 'function') {
    return rejected(`${reasonPrefix}-terminal-matcher-missing`)
  }

  let currentDoc = journal.oldDoc
  const textSteps = []
  let terminal = null
  let preTerminalDocument = journal.oldDoc

  for (let entryIndex = 0; entryIndex < journal.entries.length; entryIndex += 1) {
    const entry = journal.entries[entryIndex]
    if (!sameSourceSyncDocument(entry.beforeDoc, currentDoc)) {
      return rejected(`${reasonPrefix}-transaction-chain-mismatch`)
    }
    if (!entry.steps?.length) return rejected(`${reasonPrefix}-step-count`)

    let entryDoc = entry.beforeDoc
    for (let stepIndex = 0; stepIndex < entry.steps.length; stepIndex += 1) {
      if (terminal) return rejected(`${reasonPrefix}-extra-step-after-terminal`)
      const step = entry.steps[stepIndex]
      const stepDoc = entry.stepDocs?.[stepIndex] || (stepIndex === 0 ? entry.beforeDoc : null)
      if (!stepDoc || !sameSourceSyncDocument(stepDoc, entryDoc)) {
        return rejected(`${reasonPrefix}-step-document-missing`)
      }

      let applied
      try { applied = step.apply(stepDoc) } catch { applied = null }
      if (applied?.failed || !applied?.doc) {
        return rejected(`${reasonPrefix}-step-apply-failed`)
      }

      let terminalMatch = null
      if (typeof matchTerminalStep === 'function') {
        try {
          terminalMatch = matchTerminalStep({
            step,
            stepDoc,
            appliedDoc: applied.doc,
            entry,
            entryIndex,
            stepIndex
          })
        } catch (error) {
          return rejected(`${reasonPrefix}-terminal-matcher-threw:${error?.name || 'Error'}`)
        }
      }

      if (terminalMatch?.matched === true) {
        if (
          requireTerminalOwnTransaction &&
          (entry.steps.length !== 1 || stepIndex !== 0)
        ) return rejected(`${reasonPrefix}-terminal-transaction-shape`)
        terminal = Object.freeze({
          entryIndex,
          stepIndex,
          transactionIndex: entryIndex,
          step,
          stepDoc,
          appliedDoc: applied.doc,
          proof: terminalMatch.proof || null,
          stepProof: stepProof(step)
        })
        preTerminalDocument = stepDoc
      } else {
        if (!plainTextReplaceStep(step)) {
          return rejected(`${reasonPrefix}-pre-terminal-step-contract`, {
            entryIndex,
            stepIndex,
            step: stepProof(step)
          })
        }
        textSteps.push(Object.freeze({
          entryIndex,
          stepIndex,
          transactionIndex: entryIndex,
          step,
          stepDoc,
          appliedDoc: applied.doc,
          stepProof: stepProof(step)
        }))
        preTerminalDocument = applied.doc
      }
      entryDoc = applied.doc
    }

    if (!sameSourceSyncDocument(entryDoc, entry.afterDoc)) {
      return rejected(`${reasonPrefix}-transaction-result-mismatch`)
    }
    currentDoc = entry.afterDoc
  }

  if (requireTerminal && !terminal) return rejected(`${reasonPrefix}-terminal-missing`)
  if (!sameSourceSyncDocument(currentDoc, expectedDoc)) {
    return rejected(`${reasonPrefix}-final-document-mismatch`)
  }

  let targetProof = null
  if (typeof validateTextChain === 'function') {
    let validated
    try {
      validated = validateTextChain({
        journal,
        expectedDoc,
        textSteps: Object.freeze(textSteps),
        terminal,
        preTerminalDocument
      })
    } catch (error) {
      return rejected(`${reasonPrefix}-target-validator-threw:${error?.name || 'Error'}`)
    }
    if (validated?.ok !== true) {
      return rejected(validated?.reason || `${reasonPrefix}-target-invalid`, validated?.proof || null)
    }
    targetProof = validated.proof || null
  }

  const textTransactionIndexes = [...new Set(textSteps.map((entry) => entry.transactionIndex))]
  const preTerminalTransactionCount = terminal
    ? terminal.transactionIndex
    : journal.entries.length
  return Object.freeze({
    ok: true,
    textSteps: Object.freeze(textSteps),
    textStepCount: textSteps.length,
    textReplacementStepCount: textSteps.filter(({ step }) => step.from !== step.to).length,
    textTransactionCount: textTransactionIndexes.length,
    preTerminalTransactionCount,
    preTerminalDocument,
    terminal,
    targetProof,
    stepDetails: Object.freeze([
      ...textSteps.map((entry) => entry.stepProof),
      ...(terminal ? [terminal.stepProof] : [])
    ])
  })
}

export const isClosedPlainTextReplaceStep = plainTextReplaceStep
