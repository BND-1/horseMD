// Rich-text copy: inline a curated set of light-theme styles onto cloned content
// so pasted output keeps its formatting in apps that ignore external CSS
// (WeChat, email, Notion…).

const COPY_STYLES = {
  H1: 'font-size:1.8em;font-weight:700;line-height:1.3;margin:0.6em 0 0.4em;',
  H2: 'font-size:1.5em;font-weight:700;line-height:1.3;margin:0.6em 0 0.4em;',
  H3: 'font-size:1.3em;font-weight:600;line-height:1.3;margin:0.6em 0 0.4em;',
  H4: 'font-size:1.1em;font-weight:600;margin:0.6em 0 0.3em;',
  H5: 'font-size:1em;font-weight:600;margin:0.6em 0 0.3em;',
  H6: 'font-size:1em;font-weight:600;color:#57606a;margin:0.6em 0 0.3em;',
  P: 'margin:0.6em 0;line-height:1.7;',
  STRONG: 'font-weight:700;',
  B: 'font-weight:700;',
  EM: 'font-style:italic;',
  I: 'font-style:italic;',
  A: 'color:#0969da;text-decoration:underline;',
  BLOCKQUOTE: 'border-left:4px solid #d0d7de;padding-left:14px;color:#57606a;margin:0.6em 0;',
  PRE: 'background:#f6f8fa;padding:14px 16px;border-radius:8px;overflow:auto;font-family:Consolas,Monaco,monospace;font-size:0.9em;line-height:1.5;margin:0.6em 0;',
  // WeChat's editor strips list CSS and re-flows <ol> markers as hanging
  // boxes, which pushes the number onto its own line and the text below it.
  // `list-style-position:inside` draws the marker INSIDE the li's line box
  // (it survives sanitizers that drop external/unknown CSS), and the
  // explicit display:list-item keeps <li> rendering as a list item even
  // where the surrounding <ol>/<ul> styles are discarded.
  UL: 'padding-left:1.6em;margin:0.6em 0;list-style-position:inside;',
  OL: 'padding-left:1.6em;margin:0.6em 0;list-style-position:inside;list-style-type:decimal;',
  LI: 'margin:0.3em 0;line-height:1.7;display:list-item;list-style-position:inside;',
  TABLE: 'border-collapse:collapse;margin:0.6em 0;',
  TH: 'border:1px solid #d0d7de;padding:6px 12px;background:#f6f8fa;font-weight:700;text-align:left;',
  TD: 'border:1px solid #d0d7de;padding:6px 12px;',
  HR: 'border:none;border-top:1px solid #d0d7de;margin:1em 0;',
  IMG: 'max-width:100%;'
}

const INLINE_SOFT_BREAK = 'span[data-type="hardbreak"][data-is-inline="true"]'

// Ordinary Markdown newlines are represented by Milkdown as space-only spans
// and become visual line feeds through CSS. Clipboard targets cannot see that
// pseudo-element, so materialize it only in the cloned clipboard fragment.
export function materializeCopiedSoftBreaks(root) {
  root.querySelectorAll(INLINE_SOFT_BREAK).forEach((node) => {
    node.replaceWith(document.createElement('br'))
  })
}

export function copiedPlainText(root, fallback = '') {
  // Lists need a manual serialization: Chromium's innerText does not include
  // ::marker content, so an <ol> copy would lose its numbers in the plain
  // flavor entirely (WeChat sometimes prefers text/plain). Render each item
  // as "N. text" / "- text" with nesting, matching the visual marker.
  if (root.querySelector('ol, ul, li')) {
    const text = listAwarePlainText(root)
    if (text) return text
  }
  if (!root.querySelector('br')) return fallback
  const probe = root.cloneNode(true)
  probe.setAttribute(
    'style',
    'position:fixed;left:-100000px;top:0;width:1000px;white-space:normal;'
  )
  probe.setAttribute('aria-hidden', 'true')
  document.body.appendChild(probe)
  const text = probe.innerText
  probe.remove()
  return text || fallback
}

const listAwarePlainText = (root) => {
  const lines = []
  const INDENT = '  '
  const walk = (parent, depth) => {
    let orderedIndex = 0
    for (const child of [...parent.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) continue
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const tag = child.tagName
      if (tag === 'OL' || tag === 'UL') {
        walk(child, depth + 1)
        continue
      }
      if (tag === 'LI') {
        const isOrdered = parent.tagName === 'OL'
        orderedIndex += 1
        const own = [...child.childNodes].filter((node) =>
          !(node.nodeType === Node.ELEMENT_NODE && (node.tagName === 'OL' || node.tagName === 'UL')))
        const text = own.map((node) => node.textContent || '').join('').trim()
        const marker = isOrdered ? `${orderedIndex}. ` : '- '
        lines.push(`${INDENT.repeat(Math.max(0, depth - 1))}${marker}${text}`)
        child.querySelectorAll(':scope > ol, :scope > ul').forEach((nested) => walk(nested, depth))
        continue
      }
      // Editor scaffolding wrappers (data-v-app / content-dom divs) hold the
      // lists inside — keep descending instead of flattening their text; a
      // wrapper with no list inside is ordinary block content.
      if (child.querySelector('ol, ul, li')) {
        walk(child, depth)
      } else {
        const text = (child.textContent || '').trim()
        if (text) lines.push(text)
      }
    }
  }
  walk(root, 0)
  return lines.join('\n')
}

