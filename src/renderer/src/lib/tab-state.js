// A rich ProseMirror edit reaches Milkdown's Markdown serializer on a short
// debounce. Keep that serialization separate from the user-facing dirty signal:
// a pending rich edit means the document has visibly changed, even though
// `content` has not received its source-preserving Markdown snapshot yet.
export function isTabDirty(tab) {
  return !!tab && (tab.content !== tab.savedContent || tab.pendingRichEdit === true)
}
