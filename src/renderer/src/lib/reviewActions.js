// CriticMarkup review actions on the active (or focused-split) tab.
// Extracted verbatim in behavior from App.jsx (phase-2 refactor, US-1).
//
// `pickEditableId` is shared with the save/export handlers in App.jsx (it's a
// pane-targeting concern, not review-specific), so App keeps it and passes it
// in. Everything else here is review-only: resolve the editable tab, then apply
// a markup kind / run an accept-or-reject decision / copy the AI prompt.
//
// Two paths per action:
//   - source textarea (plain-text / heavy-as-source / global source mode): edit
//     the raw markdown string via reviewMarkup, write it back through
//     updateContent, and restore the selection.
//   - rich editor: delegate to the tab's editor API (applyReviewMarkup) which
//     decorates the ProseMirror selection.
//
// Options:
//   pickEditableId  — () => tab id of the pane to target (left active, or the
//                     last-focused split pane)
//   tabsRef         — ref to the live tabs array
//   sourceTextareas — ref map of tab id → source-mode <textarea>
//   editorApis      — ref map of tab id → rich editor API
//   setHome         — leave the Home screen so the action targets a visible doc
//   updateContent   — App's tab-content setter (id, md, isInitial)
//   setTabs         — App's tabs setter (used by the accept/reject decision)
//   tRef            — ref to the translator ((key, vars) => string)
import { fireToast, copyToClipboard } from '../ui.js'
import { isHeavyDoc } from '../paths.js'
import {
  wrapReviewSelection,
  applyReviewDecision,
  buildReviewAiPrompt,
  normalizeReviewMarkupMarkdown
} from '../reviewMarkup.js'

export function createReviewActions({ pickEditableId, tabsRef, sourceTextareas, editorApis, setHome, updateContent, setTabs, tRef }) {
  const getEditableTab = () => {
    const id = pickEditableId()
    return tabsRef.current.find((tab) => tab.id === id) || null
  }

  const applyReviewMarkupToActive = (kind) => {
    const tab = getEditableTab()
    if (!tab) {
      fireToast(tRef.current('review.noDocument'))
      return
    }

    setHome(false)
    const sourceEl = sourceTextareas.current[tab.id]
    if (sourceEl) {
      const result = wrapReviewSelection(tab.content, sourceEl.selectionStart, sourceEl.selectionEnd, kind)
      if (result.error === 'multiline') {
        fireToast(tRef.current('review.inlineOnly'))
        return
      }
      const editedEl = sourceEl
      updateContent(tab.id, normalizeReviewMarkupMarkdown(result.text), false)
      requestAnimationFrame(() => {
        if (sourceTextareas.current[tab.id] === editedEl) {
          editedEl.focus()
          editedEl.setSelectionRange(result.selectionStart, result.selectionEnd)
        }
      })
      return
    }

    const applied = editorApis.current[tab.id]?.applyReviewMarkup?.(kind)
    if (applied == null) fireToast(tRef.current('review.noDocument'))
  }

  const applyReviewDecisionToActive = (decision) => {
    const tab = getEditableTab()
    if (!tab) {
      fireToast(tRef.current('review.noDocument'))
      return
    }

    const next = applyReviewDecision(tab.content, decision)
    if (next === tab.content) {
      fireToast(tRef.current('review.noMarks'))
      return
    }

    setHome(false)
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tab.id
          ? { ...t, content: next, reloadNonce: t.reloadNonce + 1, heavy: isHeavyDoc(next) }
          : t
      )
    )
    fireToast(tRef.current(decision === 'accept' ? 'review.acceptedAll' : 'review.rejectedAll'))
  }

  const copyReviewPrompt = () => {
    const tab = getEditableTab()
    if (!tab) {
      fireToast(tRef.current('review.noDocument'))
      return
    }
    copyToClipboard(buildReviewAiPrompt(tab.content), tRef.current('review.promptCopied'))
  }

  return { applyReviewMarkupToActive, applyReviewDecisionToActive, copyReviewPrompt, getEditableTab }
}
