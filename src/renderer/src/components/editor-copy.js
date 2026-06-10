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
  UL: 'padding-left:1.6em;margin:0.6em 0;',
  OL: 'padding-left:1.6em;margin:0.6em 0;',
  LI: 'margin:0.3em 0;line-height:1.7;',
  TABLE: 'border-collapse:collapse;margin:0.6em 0;',
  TH: 'border:1px solid #d0d7de;padding:6px 12px;background:#f6f8fa;font-weight:700;text-align:left;',
  TD: 'border:1px solid #d0d7de;padding:6px 12px;',
  HR: 'border:none;border-top:1px solid #d0d7de;margin:1em 0;',
  IMG: 'max-width:100%;'
}

export function inlineRichStyles(root) {
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
}
