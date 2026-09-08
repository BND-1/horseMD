// Apply a user CSS theme (e.g. a migrated Typora theme) by injecting it into a
// dedicated <style> tag, on top of the built-in base theme. Passing null/empty
// removes it. A body marker (.hm-has-custom-theme) lets app.css yield the
// writing-area background/width to the theme while a custom theme is active.
//
// The editor's content element also carries Typora's `#write` / `markdown-body`
// hooks (added in Editor.jsx) so the theme's selectors match our DOM.
//
// ORDER GUARANTEE (P8b regression): the editor became a lazily loaded chunk,
// so Crepe's stylesheets (tables.css, code-mirror.css, …) are injected into
// <head> at RUNTIME — after the custom theme style was appended. Equal
// specificity then resolves to Crepe and the user's CSS "stopped working".
// A MutationObserver keeps the owned styles as the tail of <head> in canonical
// order (theme, then user snippets), re-appending them whenever a lazy chunk
// stylesheet lands after them. Moves are idempotent — the observer only acts
// when the tail no longer matches, so it cannot feed itself.

let styleEl = null

// Canonical tail order: the theme first, user snippets last (snippets compose
// on top of the theme, issue #81).
const ORDERED_STYLE_IDS = ['hm-custom-theme', 'hm-user-css']
let orderObserver = null

const ownedStyleElements = () =>
  ORDERED_STYLE_IDS
    .map((id) => document.getElementById(id))
    .filter(Boolean)

const tailMatchesOwnedOrder = (owned) => {
  let node = document.head.lastElementChild
  for (let index = owned.length - 1; index >= 0; index -= 1) {
    if (node !== owned[index]) return false
    node = node.previousElementSibling
  }
  return true
}

const enforceStyleOrder = () => {
  const owned = ownedStyleElements()
  if (!owned.length) return
  if (tailMatchesOwnedOrder(owned)) return
  for (const element of owned) document.head.appendChild(element)
}

const watchStyleOrder = () => {
  if (orderObserver || typeof MutationObserver === 'undefined') return
  orderObserver = new MutationObserver(() => enforceStyleOrder())
  orderObserver.observe(document.head, { childList: true })
}

export function applyCustomTheme(css) {
  if (!css) {
    if (styleEl) styleEl.textContent = ''
    document.body.classList.remove('hm-has-custom-theme')
    return
  }
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = 'hm-custom-theme'
    // Append last so it overrides the bundled app/Crepe CSS for equal specificity.
    document.head.appendChild(styleEl)
    watchStyleOrder()
  }
  styleEl.textContent = css
  document.body.classList.add('hm-has-custom-theme')
  enforceStyleOrder()
}

// User CSS snippets (issue #81) are injected into their own <style> tag after
// a custom theme. Enabled snippets compose in list order, so users can keep a
// reusable typography tweak separate from a theme-specific color adjustment.
let userStyleEl = null

export function applyUserCss(snippets) {
  const value = Array.isArray(snippets)
    ? snippets
      .filter((snippet) => snippet?.enabled !== false && typeof snippet?.css === 'string' && snippet.css.trim())
      .map((snippet) => snippet.css.trim())
      .join('\n\n')
    : typeof snippets === 'string' ? snippets.trim() : ''
  if (!value) {
    if (userStyleEl) userStyleEl.textContent = ''
    return
  }
  if (!userStyleEl) {
    userStyleEl = document.createElement('style')
    userStyleEl.id = 'hm-user-css'
    document.head.appendChild(userStyleEl)
    watchStyleOrder()
  }
  userStyleEl.textContent = value
  enforceStyleOrder()
}
