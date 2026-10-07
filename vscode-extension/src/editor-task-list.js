import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state'

const taskListInputKey = new PluginKey('hm-task-list-input')

function findParagraphDepth($from) {
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth)?.type.name === 'paragraph') return depth
  }
  return -1
}

function createTaskListFromParagraph(state, paragraphDepth, checked) {
  const { schema } = state
  const bulletList = schema.nodes.bullet_list
  const listItem = schema.nodes.list_item
  const paragraph = schema.nodes.paragraph
  if (!bulletList || !listItem || !paragraph) return null

  const emptyParagraph = paragraph.create()
  const taskItem = listItem.create({ checked }, emptyParagraph)
  return bulletList.create(null, taskItem)
}

function createTaskListTransaction(state, paragraphDepth, checked) {
  const { $from } = state.selection
  const taskList = createTaskListFromParagraph(state, paragraphDepth, checked)
  if (!taskList) return null

  const from = $from.before(paragraphDepth)
  const to = $from.after(paragraphDepth)
  let tr = state.tr.replaceWith(from, to, taskList)
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(from + 3, tr.doc.content.size))))
  return tr.scrollIntoView()
}

function convertParagraphToTaskList(view, paragraphDepth, checked) {
  const tr = createTaskListTransaction(view.state, paragraphDepth, checked)
  if (!tr) return false
  view.dispatch(tr)
  return true
}

function taskMarkerMatch(text) {
  return text.match(/^\s*[-*+]\s+\[( |x|X)\]\s*$/)
}

export function createTaskListInputPlugin() {
  return new Plugin({
    key: taskListInputKey,
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged) || !newState.selection.empty) return null

      const { $from } = newState.selection
      const paragraphDepth = findParagraphDepth($from)
      if (paragraphDepth < 0) return null

      const paragraphNode = $from.node(paragraphDepth)
      if ($from.parentOffset < paragraphNode.content.size) return null

      const match = taskMarkerMatch(paragraphNode.textContent || '')
      if (!match) return null

      return createTaskListTransaction(newState, paragraphDepth, match[1].toLowerCase() === 'x')
    },
    props: {
      handleTextInput(view, _from, _to, text) {
        if (view.composing || !text.endsWith(' ')) return false
        const { state } = view
        const { selection } = state
        if (!selection.empty) return false

        const { $from } = selection
        const paragraphDepth = findParagraphDepth($from)
        if (paragraphDepth < 0) return false

        const paragraphNode = $from.node(paragraphDepth)
        if ($from.parentOffset < paragraphNode.content.size) return false

        const beforeCursor = paragraphNode.textBetween(0, $from.parentOffset, '\n', '\n')
        const match = taskMarkerMatch(beforeCursor + text)
        if (!match) return false

        return convertParagraphToTaskList(view, paragraphDepth, match[1].toLowerCase() === 'x')
      },
      handleKeyDown(view, event) {
        if (event.key !== 'Enter' || event.isComposing) return false
        const { state } = view
        const { selection } = state
        if (!selection.empty) return false

        const { $from } = selection
        const paragraphDepth = findParagraphDepth($from)
        if (paragraphDepth < 0) return false

        const paragraphNode = $from.node(paragraphDepth)
        const text = paragraphNode.textContent || ''
        const match = taskMarkerMatch(text)
        if (!match) return false
        if ($from.parentOffset < paragraphNode.content.size) return false

        return convertParagraphToTaskList(view, paragraphDepth, match[1].toLowerCase() === 'x')
      }
    }
  })
}