export function inlineRichStyles(root, { selectionOrderedLists = false } = {}) {
  root.querySelectorAll('*').forEach((el) => {
    // strip editor-only attributes
    el.removeAttribute('class')
    el.removeAttribute('contenteditable')
    el.removeAttribute('data-hm-resolved')

    const tag = el.tagName
    if (tag === 'CODE') {
      // Inline code vs. code inside a <pre> block.
      if (el.closest('pre')) {
        el.setAttribute('style', 'background:none;padding:0;color:inherit;font-family:inherit;')
      } else {
        el.setAttribute(
          'style',
          'background:#f2f2f2;color:#c0341d;padding:2px 5px;border-radius:4px;font-family:Consolas,Monaco,monospace;font-size:0.9em;'
        )
      }
      return
    }
    const style = COPY_STYLES[tag]
    if (style) el.setAttribute('style', style)
  })
  unwrapScaffoldingContainers(root)
  flattenListItemContents(root)
  wrapOrphanListItems(root, { selectionOrderedLists })
}

// The selection clone wraps each top-level block in editor scaffolding
// (<div data-v-app>, content-dom wrappers). Between two cloned <li>s that
// scaffolding breaks DOM adjacency, so orphan-run grouping would wrap EACH
// item in its own one-item list (ordered numbering restarts at 1 per item).
// Hoist the children of the two known scaffolding wrappers out so cloned
// siblings become real siblings again.
const unwrapScaffoldingContainers = (root) => {
  // Innermost first, so nested scaffolding unwraps cleanly in one sweep.
  const wrappers = [...root.querySelectorAll('div[data-v-app], div[data-content-dom]')]
    .reverse()
  wrappers.forEach((wrapper) => {
    const parent = wrapper.parentElement
    if (!parent) return
    while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper)
    wrapper.remove()
  })
}

// Milkdown renders each li's paragraph inside editor scaffolding:
// <li><div><div data-content-dom><p>text</p></div></div></li>. The marker is
// positioned INSIDE the li's first line box (list-style-position:inside), so a
// BLOCK-level <p> first child puts the marker on a line of its own — that is
// exactly the WeChat paste bug ("1." alone, text below). Unwrap every li's
// element children down to inline content: the paragraph's inline nodes move
// directly into the li, preserving marks/links/inline code.
const flattenListItemContents = (root) => {
  root.querySelectorAll('li').forEach((li) => {
    // Repeat until the li's children are text/inline only (nested lists keep
    // their own <ul>/<ol>, which must stay block-level).
    for (let pass = 0; pass < 5; pass += 1) {
      const blockChild = [...li.children].find((child) =>
        child.tagName !== 'UL' && child.tagName !== 'OL' && !INLINE_TAGS.has(child.tagName))
      if (!blockChild) break
      const parent = blockChild.parentElement
      while (blockChild.firstChild) parent.insertBefore(blockChild.firstChild, blockChild)
      blockChild.remove()
    }
    // Milkdown draws its OWN marker ("1.", "•") as the first inline span of
    // the item. The clipboard fragment is a real <ol>/<ul>, whose numbering
    // draws the marker again — keeping both renders "1. 1. text" (or a bare
    // marker line when the sanitizer drops list CSS). Drop the duplicate.
    const first = li.firstElementChild
    if (first?.tagName === 'SPAN' && /^(?:\d{1,9}[.)]|[-*•·])$/.test((first.textContent || '').trim())) {
      first.remove()
    }
    const firstText = li.firstChild
    if (firstText?.nodeType === Node.TEXT_NODE && /^(?:\d{1,9}[.)]|[-*•·])\s*$/.test(firstText.nodeValue)) {
      firstText.remove()
    }
  })
}
const INLINE_TAGS = new Set([
  'SPAN', 'STRONG', 'B', 'EM', 'I', 'A', 'CODE', 'BR', 'U', 'INS', 'DEL',
  'SUB', 'SUP', 'MARK', 'SMALL', 'ABBR', 'CITE', 'Q', 'SAMP', 'VAR', 'KBD',
  'IMG', 'INPUT', 'LABEL', 'FONT', 'S', 'STRIKE', 'TT', 'BIG'
])

// A mid-list selection clones the <li> elements WITHOUT their <ol>/<ul>
// wrapper (the wrapper node sits outside the cloned range). Bare <li> pasted
// into WeChat loses the ordered marker entirely — the engine shows a disc or
// nothing, and any surviving marker wraps onto its own line. Re-wrap each
// consecutive same-parent run of wrapper-less items in an <ol>/<ul> carrying
// the same inline styles.
const wrapOrphanListItems = (root, { selectionOrderedLists = false } = {}) => {
  const orphans = [...root.querySelectorAll('li')].filter((li) => !li.closest('ol,ul'))
  if (!orphans.length) return
  // Group by parent + DOM adjacency: a run ends when the next orphan's
  // previous sibling isn't the previous orphan (non-list content between).
  const runs = []
  for (const li of orphans) {
    const lastRun = runs.at(-1)
    const previous = lastRun?.at(-1)
    if (lastRun && li.parentElement === previous?.parentElement && li.previousElementSibling === previous) {
      lastRun.push(li)
    } else {
      runs.push([li])
    }
  }
  for (const run of runs) {
    // The cloned <li> lost its <ol>/<ul> ancestor, so the wrapper type must
    // come from the LIVE selection the caller inspected (a partial ordered
    // list copy must stay numbered — a <ul> wrapper would render bullets).
    const ordered = selectionOrderedLists
    const wrapper = document.createElement(ordered ? 'ol' : 'ul')
    wrapper.setAttribute('style', COPY_STYLES[ordered ? 'OL' : 'UL'])
    run[0].before(wrapper)
    run.forEach((li) => wrapper.appendChild(li))
  }
}
