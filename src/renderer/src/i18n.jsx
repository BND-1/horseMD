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
    'tip.toggleSource': 'Toggle source mode (Ctrl+/)',
    'tip.toggleTheme': 'Theme',
    'tip.language': 'Language',
    'tip.changeBlock': 'Change block type',

    // welcome (empty state)
    'welcome.tagline': 'A calmer place to write Markdown — many files, one window.',
    'welcome.newFile': 'New File',
    'welcome.openFile': 'Open File',
    'welcome.openFolder': 'Open Folder',

    // tabs
    'tab.new': 'New tab (Ctrl+N)',
    'tab.untitled': 'Untitled',

    // sidebar
    'side.noFolder': 'No folder open',
    'side.openFolder': 'Open Folder',
    'side.newFile': 'New file',
    'side.newFolder': 'New folder',
    'side.collapseAll': 'Collapse all',
    'side.empty': 'No markdown files here yet.',
    'side.ctxNewFile': 'New File',
    'side.ctxNewFolder': 'New Folder',
    'side.rename': 'Rename',
    'side.reveal': 'Reveal in Explorer',
    'side.delete': 'Delete',
    'prompt.newFile': 'New file name',
    'prompt.newFolder': 'New folder name',
    'prompt.newFolderDefault': 'New Folder',
    'confirm.trash': 'Move "{name}" to trash?',
    'err.createFile': 'Could not create file: ',

    // outline
    'outline.title': 'Outline',
    'outline.empty': 'No headings',

    // find
    'find.placeholder': 'Find in document',
    'find.next': 'Next',
    'find.prev': 'Prev',

    // command palette
    'palette.placeholder': 'Search files and commands…',
    'palette.empty': 'No matches',

    // commands
    'cmd.new': 'New File',
    'cmd.open': 'Open File…',
    'cmd.openFolder': 'Open Folder…',
    'cmd.save': 'Save',
    'cmd.saveAs': 'Save As…',
    'cmd.sidebar': 'Toggle Sidebar',
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
    'editor.placeholder': 'Type / for commands, or just start writing…'
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
    'tip.toggleSource': '切换源码模式 (Ctrl+/)',
    'tip.toggleTheme': '主题',
    'tip.language': '语言',
    'tip.changeBlock': '更改块类型',

    'welcome.tagline': '一个更安静的 Markdown 写作空间 —— 多文件，一个窗口。',
    'welcome.newFile': '新建文件',
    'welcome.openFile': '打开文件',
    'welcome.openFolder': '打开文件夹',

    'tab.new': '新建标签 (Ctrl+N)',
    'tab.untitled': '未命名',

    'side.noFolder': '未打开文件夹',
    'side.openFolder': '打开文件夹',
    'side.newFile': '新建文件',
    'side.newFolder': '新建文件夹',
    'side.collapseAll': '全部折叠',
    'side.empty': '这里还没有 Markdown 文件。',
    'side.ctxNewFile': '新建文件',
    'side.ctxNewFolder': '新建文件夹',
    'side.rename': '重命名',
    'side.reveal': '在资源管理器中显示',
    'side.delete': '删除',
    'prompt.newFile': '新文件名',
    'prompt.newFolder': '新文件夹名',
    'prompt.newFolderDefault': '新建文件夹',
    'confirm.trash': '将“{name}”移到回收站？',
    'err.createFile': '无法创建文件：',

    'outline.title': '大纲',
    'outline.empty': '暂无标题',

    'find.placeholder': '在文档中查找',
    'find.next': '下一个',
    'find.prev': '上一个',

    'palette.placeholder': '搜索文件和命令…',
    'palette.empty': '无匹配项',

    'cmd.new': '新建文件',
    'cmd.open': '打开文件…',
    'cmd.openFolder': '打开文件夹…',
    'cmd.save': '保存',
    'cmd.saveAs': '另存为…',
    'cmd.sidebar': '切换侧边栏',
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

    'editor.placeholder': '输入 / 调出命令，或直接开始写…'
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
