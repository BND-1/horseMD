// Tiny shared UI helpers used across components.

// Transient toast channel. App listens for this event and shows a bottom-center
// toast; anyone can fire it. Keeping the channel name in one place avoids a typo
// silently breaking toasts (no compile error on a mismatched string literal).
export const HM_TOAST_EVENT = 'hm:toast'
export const fireToast = (msg) => window.dispatchEvent(new CustomEvent(HM_TOAST_EVENT, { detail: msg }))

// Copy text to the clipboard and toast `doneMsg` on success (errors swallowed).
export const copyToClipboard = (text, doneMsg) =>
  navigator.clipboard
    ?.writeText(text || '')
    .then(() => fireToast(doneMsg))
    .catch(() => {})
