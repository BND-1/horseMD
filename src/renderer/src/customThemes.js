// Apply a user CSS theme (e.g. a migrated Typora theme) by injecting it into a
// dedicated <style> tag, on top of the built-in base theme. Passing null/empty
// removes it. A body marker (.hm-has-custom-theme) lets app.css yield the
// writing-area background/width to the theme while a custom theme is active.
//
// The editor's content element also carries Typora's `#write` / `markdown-body`
// hooks (added in Editor.jsx) so the theme's selectors match our DOM.

let styleEl = null

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
  }
  styleEl.textContent = css
  document.body.classList.add('hm-has-custom-theme')
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
  }
  userStyleEl.textContent = value
}
