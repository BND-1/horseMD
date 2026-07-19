import { defineConfig } from 'vitepress'

const repo = 'https://github.com/BND-1/horseMD'

export default defineConfig({
  lang: 'zh-CN',
  title: 'HorseMD 使用教程',
  description: 'HorseMD Markdown 编辑器的安装、功能介绍与详细使用教程。',
  cleanUrls: true,
  srcExclude: ['README.md', 'public/**/*.md'],
  lastUpdated: true,
  sitemap: {
    hostname: 'https://guide.horsemd.yangsir.net'
  },
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/icon.png' }],
    ['meta', { name: 'theme-color', content: '#f7f8f6' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'HorseMD 使用教程' }],
    ['meta', { property: 'og:image', content: 'https://horsemd.yangsir.net/assets/og.jpg' }],
    // 访问统计
    ['script', { defer: '', src: 'https://u.yangsir.net/script.js', 'data-website-id': 'cac15ec9-b89f-47bb-955f-4d8b032b115d' }]
  ],
  themeConfig: {
    logo: '/icon.png',
    siteTitle: 'HorseMD 使用教程',
    nav: [
      { text: '教程首页', link: '/' },
      { text: '快速开始', link: '/getting-started/' },
      { text: '功能指南', link: '/basics/interface' },
      { text: '加入社区', link: '/community' },
      { text: '官网', link: 'https://horsemd.yangsir.net/' }
    ],
    sidebar: [
      {
        text: '开始使用',
        collapsed: false,
        items: [
          { text: '教程首页', link: '/' },
          { text: '快速开始', link: '/getting-started/' },
          { text: '下载正确的版本', link: '/getting-started/download' },
          { text: 'Windows 安装', link: '/getting-started/install-windows' },
          { text: 'macOS 安装', link: '/getting-started/install-macos' },
          { text: 'Linux 安装', link: '/getting-started/install-linux' },
          { text: 'Android 安装', link: '/getting-started/install-android' },
          { text: '第一次启动', link: '/getting-started/first-launch' }
        ]
      },
      {
        text: '基础操作',
        collapsed: false,
        items: [
          { text: '认识界面', link: '/basics/interface' },
          { text: '新建、打开与保存', link: '/basics/create-open-save' },
          { text: '工作区与文件夹', link: '/basics/workspace' },
          { text: '云同步文件夹', link: '/basics/cloud-sync' },
          { text: '标签页与分屏', link: '/basics/tabs-and-split' },
          { text: '富文本与源码模式', link: '/basics/rich-and-source' }
        ]
      },
      {
        text: '编辑内容',
        collapsed: false,
        items: [
          { text: '斜杠命令', link: '/editing/slash-command' },
          { text: '文字与段落格式', link: '/editing/formatting' },
          { text: '表格', link: '/editing/tables' },
          { text: '代码块', link: '/editing/code-blocks' },
          { text: '公式与 Mermaid', link: '/editing/math-and-mermaid' },
          { text: '图片与图床', link: '/editing/images' },
          { text: '链接与附件', link: '/editing/links-and-attachments' }
        ]
      },
      {
        text: '效率工具',
        collapsed: false,
        items: [
          { text: '查找与替换', link: '/productivity/find-and-replace' },
          { text: '大纲', link: '/productivity/outline' },
          { text: '命令面板', link: '/productivity/command-palette' },
          { text: '审阅与 CriticMarkup', link: '/productivity/review' },
          { text: '快捷键', link: '/productivity/shortcuts' }
        ]
      },
      {
        text: '输出与分享',
        collapsed: true,
        items: [
          { text: '富文本复制', link: '/output/rich-copy' },
          { text: '导出 PDF', link: '/output/export-pdf' },
          { text: '移动端分享', link: '/output/mobile-share' }
        ]
      },
      {
        text: '外观与设置',
        collapsed: true,
        items: [
          { text: '主题', link: '/customization/themes' },
          { text: '文档与代码字体', link: '/customization/fonts' },
          { text: '设置说明', link: '/customization/settings' }
        ]
      },
      {
        text: '移动端',
        collapsed: true,
        items: [
          { text: 'iPhone 与 iPad', link: '/mobile/ios' },
          { text: 'Android', link: '/mobile/android' }
        ]
      },
      {
        text: '问题排查',
        collapsed: true,
        items: [
          { text: '安装问题', link: '/troubleshooting/installation' },
          { text: '文件与保存', link: '/troubleshooting/files-and-save' },
          { text: '大文档与性能', link: '/troubleshooting/performance' },
          { text: '常见问题', link: '/troubleshooting/faq' }
        ]
      },
      {
        text: '加入社区',
        collapsed: true,
        items: [
          { text: '微信群与联系方式', link: '/community' }
        ]
      }
    ],
    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: '搜索教程', buttonAriaLabel: '搜索教程' },
              modal: {
                noResultsText: '没有找到相关内容',
                resetButtonTitle: '清除查询',
                footer: {
                  selectText: '选择',
                  navigateText: '切换',
                  closeText: '关闭'
                }
              }
            }
          }
        }
      }
    },
    outline: {
      level: [2, 3],
      label: '本页内容'
    },
    editLink: {
      pattern: `${repo}/edit/main/guide/:path`,
      text: '在 GitHub 上改进本页'
    },
    lastUpdated: {
      text: '最后更新于',
      formatOptions: {
        dateStyle: 'medium'
      }
    },
    docFooter: {
      prev: '上一篇',
      next: '下一篇'
    },
    socialLinks: [
      { icon: 'github', link: repo }
    ],
    footer: {
      message: 'HorseMD 是一款免费、开源的 Markdown 编辑器',
      copyright: 'Released under the MIT License'
    }
  }
})
