import { Fragment } from '@milkdown/prose/model'
import { TextSelection } from '@milkdown/prose/state'

const LIST_TYPES = new Set(['bullet_list', 'ordered_list'])

const isList = (node) => LIST_TYPES.has(node?.type?.name)

const isTaskItem = (node) =>
  node?.type?.name === 'list_item' && node.attrs?.checked !== null && node.attrs?.checked !== undefined

function closestListAt(state, pos = state.selection.$from.pos) {
  const safePos = Math.max(0, Math.min(pos, state.doc.content.size))
  const $pos = state.doc.resolve(safePos)
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth)
    if (isList(node)) return { node, pos: $pos.before(depth), depth }
  }
  return null
}

function hasTaskItemAtCurrentLevel(list) {
  let task = false
  list.forEach((node) => {
    if (isTaskItem(node)) task = true
  })
  return task
}

function targetTypeName(sourceType) {
  if (sourceType === 'bullet_list') return 'ordered_list'
  if (sourceType === 'ordered_list') return 'bullet_list'
  return null
}

function conversionActions(list) {
  if (hasTaskItemAtCurrentLevel(list.node)) {
    return ['bullet_list', 'ordered_list'].map((targetType) => ({ targetType }))
  }

  const alternativeType = targetTypeName(list.node.type.name)
  return [
    { targetType: alternativeType },
    { targetType: 'task_list' }
  ]
}

// The context-menu layer only needs a serializable description. Keeping the
// resolved ProseMirror nodes inside this module avoids stale selection state in
// React and keeps task-list exclusions consistent with the action itself.
export function getListConversionContext(state, pos) {
  // A conversion applies only to the closest list container. Nested lists are
  // separate writing levels, so changing a parent must not silently convert
  // its children and changing a child must not touch its parent.
  const list = closestListAt(state, pos)
  if (!list) return null
  const sourceType = list.node.type.name
  return {
    listPos: list.pos,
    sourceType,
    actions: conversionActions(list)
  }
}

function convertedListLevel(node, targetType, targetTypeNameValue) {
  const targetIsTaskList = targetTypeNameValue === 'task_list'
  const targetListType = targetTypeNameValue === 'ordered_list' ? 'ordered' : 'bullet'
  const items = []

  let itemIndex = 0
  node.forEach((child) => {
    if (child.type.name !== 'list_item') {
      items.push(child)
      return
    }
    itemIndex += 1
    // Keep child-list content intact. Crepe renders a list marker from the
    // item's own attrs, so update only this level's direct items. Descendant
    // list containers and their item attrs must remain exactly as authored.
    items.push(child.type.create(
      {
        ...child.attrs,
        checked: targetIsTaskList ? false : null,
        label: targetListType === 'ordered' ? `${itemIndex}.` : '•',
        listType: targetListType
      },
      child.content,
      child.marks
    ))
  })

  const content = Fragment.from(items)
  return targetType.create(
    targetTypeNameValue === 'ordered_list' ? { order: 1 } : null,
    content,
    node.marks
  )
}

function restoreSelectionInReplacement(tr, list, replacement, selection) {
  const replacementStart = list.pos
  const replacementEnd = list.pos + replacement.nodeSize
  const oldEnd = list.pos + list.node.nodeSize
  const selectionStart = Math.min(selection.anchor, selection.head)
  const selectionEnd = Math.max(selection.anchor, selection.head)
  if (selectionStart < list.pos || selectionEnd > oldEnd) return tr

  // Changing a list type only changes node attrs and container type, not text
  // positions. ReplaceStep maps positions inside the replaced root ambiguously
  // and can place a top-level caret at the final item, so retain the relative
  // selection explicitly instead of relying on its default boundary mapping.
  const anchor = Math.max(replacementStart + 1, Math.min(selection.anchor, replacementEnd - 1))
  const head = Math.max(replacementStart + 1, Math.min(selection.head, replacementEnd - 1))
  try {
    return tr.setSelection(TextSelection.create(tr.doc, anchor, head))
  } catch {
    return tr
  }
}

// Converts only the closest list container. Converting a task list explicitly
// removes its checkbox attrs; the item text and nested list levels stay intact.
export function convertListAtSelection(view, targetTypeNameValue, listPos) {
  const state = view?.state
  if (!state || ![...LIST_TYPES, 'task_list'].includes(targetTypeNameValue)) return false
  const nodeAtContextPos = Number.isFinite(listPos) ? state.doc.nodeAt(listPos) : null
  const list = isList(nodeAtContextPos)
    ? { node: nodeAtContextPos, pos: listPos }
    : closestListAt(state)
  if (!list) return false

  const targetType = state.schema.nodes[targetTypeNameValue === 'task_list' ? 'bullet_list' : targetTypeNameValue]
  if (!targetType) return false

  const sourceIsTaskList = hasTaskItemAtCurrentLevel(list.node)
  if (list.node.type === targetType && targetTypeNameValue !== 'task_list' && !sourceIsTaskList) return false

  // Keep the structural rewrite in the same undo stack as typed edits. Some
  // Crepe plugins append layout-only transactions, so state the intent instead
  // of relying on a default meta value surviving that chain.
  let tr = state.tr.setMeta('addToHistory', true)
  // `setNodeMarkup` updates Markdown state, but Crepe can retain an old list
  // item view after a repeated conversion. Replace this container once so the
  // current level's markers are recreated without touching nested lists.
  const replacement = convertedListLevel(list.node, targetType, targetTypeNameValue)
  tr = tr.replaceWith(list.pos, list.pos + list.node.nodeSize, replacement)
  tr = restoreSelectionInReplacement(tr, list, replacement, state.selection)
  view.dispatch(tr.scrollIntoView())
  return true
}
