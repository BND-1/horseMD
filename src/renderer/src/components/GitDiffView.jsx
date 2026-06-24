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
  let header = []
  let currentHunk = null

  const flush = () => {
    if (!pendingDel.length && !pendingAdd.length) return
    rows.push(...pairChanges(pendingDel, pendingAdd))
    pendingDel = []
    pendingAdd = []
  }

  const pushHunkLine = (line) => {
    if (currentHunk) currentHunk.lines.push(line)
  }

  for (const line of String(patch || '').split(/\r?\n/)) {
    if (!line) continue
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      header.push(line)
      continue
    }
    const hunk = line.match(hunkRe)
    if (hunk) {
      flush()
      oldNo = Number(hunk[1] || 0)
      newNo = Number(hunk[2] || 0)
      currentHunk = { lines: [...header, line] }
      rows.push({ type: 'hunk', text: line, hunk: currentHunk })
      continue
    }
    if (!currentHunk) {
      header.push(line)
      continue
    }
    pushHunkLine(line)
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

export default function GitDiffView({ tab, onRevertHunk }) {
  const rows = parsePatch(tab?.patch)
  const canRevertHunk = tab?.source === 'worktree' && typeof onRevertHunk === 'function'
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
          <div key={i} className="git-diff-hunk">
            <span>{row.text}</span>
            {canRevertHunk && (
              <button
                className="git-diff-revert"
                title="还原此块"
                onClick={() => onRevertHunk(tab, [...row.hunk.lines, ''].join('\n'))}
              >
                <Icon name="discard" size={13} />
                还原此块
              </button>
            )}
          </div>
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
