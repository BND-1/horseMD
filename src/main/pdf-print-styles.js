const paginationCss = (pagination) => {
  if (/^h[1-3]$/.test(pagination)) {
    return `.doc ${pagination}:not(:first-child) { break-before: page; page-break-before: always; }`
  }
  if (pagination === 'hr') {
    return '.doc hr { border: 0; margin: 0; height: 0; break-after: page; page-break-after: always; }'
  }
  return ''
}

const BASE_PDF_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .doc {
    font-family: 'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Hiragino Sans GB',
      'Source Han Sans SC', 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
    font-size: 14.5px; line-height: 1.75; color: #2a2620;
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
    overflow-wrap: anywhere;
  }
  .doc > :first-child { margin-top: 0 !important; }
  .doc h1, .doc h2, .doc h3, .doc h4, .doc h5, .doc h6 {
    color: #16130e; font-weight: 700; line-height: 1.3; margin: 1.6em 0 0.6em;
    break-after: avoid; page-break-after: avoid; letter-spacing: 0;
  }
  .doc h1 { font-size: 2em; padding-bottom: 0.3em; border-bottom: 2px solid #e6e1d8; }
  .doc h2 { font-size: 1.5em; padding-bottom: 0.2em; border-bottom: 1px solid #ece7de; }
  .doc h3 { font-size: 1.25em; }
  .doc h4 { font-size: 1.05em; }
  .doc h5 { font-size: 1em; }
  .doc h6 { font-size: 0.92em; color: #6b655c; }
  .doc p { margin: 0.85em 0; }
  .doc a { color: #c86b35; text-decoration: none; border-bottom: 1px solid rgba(200,107,53,.35); }
  .doc strong { font-weight: 700; color: #16130e; }
  .doc em { font-style: italic; }
  .doc ul, .doc ol { margin: 0.8em 0; padding-left: 1.6em; }
  .doc li { margin: 0.32em 0; }
  .doc li::marker { color: #c86b35; }
  .doc blockquote {
    margin: 1em 0; padding: 0.5em 1.1em; border-left: 3px solid #c86b35;
    background: rgba(200,107,53,.06); color: #6b655c; border-radius: 0 6px 6px 0;
    break-inside: avoid; page-break-inside: avoid;
  }
  .doc blockquote p { margin: 0.3em 0; }
  .doc code {
    font-family: 'SF Mono', SFMono-Regular, Consolas, Monaco, monospace; font-size: 0.88em;
    background: #f4f1ea; padding: 0.12em 0.4em; border-radius: 4px; color: #b3431f;
  }
  .doc pre {
    background: #f4f1ea; border: 1px solid #e6e1d8; border-radius: 8px;
    padding: 14px 16px; margin: 1em 0; overflow: hidden;
    break-inside: avoid; page-break-inside: avoid;
  }
  .doc pre code {
    background: none; padding: 0; color: #2a2620; font-size: 0.86em; line-height: 1.6;
    white-space: pre-wrap; word-break: break-word;
  }
  .doc table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.95em; }
  .doc thead { display: table-header-group; }
  .doc tr { break-inside: avoid; page-break-inside: avoid; }
  .doc th, .doc td { border: 1px solid #e6e1d8; padding: 8px 12px; text-align: left; vertical-align: top; }
  .doc th { background: #f4f1ea; font-weight: 700; color: #16130e; }
  .doc tr:nth-child(even) td { background: #faf8f4; }
  .doc img, .doc svg { max-width: 100%; height: auto; display: block; margin: 1em auto; break-inside: avoid; }
  .doc img { border-radius: 6px; }
  .doc figure {
    margin: 1.1em 0; text-align: center; break-inside: avoid; page-break-inside: avoid;
  }
  .doc math { font-size: 1.05em; }
  .doc math[display="block"] {
    display: inline-block; max-width: 100%; overflow-x: auto;
    font-size: 1.18em; break-inside: avoid; page-break-inside: avoid;
  }
  .doc hr { border: none; border-top: 1px solid #e6e1d8; margin: 1.8em 0; }
  .doc input[type="checkbox"] { margin-right: 0.4em; }
  .pdf-toc { font-family: 'Helvetica Neue', Helvetica, Arial, 'PingFang SC', sans-serif; color: #2a2620; }
  .pdf-toc.break-after { break-after: page; page-break-after: always; }
  .pdf-toc.break-after + .doc { break-before: page; page-break-before: always; }
  .pdf-toc h1 { margin: 0 0 1.2em; font-size: 2em; color: #16130e; letter-spacing: 0; }
  .pdf-toc ol { list-style: none; margin: 0; padding-left: 0; }
  .pdf-toc ol ol { padding-left: 1.35em; }
  .pdf-toc li { margin: 0.45em 0; break-inside: avoid; }
  .pdf-toc a { color: inherit; text-decoration: none; border-bottom: 1px dotted #c8c1b7; }
`

export function buildPdfPrintStyles(page) {
  const { top, right, bottom, left } = page.margins
  return `@page { size: ${page.width}mm ${page.height}mm; margin: ${top}mm ${right}mm ${bottom}mm ${left}mm; }\n${BASE_PDF_CSS}\n${paginationCss(page.pagination)}`
}
