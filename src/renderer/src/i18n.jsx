import { createContext, useContext } from 'react'

export const LANGS = [
  { id: 'en', label: 'English' },
  { id: 'zh', label: '中文' }
]

export const STRINGS = {
  en: {
    // status bar
    'status.ready': 'Ready',
    'status.unsaved': 'Unsaved',
    'status.saved': 'Saved',
    'status.modified': 'Modified',
    'status.words': '{n} words',
    'status.chars': '{n} chars',
    'status.read': '{n} min read',
    'status.source': 'Source',
    'status.rich': 'Rich',
    'pageWidth.default': 'Default',
    'pageWidth.wide': 'Wide',
    'pageWidth.full': 'Full',
    'tip.toggleSource': 'Toggle source mode (Ctrl+/)',
    'tip.pageWidth': 'Page width',
    'tip.toggleTheme': 'Theme',
    'tip.language': 'Language',
    'tip.changeBlock': 'Change block type',
    'tip.minimize': 'Minimize',
    'tip.maximize': 'Maximize',
    'tip.restore': 'Restore Down',
    'tip.close': 'Close',
    'tb.bold': 'Bold (Ctrl+B)',
    'tb.italic': 'Italic (Ctrl+I)',
    'tb.strike': 'Strikethrough',
    'tb.code': 'Inline code',
    'tb.link': 'Link',
    'side.collapsePane': 'Collapse sidebar',
    'side.expandPane': 'Expand sidebar',

    // welcome (empty state)
    'welcome.tagline': 'A calmer place to write Markdown — many files, one window.',
    'welcome.newFile': 'New File',
    'welcome.openFile': 'Open File',
    'welcome.openFolder': 'Open Folder',
    'welcome.recent': 'Recent files',
    'time.justNow': 'just now',
    'time.minutesAgo': '{n} min ago',
    'time.hoursAgo': '{n}h ago',
    'time.yesterday': 'yesterday',
    'hint.palette': 'Palette',
    'hint.sidebar': 'Sidebar',
    'hint.new': 'New',
    'hint.save': 'Save',

    // tabs
    'tab.new': 'New tab (Ctrl+N)',
    'tab.untitled': 'Untitled',

    // sidebar
    'side.noFolder': 'No folder open',
    'side.openFolder': 'Open Folder',
    'side.newFile': 'New file',
    'side.newFolder': 'New folder',
    'side.collapseAll': 'Collapse all',
    'side.expandAll': 'Expand all',
    'side.empty': 'No markdown files here yet.',
    'side.ctxNewFile': 'New File',
    'side.ctxNewFolder': 'New Folder',
    'side.rename': 'Rename',
    'side.duplicate': 'Duplicate',
    'side.exportPdf': 'Export as PDF…',
    'side.reveal': 'Reveal in Explorer',
    'side.delete': 'Delete',
    'err.duplicate': 'Could not duplicate: ',
    'prompt.newFile': 'New file name',
    'prompt.newFolder': 'New folder name',
    'prompt.newFolderDefault': 'New Folder',
    'confirm.trash': 'Move "{name}" to trash?',
    'confirm.closeUnsaved': '"{name}" has unsaved changes. Close anyway?',
    'confirm.quitUnsaved': 'You have unsaved changes. Quit anyway?',
    'error.fileMissing': '"{name}" no longer exists — it may have been moved or deleted. Removed it from Recent.',
    'error.openFailed': 'Could not open "{name}".',
    'err.createFile': 'Could not create file: ',
    'err.createFolder': 'Could not create folder: ',
    'err.move': 'Could not move: ',
    'err.rename': 'Could not rename: ',
    'err.delete': 'Could not delete: ',
    'err.invalidName': 'That name can’t be used: ',
    'err.nameExists': 'A file or folder with that name already exists in this folder — please use a different name.',
    'side.emptyFolder': 'Empty — no Markdown files',
    'edit.confirm': 'Confirm (Enter)',
    'edit.cancel': 'Cancel (Esc)',

    // outline
    'outline.title': 'Outline',
    'outline.empty': 'No headings',

    // find
    'find.placeholder': 'Find in document',
    'find.next': 'Next',
    'find.prev': 'Prev',
    'find.close': 'Close',

    // command palette
    'palette.placeholder': 'Search files and commands…',
    'palette.empty': 'No matches',

    // commands
    'cmd.new': 'New File',
    'cmd.open': 'Open File…',
    'cmd.openFolder': 'Open Folder…',
    'cmd.save': 'Save',
    'cmd.saveAs': 'Save As…',
    'cmd.exportPdf': 'Export as PDF…',
    'error.exportPdfUnavailable': 'Open a Markdown document first to export it as PDF.',
    'cmd.sidebar': 'Toggle Sidebar',
    'nav.home': 'Home',
    'lightbox.close': 'Close (Esc)',
    'image.caption': 'Write image caption',
    'image.pasteLink': 'or paste link',
    'image.uploadFile': 'Upload file',
    'image.upload': 'Upload',
    'image.confirm': 'Confirm',
    'cmd.files': 'Show File Explorer',
    'cmd.outline': 'Show Outline',
    'cmd.source': 'Toggle Source Mode',
    'cmd.theme': 'Cycle Theme',
    'cmd.find': 'Find in File',

    // block types
    'block.turnInto': 'Turn into',
    'block.paragraph': 'Text',
    'block.h1': 'Heading 1',
    'block.h2': 'Heading 2',
    'block.h3': 'Heading 3',
    'block.h4': 'Heading 4',
    'block.h5': 'Heading 5',
    'block.h6': 'Heading 6',
    'block.heading': 'Heading',

    // editor
    'editor.placeholder': 'Type / for commands, or just start writing…',
    'code.copy': 'Copy',
    'code.copied': 'Copied',

    // tab context menu
    'tab.copyPath': 'Copy File Path',
    'tab.copyName': 'Copy File Name',
    'tab.reveal': 'Reveal in Folder',
    'tab.openRight': 'Open in Split (Right)',
    'tab.close': 'Close',
    'tab.closeOthers': 'Close Others',
    'tab.noPath': 'Unsaved file — save it first',

    // split view
    'split.toggle': 'Split editor',
    'split.close': 'Close split',
    'split.drag': 'Drag to resize',
    'split.needTwo': 'Open another file to use split view.',
    'heavy.notice': 'Large file — shown as plain text to stay fast.',
    'heavy.loadRich': 'Render as rich text',

    // update
    'update.title': 'Update available',
    'update.download': 'Download',
    'update.later': 'Later'
  },

  zh: {
    'status.ready': '就绪',
    'status.unsaved': '未保存',
    'status.saved': '已保存',
    'status.modified': '已修改',
    'status.words': '{n} 词',
    'status.chars': '{n} 字符',
    'status.read': '{n} 分钟阅读',
    'status.source': '源码',
    'status.rich': '富文本',
    'pageWidth.default': '默认',
    'pageWidth.wide': '较宽',
    'pageWidth.full': '全宽',
    'tip.toggleSource': '切换源码模式 (Ctrl+/)',
    'tip.pageWidth': '页宽',
    'tip.toggleTheme': '主题',
    'tip.language': '语言',
    'tip.changeBlock': '更改块类型',
    'tip.minimize': '最小化',
    'tip.maximize': '最大化',
    'tip.restore': '向下还原',
    'tip.close': '关闭',
    'tb.bold': '粗体 (Ctrl+B)',
    'tb.italic': '斜体 (Ctrl+I)',
    'tb.strike': '删除线',
    'tb.code': '行内代码',
    'tb.link': '链接',
    'side.collapsePane': '收起侧边栏',
    'side.expandPane': '展开侧边栏',

    'welcome.tagline': '一个更安静的 Markdown 写作空间 —— 多文件，一个窗口。',
    'welcome.newFile': '新建文件',
    'welcome.openFile': '打开文件',
    'welcome.openFolder': '打开文件夹',
    'welcome.recent': '最近文件',
    'time.justNow': '刚刚',
    'time.minutesAgo': '{n} 分钟前',
    'time.hoursAgo': '{n} 小时前',
    'time.yesterday': '昨天',
    'hint.palette': '命令面板',
    'hint.sidebar': '侧边栏',
    'hint.new': '新建',
    'hint.save': '保存',

    'tab.new': '新建标签 (Ctrl+N)',
    'tab.untitled': '未命名',

    'side.noFolder': '未打开文件夹',
    'side.openFolder': '打开文件夹',
    'side.newFile': '新建文件',
    'side.newFolder': '新建文件夹',
    'side.collapseAll': '全部折叠',
    'side.expandAll': '全部展开',
    'side.empty': '这里还没有 Markdown 文件。',
    'side.ctxNewFile': '新建文件',
    'side.ctxNewFolder': '新建文件夹',
    'side.rename': '重命名',
    'side.duplicate': '创建副本',
    'side.exportPdf': '导出为 PDF…',
    'side.reveal': '在资源管理器中显示',
    'side.delete': '删除',
    'err.duplicate': '无法创建副本：',
    'prompt.newFile': '新文件名',
    'prompt.newFolder': '新文件夹名',
    'prompt.newFolderDefault': '新建文件夹',
    'confirm.trash': '将“{name}”移到回收站？',
    'confirm.closeUnsaved': '“{name}”有未保存的更改，仍要关闭吗？',
    'confirm.quitUnsaved': '有未保存的更改，仍要退出吗？',
    'error.fileMissing': '“{name}”已不存在——可能被移动或删除了。已从“最近打开”中移除。',
    'error.openFailed': '无法打开“{name}”。',
    'err.createFile': '无法创建文件：',
    'err.createFolder': '无法创建文件夹：',
    'err.move': '无法移动：',
    'err.rename': '无法重命名：',
    'err.delete': '无法删除：',
    'err.invalidName': '这个名称不可用：',
    'err.nameExists': '该文件夹下已有同名文件，请换个名字。',
    'side.emptyFolder': '空文件夹 — 没有 Markdown 文件',
    'edit.confirm': '确认（回车）',
    'edit.cancel': '取消（Esc）',

    'outline.title': '大纲',
    'outline.empty': '暂无标题',

    'find.placeholder': '在文档中查找',
    'find.next': '下一个',
    'find.prev': '上一个',
    'find.close': '关闭',

    'palette.placeholder': '搜索文件和命令…',
    'palette.empty': '无匹配项',

    'cmd.new': '新建文件',
    'cmd.open': '打开文件…',
    'cmd.openFolder': '打开文件夹…',
    'cmd.save': '保存',
    'cmd.saveAs': '另存为…',
    'cmd.exportPdf': '导出为 PDF…',
    'error.exportPdfUnavailable': '请先打开一个 Markdown 文档再导出 PDF。',
    'cmd.sidebar': '切换侧边栏',
    'nav.home': '主页',
    'lightbox.close': '关闭（Esc）',
    'image.caption': '写图片说明',
    'image.pasteLink': '或粘贴链接',
    'image.uploadFile': '上传文件',
    'image.upload': '上传',
    'image.confirm': '确认',
    'cmd.files': '显示文件浏览器',
    'cmd.outline': '显示大纲',
    'cmd.source': '切换源码模式',
    'cmd.theme': '切换主题',
    'cmd.find': '在文件中查找',

    'block.turnInto': '转换为',
    'block.paragraph': '正文',
    'block.h1': '标题 1',
    'block.h2': '标题 2',
    'block.h3': '标题 3',
    'block.h4': '标题 4',
    'block.h5': '标题 5',
    'block.h6': '标题 6',
    'block.heading': '标题',

    'editor.placeholder': '输入 / 唤起命令，或开始写…',
    'code.copy': '复制',
    'code.copied': '已复制',

    'tab.copyPath': '复制文件路径',
    'tab.copyName': '复制文件名',
    'tab.reveal': '打开所在文件夹',
    'tab.openRight': '在右侧分屏打开',
    'tab.close': '关闭',
    'tab.closeOthers': '关闭其他',
    'tab.noPath': '未保存的文件，请先保存',

    'split.toggle': '分屏',
    'split.close': '关闭分屏',
    'split.drag': '拖动调整比例',
    'split.needTwo': '再打开一个文件即可使用分屏。',
    'heavy.notice': '大文件 —— 已用纯文本模式打开以保持流畅。',
    'heavy.loadRich': '渲染为富文本',

    'update.title': '发现新版本',
    'update.download': '前往下载',
    'update.later': '稍后'
  }
}

export const DEFAULT_LANG = (() => {
  try {
    return /^zh/i.test(navigator.language || '') ? 'zh' : 'en'
  } catch {
    return 'en'
  }
})()

export function translate(lang, key, vars) {
  const dict = STRINGS[lang] || STRINGS.en
  let s = dict[key] ?? STRINGS.en[key] ?? key
  if (vars) for (const k in vars) s = s.replace('{' + k + '}', vars[k])
  return s
}

const I18nContext = createContext({ lang: 'en', t: (k) => k, setLang: () => {} })
export const useI18n = () => useContext(I18nContext)

export function I18nProvider({ lang, setLang, children }) {
  const t = (key, vars) => translate(lang, key, vars)
  return <I18nContext.Provider value={{ lang, t, setLang }}>{children}</I18nContext.Provider>
}
