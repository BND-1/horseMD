// A commented starter snippet for the user-CSS box (issue #81). It mirrors the
// examples people ask about (heading colors, inline-code size, blockquote) and
// uses the actual editor selectors so pasting it "just works". The `.milkdown
// .ProseMirror` prefix targets the rich editor content; adjust and extend.
export const USER_CSS_TEMPLATE = `/* 自定义样式示例 —— 取消注释或改数值即可生效 */

/* 各级标题颜色 */
.milkdown .ProseMirror h1 { color: #c0392b; }
.milkdown .ProseMirror h2 { color: #2980b9; }
.milkdown .ProseMirror h3 { color: #27ae60; }

/* 行内代码：字号与颜色 */
.milkdown .ProseMirror code {
  font-size: 0.92em;
  color: #e74c3c;
  background: rgba(231, 76, 60, 0.08);
}

/* 引用块左边框 */
.milkdown .ProseMirror blockquote {
  border-left-color: #888;
}

/* 链接颜色 */
.milkdown .ProseMirror a { color: #2980b9; }
`
