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

// Typora's base styles are weak, so a theme's bare `h2 { … }` / `p { … }`
// always wins there. Ours are not (`.milkdown .ProseMirror h2`), so such
// themes (LapisCV, #154) lost their sizes, fonts, margins and colors. Rewrite
// every rule to carry one extra ID of specificity — uniformly, so the theme's
// own cascade order is unchanged:
//   - selectors already about the writing area (#write / .markdown-body) or
//     reaching into it from body get an always-true `:not(#hm-theme)`
//     ancestor;
//   - other selectors are scoped as `#write …`, which also keeps a theme's
//     `p, li { … }` off the app chrome (sidebar, menus);
//   - root rules (html / body / :root on their own) are left as they are.
// The browser parses the CSS (CSSOM), so we never hand-tokenize it.
const THEME_BOOST = ':not(#hm-theme)'
const WRITE_HOOK_RE = /#write(?![\w-])|\.markdown-body(?![\w-])/

const splitSelectorList = (text) => {
  const parts = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim()).filter(Boolean)
}

const hasTopLevelCombinator = (selector) => {
  let depth = 0
  for (const char of selector) {
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    else if (depth === 0 && /[\s>+~]/.test(char)) return true
  }
  return false
}

export function scopeThemeSelector(selector) {
  const value = selector.trim()
  if (!value || value.startsWith(THEME_BOOST)) return value
  if (/^(html|:root)(?![\w-])/i.test(value)) return value
  if (/^body(?![\w-])/i.test(value)) return hasTopLevelCombinator(value) ? `${THEME_BOOST} ${value}` : value
  if (WRITE_HOOK_RE.test(value)) return `${THEME_BOOST} ${value}`
  return `#write ${value}`
}

// User CSS snippets (#81) compose on top of the theme. Give them the same
// one-ID boost (without the #write scoping — a snippet may target the app
// chrome or `.milkdown .ProseMirror …`), so snippet-vs-theme priority is
// exactly what it was before themes were boosted.
export function boostUserSelector(selector) {
  const value = selector.trim()
  if (!value || value.startsWith(THEME_BOOST)) return value
  if (/^(html|:root)(?![\w-])/i.test(value)) return value
  return `${THEME_BOOST} ${value}`
}

const ROOT_SELECTOR_RE = /^(html|body|:root)(?![\w-])/i
const paintsBackground = (style) =>
  Boolean(style.backgroundColor || style.backgroundImage || style.getPropertyValue('--bg-color'))

// The page itself: html / body / :root / #write as the selector's subject,
// not a descendant like `#write pre`.
const lastCompound = (selector) => {
  let depth = 0
  let start = 0
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index]
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    else if (depth === 0 && /[\s>+~]/.test(char)) start = index + 1
  }
  return selector.slice(start)
}
const paintsPage = (selector) => {
  const subject = lastCompound(selector.trim())
  return ROOT_SELECTOR_RE.test(subject) || WRITE_HOOK_RE.test(subject)
}

const scopeRules = (rules, meta, mapSelector, print = false) => {
  for (const rule of rules) {
    if (rule.type === 1 /* STYLE_RULE */) {
      if (!print && !meta.background && paintsBackground(rule.style) &&
        splitSelectorList(rule.selectorText).some(paintsPage)) {
        meta.background = true
      }
      const scoped = splitSelectorList(rule.selectorText).map(mapSelector).join(', ')
      if (scoped !== rule.selectorText) rule.selectorText = scoped
    } else if (rule.cssRules && rule.type !== 7 /* KEYFRAMES */) {
      // @media / @supports / @layer / @container blocks.
      const mediaText = rule.media?.mediaText || ''
      scopeRules(rule.cssRules, meta, mapSelector, print || (/\bprint\b/i.test(mediaText) && !/\b(screen|all)\b/i.test(mediaText)))
    }
  }
}

// Returns { css, background }: `background` is whether the CSS paints the
// page itself (html / body / :root / #write); a theme that does not gets
// Typora's default white page (`hm-theme-default-bg`).
const rewriteCss = (css, mapSelector) => {
  if (typeof CSSStyleSheet === 'undefined') return { css, background: true }
  const meta = { background: false }
  try {
    // Constructed sheets ignore @import; local theme imports were inlined by
    // the main process, remote ones are kept in front (they must lead).
    const imports = css.match(/@import\s[^;]+;/gi) || []
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(css.replace(/@import\s[^;]+;/gi, ''))
    scopeRules(sheet.cssRules, meta, mapSelector)
    return { css: [...imports, ...[...sheet.cssRules].map((rule) => rule.cssText)].join('\n'), background: meta.background }
  } catch {
    return { css, background: true }
  }
}

export const scopeThemeCss = (css) => rewriteCss(css, scopeThemeSelector)
export const boostUserCss = (css) => rewriteCss(css, boostUserSelector).css

export function applyCustomTheme(css) {
  if (!css) {
    if (styleEl) styleEl.textContent = ''
    document.body.classList.remove('hm-has-custom-theme', 'hm-theme-default-bg')
    return
  }
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = 'hm-custom-theme'
    // Append last so it overrides the bundled app/Crepe CSS for equal specificity.
    document.head.appendChild(styleEl)
    watchStyleOrder()
  }
  const scoped = scopeThemeCss(css)
  styleEl.textContent = scoped.css
  document.body.classList.add('hm-has-custom-theme')
  document.body.classList.toggle('hm-theme-default-bg', !scoped.background)
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
  userStyleEl.textContent = boostUserCss(value)
  enforceStyleOrder()
}
