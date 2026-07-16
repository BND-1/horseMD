import { useCallback } from 'react'
import { baseName, isHeavyDoc } from '../paths.js'
import { fireToast } from '../ui.js'

const escapeLinkLabel = (text) =>
  String(text || 'attachment').replace(/([\[\]])/g, '\\$1')
const markdownLinkTarget = (path) =>
  `<${String(path || '').replace(/[<>]/g, (character) => (character === '<' ? '%3C' : '%3E'))}>`
const attachmentLinkMarkdown = (name, path) =>
  `[${escapeLinkLabel(name)}](${markdownLinkTarget(path)})`

export function useAttachments({
  pickEditableId,
  tabsRef,
  setTabs,
  sourceTextareas,
  sourceEditedIds,
  liveContentRef,
  commitLive,
  commitAllLive,
  editorApis,
  tRef
}) {
  const replaceTabContent = useCallback((id, content) => {
    tabsRef.current = tabsRef.current.map((tab) =>
      tab.id === id ? { ...tab, content, heavy: isHeavyDoc(content) } : tab)
    setTabs((previous) => previous.map((tab) =>
      tab.id === id ? { ...tab, content, heavy: isHeavyDoc(content) } : tab))
  }, [setTabs, tabsRef])

  const insertMarkdownIntoTab = useCallback((id, markdown) => {
    if (!id || !markdown) return false
    const sourceElement = sourceTextareas.current[id]
    if (sourceElement) {
      const start = sourceElement.selectionStart ?? sourceElement.value.length
      const end = sourceElement.selectionEnd ?? start
      sourceElement.setRangeText(markdown, start, end, 'end')
      sourceElement.__horsemdSourceSelectionUser = true
      sourceElement.__horsemdSourceViewportMoved = false
      sourceElement.__horsemdSourceSelectionAt = performance.now()
      sourceEditedIds.current.add(id)
      liveContentRef.current.set(id, sourceElement.value)
      commitLive(id)
      sourceElement.focus()
      return true
    }

    const tab = tabsRef.current.find((candidate) => candidate.id === id)
    if (!tab || tab.kind === 'settings') return false
    const api = editorApis.current[id]
    const current = api?.getMarkdown?.() || tab.content || ''
    const rawOffset = api?.markdownOffsetFromSelection?.()
    const position = Number.isFinite(rawOffset)
      ? Math.max(0, Math.min(rawOffset, current.length))
      : current.length
    const next = current.slice(0, position) + markdown + current.slice(position)
    api?.replaceMarkdown?.(next)
    replaceTabContent(id, next)
    return true
  }, [commitLive, editorApis, liveContentRef, replaceTabContent, sourceEditedIds, sourceTextareas, tabsRef])

  const attachFiles = useCallback(async () => {
    const id = pickEditableId()
    const tab = tabsRef.current.find((candidate) => candidate.id === id)
    if (!tab || tab.kind === 'settings') return
    if (!window.api.capabilities?.fileAttachments || !window.api.openAttachments || !window.api.saveAttachment) {
      fireToast(tRef.current('attach.unsupported'), { sticky: true })
      return
    }
    if (!tab.path) {
      fireToast(tRef.current('attach.needsSave'), { sticky: true })
      return
    }
    commitAllLive()
    fireToast(tRef.current('attach.picking'), { duration: 1200 })
    const picked = await window.api.openAttachments()
    if (!picked?.length) return
    const links = []
    for (const path of picked) {
      const result = await window.api.saveAttachment(tab.path, path)
      if (!result?.ok) {
        fireToast(tRef.current('attach.failed', { msg: result?.error || baseName(path) }), { sticky: true })
        return
      }
      links.push(attachmentLinkMarkdown(result.name || baseName(path), result.path))
    }
    if (!links.length) return
    insertMarkdownIntoTab(id, links.join('\n'))
    fireToast(tRef.current('attach.inserted', { n: links.length }), { duration: 1500 })
  }, [commitAllLive, insertMarkdownIntoTab, pickEditableId, tabsRef, tRef])

  return { attachFiles, insertMarkdownIntoTab }
}
