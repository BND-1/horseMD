// Tiny shared UI helpers used across components.

// Transient toast channel. App listens for this event and shows a bottom-center
// toast; anyone can fire it. Keeping the channel name in one place avoids a typo
// silently breaking toasts (no compile error on a mismatched string literal).
export const HM_TOAST_EVENT = 'hm:toast'
// opts.sticky → the prominent centered style with a ✕ to dismiss.
// opts.duration → ms before it auto-hides (omit/0 for the default short toast;
// a sticky toast with no duration stays until the ✕ is tapped).
export const fireToast = (msg, opts) =>
  window.dispatchEvent(
    new CustomEvent(HM_TOAST_EVENT, {
      detail: opts ? { msg, sticky: !!opts.sticky, duration: opts.duration } : msg
    })
  )

// Desktop `file://` renderers are not guaranteed Clipboard API permission.
// Prefer the trusted Electron bridge there; mobile/browser builds retain the
// standards-based path.
export const copyToClipboard = async (text, doneMsg) => {
  const value = String(text ?? '')
  try {
    if (typeof window.api?.copyText === 'function') {
      if (await window.api.copyText(value) === false) return false
    } else {
      if (!navigator.clipboard?.writeText) return false
      await navigator.clipboard.writeText(value)
    }
    fireToast(doneMsg)
    return true
  } catch {
    return false
  }
}
