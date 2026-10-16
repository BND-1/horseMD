import { traceEditorEvent } from './editor-input-trace.js'

let nextTraceId = 0
const FORMAT = 'pm-node-refs-v1'

// ProseMirror nodes are immutable. Intern unchanged nodes rather than copying
// both entire documents over IPC on every key/selection event. The dictionary
// is reconstructable without invoking a parser or guessing transaction intent.
export function createEditorTransactionTracer({
  enabled = () => globalThis.window?.api?.inputTraceEnabled === true,
  emit = traceEditorEvent,
  compactThreshold = 100000
} = {}) {
  const traceId = `${Date.now()}-${++nextTraceId}`
  const ids = new WeakMap()
  let nextId = 0
  const encode = (node, definitions) => {
    if (!node) return null
    const known = ids.get(node)
    if (known !== undefined) return known
    const json = { type: node.type.name }
    if (Object.keys(node.attrs || {}).length) json.attrs = node.attrs
    if (node.marks?.length) json.marks = node.marks.map(mark => mark.toJSON())
    if (node.isText) json.text = node.text
    if (node.childCount) {
      json.content = []
      node.forEach(child => json.content.push(encode(child, definitions)))
    }
    const id = ++nextId
    ids.set(node, id)
    definitions.push({ id, node: json })
    return id
  }
  return (transactions, oldDoc, newDoc) => {
    if (!enabled()) return
    try {
      const payload = {
        traceId,
        transactions: (transactions || []).map(transaction => ({
          docChanged: transaction?.docChanged || false,
          selection: {
            anchor: transaction?.selection?.anchor ?? null,
            head: transaction?.selection?.head ?? null,
            from: transaction?.selection?.from ?? null,
            to: transaction?.selection?.to ?? null
          },
          steps: (transaction?.steps || []).map(step => step?.toJSON?.() || {
            type: step?.constructor?.name || 'unknown'
          })
        }))
      }
      if (Math.max(oldDoc?.content?.size || 0, newDoc?.content?.size || 0) < compactThreshold) {
        payload.oldDoc = oldDoc?.toJSON?.() || null
        payload.newDoc = newDoc?.toJSON?.() || null
      } else {
        payload.documentFormat = FORMAT
        payload.docNodes = []
        payload.oldDocRef = encode(oldDoc, payload.docNodes)
        payload.newDocRef = encode(newDoc, payload.docNodes)
      }
      emit('prosemirror-transactions', payload)
    } catch {
      // Diagnostics must not prevent the editor's transaction from applying.
    }
  }
}

// Consume a whole trace in original order. Never infer a missing snapshot:
// missing dictionary records are a truncated trace, not a valid document.
export function createTransactionTraceDecoder() {
  const sessions = new Map()
  return (event) => {
    if (event.type !== 'prosemirror-transactions' || !event.documentFormat) return event
    if (event.documentFormat !== FORMAT) throw new Error('Unsupported transaction trace format')
    let nodes = sessions.get(event.traceId)
    if (!nodes) { nodes = new Map(); sessions.set(event.traceId, nodes) }
    const resolve = (id) => {
      if (id == null) return null
      if (!nodes.has(id)) throw new Error(`Missing transaction trace node ${event.traceId}:${id}`)
      return nodes.get(id)
    }
    for (const { id, node } of event.docNodes || []) {
      if (nodes.has(id)) throw new Error(`Duplicate transaction trace node ${id}`)
      nodes.set(id, node.content ? { ...node, content: node.content.map(resolve) } : node)
    }
    return { ...event, oldDoc: resolve(event.oldDocRef), newDoc: resolve(event.newDocRef) }
  }
}
