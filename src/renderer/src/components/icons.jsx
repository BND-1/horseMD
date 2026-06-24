const paths = {
  'chevron-right': 'M9 18l6-6-6-6',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-up': 'M18 15l-6-6-6 6',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6',
  'file-plus': 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M12 12v6 M9 15h6',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  'folder-open': 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2H3z M3 9h18l-2 9H5z',
  'folder-plus': 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M12 11v6 M9 14h6',
  collapse: 'M4 9h6V3 M20 15h-6v6 M14 10l7-7 M3 21l7-7',
  expand: 'M15 3h6v6 M9 21H3v-6 M21 3l-7 7 M3 21l7-7',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  close: 'M18 6 6 18 M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  info: 'M12 16v-4 M12 8h.01 M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  warning: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z M12 9v4 M12 17h.01',
  'alert-circle': 'M12 8v4 M12 16h.01 M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  trash: 'M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M6 6l1 15h10l1-15 M10 11v6 M14 11v6',
  'win-min': 'M6 12h12',
  'win-max': 'M6 6h12v12H6z',
  'win-restore': 'M8 8h8v8H8z M10 8V6h8v8h-2',
  sparkle: 'M12 3l1.7 6.3L20 11l-6.3 1.7L12 19l-1.7-6.3L4 11l6.3-1.7z',
  sidebar: 'M3 4h18v16H3z M9 4v16',
  columns: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M12 4v16',
  'panel-left-close': 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 3v18 M16 15l-3-3 3-3',
  'panel-left-open': 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 3v18 M14 9l3 3-3 3',
  outline: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  'source-control': 'M7 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M7 16a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M17 8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M7 8v8 M7 12c3 0 4-1 7-1',
  git: 'M7 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M7 16a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M17 8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M7 8v8 M7 12c3 0 4-1 7-1',
  discard: 'M9 6l-5 5 5 5 M5 11h9a5 5 0 1 1 0 10h-2',
  undo: 'M3 7v6h6 M3.8 13a8 8 0 1 0 2.4-7.2L3 9',
  refresh: 'M21 12a9 9 0 0 1-15.5 6.2L3 16 M3 21v-5h5 M3 12A9 9 0 0 1 18.5 5.8L21 8 M21 3v5h-5',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M12 1v2 M12 21v2 M4.2 4.2l1.4 1.4 M18.4 18.4l1.4 1.4 M1 12h2 M21 12h2 M4.2 19.8l1.4-1.4 M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3',
  code: 'M16 18l6-6-6-6 M8 6l-6 6 6 6',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z M17 21v-8H7v8 M7 3v5h8',
  command: 'M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3',
  heading: 'M6 4v16 M18 4v16 M6 12h12',
  menu: 'M3 6h18 M3 12h18 M3 18h18',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  share: 'M12 3v13 M8 7l4-4 4 4 M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4',
  settings: 'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6',
  width: 'M4 5v14 M20 5v14 M8 12h8 M10 9l-3 3 3 3 M14 9l3 3-3 3',
  'text-size': 'M4 7V4h16v3 M9 20h6 M12 4v16',
  stats: 'M3 21h18 M7 21V11 M12 21V4 M17 21v-7',
  image:
    'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M21 15l-5-5L5 21',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M3 12h18 M12 3a14 14 0 0 1 0 18 M12 3a14 14 0 0 0 0 18',
  github: 'M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4 M9 18c-4.51 2-5-2-7-2'
}

export function Icon({ name, size = 16, className = '', strokeWidth = 1.8, style }) {
  const d = paths[name]
  if (!d) return null
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden="true"
    >
      {d.split(' M').map((seg, i) => (
        <path key={i} d={(i === 0 ? seg : 'M' + seg)} />
      ))}
    </svg>
  )
}
