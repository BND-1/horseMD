// CJK-friendly GFM strikethrough (parse side), like remark-cjk-friendly for
// bold / italic: `说「~~重点」内容~~` and `前文~~==x==~~后` (a highlight or code
// inside) are struck text, as in Typora. Plain GFM pairs `~~` by CommonMark
// flanking and leaves them literal. Only the micromark extension is used —
// remark-cjk-friendly-gfm-strikethrough also wires a serializer that needs a
// newer mdast-util-to-markdown; ours is `deleteStringifyHandler`
// (remark-text-handler.js). `singleTilde: false` as in our GFM options.
import { gfmStrikethroughCjkFriendly } from 'micromark-extension-cjk-friendly-gfm-strikethrough'

//
// It must REPLACE GFM's tokenizer: micromark tries constructs registered
// later first, but Milkdown's GFM preset adds remark-gfm after our plugins,
// so GFM's `~~` won and this one never ran. Renamed, with GFM's
// `strikethrough` disabled by name, the order no longer matters.
export function cjkFriendlyStrikethroughExtension() {
  const extension = gfmStrikethroughCjkFriendly({ singleTilde: false })
  const tokenizer = { ...extension.text[126], name: 'strikethroughCjkFriendly' }
  return {
    ...extension,
    text: { 126: tokenizer },
    insideSpan: { null: [tokenizer] },
    disable: { null: ['strikethrough'] }
  }
}

export default function remarkCjkFriendlyStrikethrough() {
  const data = this.data()
  ;(data.micromarkExtensions || (data.micromarkExtensions = [])).push(cjkFriendlyStrikethroughExtension())
}
