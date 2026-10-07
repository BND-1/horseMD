import { imageBlockSchema } from '@milkdown/kit/component/image-block'

const ratioPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/

function parseLegacyRatio(value) {
  if (typeof value !== 'string' || !ratioPattern.test(value)) return null
  const ratio = Number(value)
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null
}

function imageText(value) {
  return typeof value === 'string' ? value : ''
}

// Crepe's image-block component uses Markdown's image `alt` field to persist
// its resize ratio and puts the visible caption in `title`. That rewrites a
// normal `![description](url)` as `![1.00](url)` after the next rich edit.
// Keep an explicit alt attribute in the ProseMirror node, while still reading
// the numeric syntax emitted by earlier HorseMD versions for resized images.
export const imageBlockMarkdownSchema = imageBlockSchema.extendSchema((prev) => (ctx) => {
  const schema = prev(ctx)

  return {
    ...schema,
    attrs: {
      ...schema.attrs,
      alt: { default: '', validate: 'string' }
    },
    parseMarkdown: {
      match: ({ type }) => type === 'image-block',
      runner: (state, node, type) => {
        const alt = imageText(node.alt)
        const title = imageText(node.title)
        const legacyRatio = parseLegacyRatio(alt)
        const isLegacyImage = legacyRatio !== null && Boolean(title)

        state.addNode(type, {
          src: imageText(node.url),
          alt: isLegacyImage ? '' : alt,
          caption: isLegacyImage ? title : title || alt,
          ratio: legacyRatio ?? 1
        })
      }
    },
    toMarkdown: {
      match: (node) => node.type.name === 'image-block',
      runner: (state, node) => {
        const alt = imageText(node.attrs.alt)
        const caption = imageText(node.attrs.caption)
        const ratio = Number(node.attrs.ratio)
        const resized = Number.isFinite(ratio) && ratio > 0 && Math.abs(ratio - 1) > 0.001

        state.openNode('paragraph')
        state.addNode('image', undefined, undefined, {
          url: imageText(node.attrs.src),
          // Keep the historical numeric ratio only when a user has actually
          // resized an image. Default-size images use standard Markdown alt.
          alt: resized ? ratio.toFixed(2) : alt || caption,
          title: resized ? caption || undefined : caption && caption !== alt ? caption : undefined
        })
        state.closeNode()
      }
    }
  }
})
