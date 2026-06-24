import { Icon } from './icons.jsx'

const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

const emptyLine = { no: '', text: '', type: 'empty' }

function pairChanges(deletes, adds) {
  const rows = []
  const count = Math.max(deletes.length, adds.length)
  for (let i = 0; i < count; i++) {
    rows.push({
      left: deletes[i] || emptyLine,
      right: adds[i] || emptyLine,
      type: deletes[i] && adds[i] ? 'change' : deletes[i] ? 'del' : 'add'
    })
  }
  return rows
}

function parsePatch(patch) {
  const rows = []
  let oldNo = 0
  let newNo = 0
  let pendingDel = []
  let pendingAdd = []

  const flush = () => {
    if (!pendingDel.length && !pendingAdd.length) return
    rows.push(...pairChanges(pendingDel, pendingAdd))
    pendingDel = []
    pendingAdd = []
  }

  for (const line of String(patch || '').split(/\r?\n/)) {
    if (!line) continue
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue
    const hunk = line.match(hunkRe)
    if (hunk) {
      flush()
      oldNo = Number(hunk[1] || 0)
      newNo = Number(hunk[2] || 0)
      rows.push({ type: 'hunk', text: line })
      continue
    }
    if (line.startsWith('-')) {
      pendingDel.push({ no: oldNo++, text: line.slice(1), type: 'del' })
      continue
    }
    if (line.startsWith('+')) {
      pendingAdd.push({ no: newNo++, text: line.slice(1), type: 'add' })
      continue
    }
    if (line.startsWith('\\')) continue
    flush()
    const text = line.startsWith(' ') ? line.slice(1) : line
    rows.push({
      left: { no: oldNo++, text, type: 'same' },
      right: { no: newNo++, text, type: 'same' },
      type: 'same'
    })
  }
  flush()
  return rows
}

function DiffCell({ side, line }) {
  return (
    <div className={`git-diff-cell ${side} ${line.type}`}>
      <span className="git-diff-no">{line.no}</span>
      <code>{line.text || ' '}</code>
    </div>
  )
}

export default function GitDiffView({ tab }) {
  const rows = parsePatch(tab?.patch)
  return (
    <div className="git-diff-tab">
      <div className="git-diff-head">
        <Icon name="git" size={16} />
        <div>
          <div className="git-diff-title">{tab?.fileRel || tab?.title}</div>
          <div className="git-diff-sub">{tab?.commitSubject} · {tab?.commitTime}</div>
        </div>
      </div>
      <div className="git-diff-split-head">
        <span>改动前</span>
        <span>改动后</span>
      </div>
      <div className="git-diff-content">
        {rows.length === 0 ? (
          <div className="git-diff-empty">没有可显示的差异。</div>
        ) : rows.map((row, i) => row.type === 'hunk' ? (
          <div key={i} className="git-diff-hunk">{row.text}</div>
        ) : (
          <div key={i} className={`git-diff-row ${row.type}`}>
            <DiffCell side="old" line={row.left} />
            <DiffCell side="new" line={row.right} />
          </div>
        ))}
      </div>
    </div>
  )
}
