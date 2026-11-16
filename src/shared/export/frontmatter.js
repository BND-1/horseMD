// The export snapshot turns the YAML front matter card into
// <section class="hm-frontmatter-export"> (editor-pdf-content.js). Exports
// show it by default (the editor shows it too); includeFrontmatter: false
// leaves it out of the document entirely.
const FRONTMATTER_SECTION = /<section class="hm-frontmatter-export"[^>]*>[\s\S]*?<\/section>/g

export function withoutFrontmatter(html) {
  return String(html || '').replace(FRONTMATTER_SECTION, '')
}
