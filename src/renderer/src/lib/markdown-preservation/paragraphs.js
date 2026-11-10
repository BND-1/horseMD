

// A `<br />` line is the serializer's empty-paragraph placeholder — but only
// in Markdown text: inside fenced code or a `$$` math block it is the user's
// content (a formula / code line `<br />` used to vanish from new documents).
export const withoutStandaloneEmptyBlockLines = (markdown) => {
  const parts = String(markdown || '').split(/(\r\n|\r|\n)/)
  let fence = null
  let math = false
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]
    const body = line.replace(/^(?:[ \t]*>)*[ \t]*/, '')
    if (fence) {
      const close = body.match(/^(`{3,}|~{3,})\s*$/)
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null
      continue
    }
    if (math) {
      if (/\$\$\s*$/.test(body)) math = false
      continue
    }
    const open = body.match(/^(`{3,}|~{3,})/)
    if (open) { fence = open[1]; continue }
    if (body.startsWith('$$')) {
      const rest = body.slice(2).trim()
      if (!(rest.length > 2 && rest.endsWith('$$'))) math = true
      continue
    }
    const placeholder = line.match(/^((?:[ \t]*>[ \t]*)*)[ \t]*<br\s*\/?>[ \t]*$/i)
    if (placeholder) parts[index] = placeholder[1].replace(/[ \t]+$/, '')
  }
  return parts.join('')
}

