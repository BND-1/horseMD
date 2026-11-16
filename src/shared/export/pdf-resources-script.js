// Runs inside the page that is about to be printed (desktop BrowserWindow,
// phone WKWebView / Android WebView): waits for images and fonts and wraps
// over-wide display math. Resolves to a summary object.
export const printableResourcesScript = ({ resourceWaitMs = 12000, fontWaitMs = 1500 } = {}) => `
  (() => {
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), ${resourceWaitMs}))
    const documentImages = [...document.images]
    const images = documentImages.map((image) => {
      if (image.complete) return Promise.resolve()
      return new Promise((resolve) => {
        image.addEventListener('load', resolve, { once: true })
        image.addEventListener('error', resolve, { once: true })
      })
    })
    // MathML has no useful CSS wrapping primitive: long expressions are one
    // unbreakable inline layout run. Never shrink them to an unreadable size.
    // Instead, PDF-only output clones the presentation row and breaks at its
    // top-level operators. The live editor and exported source HTML stay intact.
    const presentationRow = (math) =>
      math.querySelector(':scope > semantics > mrow') || math.querySelector(':scope > mrow')
    const breakOperator = (node) =>
      node?.nodeType === Node.ELEMENT_NODE && node.localName === 'mo' &&
      /^[+=\\-\\u00b1,;]$/.test((node.textContent || '').trim())
    const lineMath = (math, row, children, start, end) => {
      const line = math.cloneNode(false)
      line.setAttribute('display', 'block')
      const lineRow = row.cloneNode(false)
      children.slice(start, end).forEach((child) => lineRow.appendChild(child.cloneNode(true)))
      const semantics = math.querySelector(':scope > semantics')
      if (semantics) {
        const lineSemantics = semantics.cloneNode(false)
        lineSemantics.appendChild(lineRow)
        line.appendChild(lineSemantics)
      } else {
        line.appendChild(lineRow)
      }
      return line
    }
    const wrapDisplayMath = () => [...document.querySelectorAll('.doc math[display="block"]')]
      .reduce((wrapped, math) => {
        const parent = math.parentElement
        const available = parent?.getBoundingClientRect().width || document.documentElement.clientWidth
        if (!available || math.getBoundingClientRect().width <= available + 0.5) return wrapped
        const row = presentationRow(math)
        const children = row ? [...row.children] : []
        if (children.length < 3 || !children.some(breakOperator)) return wrapped

        const measure = document.createElement('span')
        measure.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;white-space:nowrap;left:-10000px;top:0'
        parent.appendChild(measure)
        const lines = []
        let start = 0
        try {
          while (start < children.length) {
            let lastFit = start
            let lastBreak = -1
            let finished = false
            for (let end = start + 1; end <= children.length; end += 1) {
              measure.replaceChildren(lineMath(math, row, children, start, end))
              if (measure.getBoundingClientRect().width <= available + 0.5 || end === start + 1) {
                lastFit = end
                if (breakOperator(children[end - 1])) lastBreak = end
                if (end === children.length) {
                  lines.push([start, end])
                  finished = true
                  break
                }
                continue
              }
              const next = lastBreak > start ? lastBreak : lastFit
              if (next <= start) return wrapped
              lines.push([start, next])
              start = next
              finished = true
              break
            }
            if (!finished) return wrapped
            if (lines.at(-1)?.[1] === children.length) break
          }
        } finally {
          measure.remove()
        }
        if (lines.length < 2) return wrapped
        const wrapper = document.createElement('div')
        wrapper.className = 'hm-pdf-math-wrap'
        lines.forEach(([start, end]) => wrapper.appendChild(lineMath(math, row, children, start, end)))
        math.replaceWith(wrapper)
        return wrapped + 1
      }, 0)
    const fonts = document.fonts?.ready
      ? Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, ${fontWaitMs}))])
      : Promise.resolve()
    return Promise.race([
      Promise.all(images).then(() => 'ready'),
      timeout
    ]).then(async (imageStatus) => {
      await fonts
      return {
        imageStatus,
        totalImages: documentImages.length,
        failedImages: documentImages.filter((image) => image.complete && !image.naturalWidth).length,
        pendingImages: documentImages.filter((image) => !image.complete).length,
        wrappedMath: wrapDisplayMath()
      }
    })
  })()
`
