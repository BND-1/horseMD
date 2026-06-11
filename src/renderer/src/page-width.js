export const PAGE_WIDTHS = [
  { id: 'default', contentWidth: 800, sidePadding: 60 },
  { id: 'wide', contentWidth: 1040, sidePadding: 56 },
  { id: 'full', contentWidth: '100%', sidePadding: 40 }
]

export const DEFAULT_PAGE_WIDTH = PAGE_WIDTHS[0].id

export const isPageWidth = (value) => PAGE_WIDTHS.some((item) => item.id === value)

export const normalizePageWidth = (value) => (isPageWidth(value) ? value : DEFAULT_PAGE_WIDTH)
