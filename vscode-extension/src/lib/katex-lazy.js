// Lazy KaTeX loading (P8 / issue #126 startup work).
//
// KaTeX is ~470 KB minified. It was statically imported by three consumers
// (math tooltip, html-block math, PDF snapshot), which put it in the eagerly
// parsed main chunk even though most sessions never render a formula. All
// consumers now go through this loader: the first call starts one shared
// dynamic import, later calls await the same promise.
let katexPromise = null

export const loadKatex = () => {
  if (!katexPromise) {
    katexPromise = import('katex').then((mod) => mod.default)
  }
  return katexPromise
}

// Render into a target without blocking the caller. Returns the promise so
// tests can await; rendering errors are swallowed per KaTeX's throwOnError:false
// convention — callers already tolerate failed renders by leaving the raw text.
export const renderKatexInto = async (target, content, options = {}) => {
  const katex = await loadKatex()
  target.innerHTML = katex.renderToString(content, {
    throwOnError: false,
    ...options
  })
}
