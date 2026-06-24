import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './icons.jsx'
import { useI18n } from '../i18n.jsx'

const statusText = (f) => {
  if (f.x === '?' && f.y === '?') return 'U'
  if (f.x === 'D' || f.y === 'D') return 'D'
  if (f.x === 'R') return 'R'
  if (f.x === 'A' || f.y === 'A') return 'A'
  return 'M'
}

const GRAPH_COLORS = ['#1677e5', '#f5a300', '#d23b6c', '#25a45b', '#8f6fd6', '#00a6a6']
const GRAPH_LANE_W = 14
const GRAPH_ROW_H = 28

const graphColor = (index) => GRAPH_COLORS[index % GRAPH_COLORS.length]
const MAIN_BRANCH_RE = /^(origin\/)?(main|master|trunk)$/

function isMainBranchName(name) {
  return MAIN_BRANCH_RE.test(String(name || '').trim())
}

function graphLanes(graph, cols) {
  const lanes = Array.from(String(graph || '*').replace(/\s+/g, ''))
  return lanes.slice(0, cols).concat(Array(Math.max(0, cols - lanes.length)).fill(' '))
}

function activeLane(ch) {
  return ch === '*' || ch === '|' || ch === '/' || ch === '\\' || ch === '-' || ch === '_'
}

function verticalLane(ch) {
  return ch === '*' || ch === '|'
}

function graphLaneCount(graph) {
  return Math.max(1, String(graph || '*').replace(/\s+/g, '').length)
}

function commitLane(graph, cols) {
  return Math.max(0, graphLanes(graph, cols).findIndex((ch) => ch === '*'))
}

function visibleGraphLanes(graph, cols) {
  const lanes = graphLanes(graph, cols)
    .map((ch, index) => activeLane(ch) ? index : -1)
    .filter((index) => index >= 0)
  return lanes.length ? lanes : [commitLane(graph, cols)]
}

function GitGraphSvg({
  graph,
  prevGraph,
  nextGraph,
  cols,
  selected,
  compact = false,
  routeColorIndex = null,
  prevRouteColorIndex = null,
  extraHeight = 0
}) {
  const chars = graphLanes(graph, cols)
  const prev = graphLanes(prevGraph, cols)
  const next = graphLanes(nextGraph, cols)
  const width = Math.max(1, cols) * GRAPH_LANE_W
  const height = compact ? 12 : GRAPH_ROW_H
  const midY = height / 2
  const rowOffset = compact ? 0 : Math.max(0, Number(extraHeight) || 0)
  const laneX = (i) => i * GRAPH_LANE_W + GRAPH_LANE_W / 2
  const overlap = 1.5
  const cornerR = 5
  const routeLane = commitLane(graph, cols)
  const isLinearRoute = !compact && visibleGraphLanes(graph, cols).length === 1 && chars[routeLane] === '*'
  const laneColor = (i, colorIndex = null) => graphColor(colorIndex ?? i)
  const topColor = (i) => laneColor(i, isLinearRoute && i === routeLane ? (prevRouteColorIndex ?? routeColorIndex) : null)
  const bottomColor = (i) => laneColor(i, isLinearRoute && i === routeLane ? routeColorIndex : null)
  const nodeColor = (i) => laneColor(i, isLinearRoute && i === routeLane ? routeColorIndex : null)

  return (
    <svg className={`git-graph-svg${compact ? ' compact' : ''}`} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {!compact && chars.map((ch, i) => {
        if (ch !== '*' || next[i] !== '/' || i <= 0) return null
        const x = laneX(i)
        const toX = laneX(i - 1)
        const toY = height + rowOffset + 12 + GRAPH_ROW_H / 2
        const r = Math.min(cornerR, Math.abs(x - toX) / 2)
        return (
          <path
            key={`merge:${i}`}
            className="git-graph-line"
            d={`M ${x} ${midY} V ${toY - r} Q ${x} ${toY} ${x - r} ${toY} H ${toX}`}
            style={{ '--lane-color': laneColor(i) }}
          />
        )
      })}
      {chars.map((ch, i) => {
        if (ch !== '/' && ch !== '\\') return null
        if (ch === '\\' && prev[i - 1] === '*') return null
        if (ch === '/' && prev[i] === '*') return null
        const fromIndex = ch === '\\' ? Math.max(0, i - 1) : i
        const toIndex = ch === '\\' ? i : Math.max(0, i - 1)
        const x = laneX(fromIndex)
        const toX = laneX(toIndex)
        const startY = -overlap
        const toY = next[toIndex] === '*' ? height + rowOffset + GRAPH_ROW_H / 2 : height + rowOffset + overlap
        const bend = Math.min(height * 0.9, Math.max(8, (toY - startY) * 0.42))
        return (
          <path
            key={`d:${i}`}
            className="git-graph-line"
            d={`M ${x} ${startY} C ${x} ${startY + bend}, ${toX} ${toY - bend}, ${toX} ${toY}`}
            style={{ '--lane-color': graphColor(fromIndex) }}
          />
        )
      })}
      {chars.map((ch, i) => {
        const draw = ch === ' ' && verticalLane(prev[i]) && verticalLane(next[i]) ? '|' : ch
        const splitFromCommit = verticalLane(next[i]) && chars[i] === ' ' && chars[i - 1] === '*'
        const splitTargetFromPrevCommit = ch === '\\' && prev[i - 1] === '*'
        const hasTop = splitTargetFromPrevCommit || verticalLane(prev[i]) || verticalLane(draw)
        const hasBottom = !splitFromCommit && (verticalLane(next[i]) || verticalLane(draw))
        if (!hasTop && !hasBottom) return null
        const x = laneX(i)
        const bottomY = height + (verticalLane(next[i]) ? rowOffset : 0) + overlap
        return (
          <g key={`v:${i}`}>
            {hasTop && (
              <line
                className="git-graph-line"
                x1={x}
                y1={-overlap}
                x2={x}
                y2={midY}
                style={{ '--lane-color': topColor(i) }}
              />
            )}
            {hasBottom && (
              <line
                className="git-graph-line"
                x1={x}
                y1={midY}
                x2={x}
                y2={bottomY}
                style={{ '--lane-color': bottomColor(i) }}
              />
            )}
          </g>
        )
      })}
      {chars.map((ch, i) => {
        if (ch !== '-' && ch !== '_') return null
        const x = laneX(i)
        return (
          <line
            key={`h:${i}`}
            className="git-graph-line"
            x1={Math.max(0, x - GRAPH_LANE_W / 2)}
            y1={midY}
            x2={Math.min(width, x + GRAPH_LANE_W / 2)}
            y2={midY}
            style={{ '--lane-color': laneColor(i) }}
          />
        )
      })}
      {chars.map((ch, i) => {
        if (ch !== '*') return null
        const x = laneX(i)
        return selected ? (
          <g key={`n:${i}`} className="git-graph-node selected" style={{ '--lane-color': nodeColor(i) }}>
            <circle cx={x} cy={midY} r="6" />
            <circle cx={x} cy={midY} r="2.5" />
          </g>
        ) : (
          <circle key={`n:${i}`} className="git-graph-node" cx={x} cy={midY} r="5" style={{ '--lane-color': nodeColor(i) }} />
        )
      })}
    </svg>
  )
}

function getEditorSurfaceLeft() {
  const editorArea = document.querySelector('.editor-area')
  const editorVisible = editorArea && window.getComputedStyle(editorArea).display !== 'none'
  const target = editorVisible ? editorArea : document.querySelector('.pane-center')
  return target?.getBoundingClientRect().left || 0
}

function formatCommitTime(commit) {
  return (commit.absolute || commit.relative || '').replace(/\s+[+-]\d{4}$/, '')
}

function isCheckoutBlockedByChanges(error) {
  const msg = String(error || '')
  return /local changes|would be overwritten|commit your changes|stash/i.test(msg)
}

export default function GitChanges({ workspace, refreshNonce, onOpenFile, onOpenDiff, onChanged }) {
  const { t } = useI18n()
  const [state, setState] = useState({
    loading: false,
    busy: false,
    error: '',
    repository: true,
    initialized: false,
    files: [],
    staged: [],
    unstaged: [],
    commits: [],
    summary: null,
    branches: []
  })
  const [message, setMessage] = useState('')
  const [selectedCommit, setSelectedCommit] = useState(null)
  const [commitFiles, setCommitFiles] = useState([])
  const [branchOpen, setBranchOpen] = useState(false)
  const [branchCreateOpen, setBranchCreateOpen] = useState(false)
  const [branchMenu, setBranchMenu] = useState(null)
  const [newBranch, setNewBranch] = useState('')
  const [historyHeight, setHistoryHeight] = useState(260)
  const [hoverCommit, setHoverCommit] = useState(null)
  const [commitMenu, setCommitMenu] = useState(null)
  const [commitDialog, setCommitDialog] = useState(null)
  const [commitBranchName, setCommitBranchName] = useState('')
  const [deleteBranchName, setDeleteBranchName] = useState('')
  const [discardFile, setDiscardFile] = useState(null)
  const [detailHeight, setDetailHeight] = useState(0)
  const detailRef = useRef(null)
  const branchFooterRef = useRef(null)
  const graphCols = useMemo(() => {
    const longest = Math.max(2, ...state.commits.map((c) => graphLaneCount(c.graph)))
    return Math.min(18, longest)
  }, [state.commits])
  const branchColorByName = useMemo(() => {
    const map = new Map()
    const seen = new Set()
    let nextColorIndex = 1
    for (const branch of state.branches || []) {
      const name = branch.name || ''
      if (!name || seen.has(name)) continue
      seen.add(name)
      map.set(name, isMainBranchName(name) ? 0 : nextColorIndex++)
    }
    for (const commit of state.commits) {
      if (commit.kind === 'graph') continue
      for (const name of commit.branches || []) {
        if (map.has(name)) continue
        map.set(name, isMainBranchName(name) ? 0 : nextColorIndex++)
      }
    }
    return map
  }, [state.branches, state.commits])
  const commitRouteColor = useMemo(() => {
    const current = state.summary?.branch || ''
    const currentIsMain = isMainBranchName(current)
    const map = new Map()
    for (const commit of state.commits) {
      if (commit.kind === 'graph') continue
      const branches = commit.branches || []
      const nonMainBranches = branches.filter((branch) => !isMainBranchName(branch))
      const hasCurrent = current && branches.includes(current)
      const hasMain = branches.some(isMainBranchName)
      if (hasCurrent && !currentIsMain && !hasMain) {
        map.set(commit.hash, branchColorByName.get(current) ?? 1)
      } else if (!hasMain && nonMainBranches.length === 1) {
        map.set(commit.hash, branchColorByName.get(nonMainBranches[0]) ?? 1)
      } else if (hasMain) {
        map.set(commit.hash, 0)
      }
    }
    return map
  }, [state.commits, state.summary?.branch, branchColorByName])
  const branchLaneByName = useMemo(() => {
    const map = new Map()
    for (const commit of state.commits) {
      if (commit.kind === 'graph' || !commit.branches?.length) continue
      const lanes = visibleGraphLanes(commit.graph, graphCols)
      if (commit.branches.length === 1) {
        const branch = commit.branches[0]
        map.set(branch, branchColorByName.get(branch) ?? commitRouteColor.get(commit.hash) ?? commitLane(commit.graph, graphCols))
        continue
      }
      commit.branches.forEach((branch, index) => {
        if (!map.has(branch) && lanes[index] != null) {
          map.set(branch, branchColorByName.get(branch) ?? (isMainBranchName(branch) ? 0 : (commitRouteColor.get(commit.hash) ?? lanes[index])))
        }
      })
    }
    return map
  }, [state.commits, graphCols, commitRouteColor, branchColorByName])

  useEffect(() => {
    if (!commitMenu) return undefined
    const close = () => setCommitMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', close)
    }
  }, [commitMenu])

  useEffect(() => {
    if (!branchMenu) return undefined
    const close = () => setBranchMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', close)
    }
  }, [branchMenu])

  useEffect(() => {
    if (!branchOpen && !branchCreateOpen) return undefined
    const close = (e) => {
      if (branchFooterRef.current?.contains(e.target)) return
      setBranchOpen(false)
      setBranchCreateOpen(false)
      setNewBranch('')
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', close)
    }
  }, [branchOpen, branchCreateOpen])

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    if (!workspace?.rootPath) {
      setState({ loading: false, busy: false, error: '', repository: true, initialized: false, files: [], staged: [], unstaged: [], commits: [], summary: null, branches: [] })
      return
    }
    setState((s) => ({ ...s, loading: quiet ? s.loading : true, error: '' }))
    const res = await window.api.gitStatus(workspace.rootPath)
    const repository = res.ok ? res.repository !== false : true
    const history = res.ok && repository ? await window.api.gitHistory(workspace.rootPath) : { ok: false, commits: [] }
    const summary = res.ok && repository ? await window.api.gitSummary(workspace.rootPath) : { ok: false }
    const branches = res.ok && repository ? await window.api.gitBranches(workspace.rootPath) : { ok: false, branches: [] }
    setState({
      loading: false,
      busy: false,
      error: res.ok ? '' : res.error,
      repository,
      initialized: !!res.initialized,
      files: res.files || [],
      staged: res.staged || [],
      unstaged: res.unstaged || [],
      summary: summary.ok ? summary : null,
      commits: history.commits || [],
      branches: branches.branches || []
    })
  }, [workspace?.rootPath])

  useEffect(() => { refresh() }, [refresh, refreshNonce])

  useEffect(() => {
    setDetailHeight(0)
  }, [selectedCommit?.hash])

  useEffect(() => {
    const node = detailRef.current
    if (!node) return undefined
    const measure = () => {
      const style = window.getComputedStyle(node)
      const outerHeight =
        node.getBoundingClientRect().height +
        parseFloat(style.marginTop || '0') +
        parseFloat(style.marginBottom || '0')
      setDetailHeight(Math.ceil(outerHeight))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [selectedCommit?.hash, commitFiles])

  const runGit = async (fn) => {
    if (!workspace?.rootPath) return
    setState((s) => ({ ...s, busy: true, error: '' }))
    const res = await fn(workspace.rootPath)
    if (!res?.ok) {
      setState((s) => ({ ...s, busy: false, error: res?.error || t('git.failed') }))
      return false
    }
    await refresh({ quiet: true })
    onChanged?.()
    return res
  }

  const initRepository = async () => {
    await runGit((root) => window.api.gitInit(root))
  }

  const commit = async () => {
    const ok = await runGit((root) => window.api.gitCommit(root, message))
    if (ok) setMessage('')
  }

  const selectCommit = async (commit) => {
    if (!workspace?.rootPath) return
    const same = selectedCommit?.hash === commit.hash
    setSelectedCommit(same ? null : commit)
    setCommitFiles([])
    if (same) return
    if (Array.isArray(commit.files)) {
      setCommitFiles(commit.files)
      return
    }
    const res = await window.api.gitCommitFiles(workspace.rootPath, commit.hash)
    if (!res?.ok) {
      setState((s) => ({ ...s, error: res?.error || t('git.failed') }))
      return
    }
    setCommitFiles(res.files || [])
  }

  const openCommitFileDiff = async (file) => {
    if (!workspace?.rootPath || !selectedCommit) return
    const res = await window.api.gitCommitDiff(workspace.rootPath, selectedCommit.hash, file.rel)
    if (!res?.ok) {
      setState((s) => ({ ...s, error: res?.error || t('git.failed') }))
      return
    }
    onOpenDiff?.({
      hash: selectedCommit.hash,
      fileRel: file.rel,
      commitSubject: selectedCommit.subject,
      commitTime: selectedCommit.absolute || selectedCommit.relative,
      patch: res.patch || ''
    })
  }

  const openChangedFileDiff = async (file, staged) => {
    if (!workspace?.rootPath) return
    const status = `${file.x || ''}${file.y || ''}`
    const res = await window.api.gitWorktreeDiff(workspace.rootPath, file.rel, staged, status)
    if (!res?.ok) {
      setState((s) => ({ ...s, error: res?.error || t('git.failed') }))
      return
    }
    onOpenDiff?.({
      hash: staged ? 'staged' : 'worktree',
      source: staged ? 'staged' : 'worktree',
      fileRel: file.rel,
      commitSubject: staged ? '暂存区变更' : '工作区变更',
      commitTime: staged ? 'Index' : 'Working Tree',
      patch: res.patch || ''
    })
  }

  const createBranch = async () => {
    const name = newBranch.trim()
    if (!name) return
    const ok = await runGit((root) => window.api.gitCreateBranch(root, name))
    if (ok) {
      setNewBranch('')
      setBranchCreateOpen(false)
      setBranchOpen(false)
    }
  }

  const checkoutBranch = async (name, options = {}) => {
    const branch = String(name || '').trim()
    if (!workspace?.rootPath || !branch) return false
    setState((s) => ({ ...s, busy: true, error: '' }))
    const res = await window.api.gitCheckoutBranch(workspace.rootPath, branch, options)
    if (!res?.ok) {
      const error = res?.error || t('git.failed')
      if (!options.merge && isCheckoutBlockedByChanges(error)) {
        setState((s) => ({ ...s, busy: false, error: '' }))
        setBranchOpen(false)
        setBranchMenu(null)
        setCommitDialog({ type: 'checkoutBranch', branch: { name: branch }, error })
      } else if (options.merge) {
        setState((s) => ({ ...s, busy: false, error: '' }))
        setCommitDialog((dialog) => dialog?.type === 'checkoutBranch' ? { ...dialog, error } : dialog)
      } else {
        setState((s) => ({ ...s, busy: false, error }))
      }
      return false
    }
    await refresh({ quiet: true })
    onChanged?.()
    setCommitDialog((dialog) => dialog?.type === 'checkoutBranch' ? null : dialog)
    setBranchMenu(null)
    setBranchCreateOpen(false)
    setBranchOpen(false)
    return true
  }

  const confirmCheckoutBranch = async () => {
    const name = commitDialog?.branch?.name
    if (!name) return
    const ok = await checkoutBranch(name, { merge: true })
    if (ok) {
      setBranchMenu(null)
      setBranchCreateOpen(false)
      setBranchOpen(false)
    }
  }

  const createBranchAtCommit = async () => {
    const name = commitBranchName.trim()
    if (!name || !commitDialog?.commit) return
    const ok = await runGit((root) => window.api.gitCreateBranchAt(root, name, commitDialog.commit.hash))
    if (ok) {
      setCommitBranchName('')
      setCommitDialog(null)
    }
  }

  const restoreToCommit = async () => {
    if (!commitDialog?.commit) return
    const res = await runGit((root) => window.api.gitRestoreToCommit(root, commitDialog.commit.hash))
    if (res) {
      setSelectedCommit(null)
      setCommitFiles([])
      setHoverCommit(null)
      setCommitMenu(null)
      setCommitDialog(null)
      setDetailHeight(0)
    }
  }

  const mergeCommit = async () => {
    if (!commitDialog?.commit) return
    const ok = await runGit((root) => window.api.gitMergeCommit(root, commitDialog.commit.hash))
    if (ok) setCommitDialog(null)
  }

  const deleteBranch = async () => {
    const name = deleteBranchName.trim()
    if (!name) return
    const ok = await runGit((root) => window.api.gitDeleteBranch(root, name))
    if (ok) {
      setDeleteBranchName('')
      setBranchMenu(null)
      setCommitDialog(null)
    }
  }

  const discardChange = async () => {
    if (!discardFile) return
    const status = `${discardFile.x || ''}${discardFile.y || ''}`
    const ok = await runGit((root) => window.api.gitDiscardFile(root, discardFile.rel, status, discardFile.from))
    if (ok) setDiscardFile(null)
  }

  const renderFile = (f, staged) => (
    <div key={`${f.area || ''}:${f.x}${f.y}:${f.rel}`} className="git-row-wrap">
      <button className="git-row" title={f.from ? `${f.from} -> ${f.rel}` : f.rel} onClick={() => openChangedFileDiff(f, staged)}>
        <span className={`git-badge s-${statusText(f)}`}>{statusText(f)}</span>
        <span className="git-file">{f.rel}</span>
      </button>
      <button
        className="git-action danger"
        title="放弃本次变更"
        disabled={state.busy}
        onClick={() => setDiscardFile({ ...f, staged })}
      >
        <Icon name="discard" size={14} strokeWidth={1.9} />
      </button>
      <button
        className="git-action"
        title={staged ? t('git.unstage') : t('git.stage')}
        disabled={state.busy}
        onClick={() => runGit((root) => staged ? window.api.gitUnstage(root, f.rel) : window.api.gitStage(root, f.rel))}
      >
        <Icon name={staged ? 'minus' : 'plus'} size={14} />
      </button>
    </div>
  )

  const startHistoryDrag = (e) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = historyHeight
    const onMove = (ev) => {
      const next = startH - (ev.clientY - startY)
      setHistoryHeight(Math.min(520, Math.max(120, next)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('hm-row-resizing')
    }
    document.body.classList.add('hm-row-resizing')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="git-panel">
      <div className="sidebar-head">
        <span className="sidebar-title">{t('git.title')}</span>
        <div className="sidebar-head-actions">
          <button title={t('git.refresh')} onClick={refresh}>
            <Icon name="refresh" size={15} />
          </button>
        </div>
      </div>
      {!workspace ? (
        <div className="sidebar-empty"><Icon name="git" size={26} /><p>{t('side.noFolder')}</p></div>
      ) : state.repository === false ? (
        <div className="git-empty git-init-empty">
          <Icon name="source-control" size={30} strokeWidth={2} />
          <p>{t('git.noRepository')}</p>
          <button disabled={state.busy} onClick={initRepository}>{t('git.initRepository')}</button>
        </div>
      ) : state.error ? (
        <div className="git-empty">{state.error}</div>
      ) : state.loading && !state.files.length && !state.commits.length ? (
        <div className="git-empty">{t('git.loading')}</div>
      ) : (
        <div className={`git-body${state.busy ? ' is-busy' : ''}`}>
          {state.error && <div className="git-error">{state.error}</div>}
          <div className="git-changes-scroll">
            <div className="git-commit-box">
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault()
                    if (message.trim() && state.staged.length > 0) commit()
                  }
                }}
                placeholder={t('git.message')}
                rows={1}
              />
              <button disabled={state.busy || !message.trim() || state.staged.length === 0} onClick={commit}>
                <Icon name="check" size={14} />
                <span>{t('git.commit')}</span>
              </button>
            </div>

            <section className="git-section">
              <div className="git-section-title">
                <span>{t('git.staged')} ({state.staged.length})</span>
              </div>
              {state.staged.length === 0 ? (
                <div className="git-empty inline">{t('git.noStaged')}</div>
              ) : (
                <div className="git-list">
                  {state.staged.map((f) => renderFile(f, true))}
                </div>
              )}
            </section>

            <section className="git-section">
              <div className="git-section-title">
                <span>{t('git.changes')} ({state.unstaged.length})</span>
                {state.unstaged.length > 0 && (
                  <button title={t('git.stageAll')} disabled={state.busy} onClick={() => runGit((root) => window.api.gitStageAll(root))}>
                    <Icon name="plus" size={13} />
                  </button>
                )}
              </div>
              {state.unstaged.length === 0 ? (
                <div className="git-empty inline">{state.initialized ? t('git.initialized') : t('git.clean')}</div>
              ) : (
                <div className="git-list">
                  {state.unstaged.map((f) => renderFile(f, false))}
                </div>
              )}
            </section>
          </div>

          <section className="git-section git-history" style={{ height: historyHeight }}>
            <div className="git-history-resizer" onMouseDown={startHistoryDrag} title={t('git.history')} />
            <div className="git-section-title">{t('git.history')}</div>
            {state.commits.length === 0 ? (
              <div className="git-empty inline">{t('git.noCommits')}</div>
            ) : (
              <div className="git-graph">
                {state.commits.map((c, i) => (
                  c.kind === 'graph' ? (
                    <div
                      className="git-commit-block graph-spacer"
                      key={`graph:${c.graph}:${i}`}
                      style={{ '--graph-cols': graphCols }}
                    >
                      <GitGraphSvg
                        graph={c.graph}
                        prevGraph={state.commits[i - 1]?.graph}
                        nextGraph={state.commits[i + 1]?.graph}
                        cols={graphCols}
                        compact
                      />
                    </div>
                  ) : (
                    <div
                    className={`git-commit-block${selectedCommit?.hash === c.hash ? ' expanded' : ''}`}
                    key={`${c.hash}:${i}`}
                    style={{
                      '--graph-cols': graphCols,
                      '--active-lane': commitLane(c.graph, graphCols),
                      '--active-lane-color': graphColor(commitLane(c.graph, graphCols))
                    }}
                  >
                    <button
                      className={`git-commit${selectedCommit?.hash === c.hash ? ' active' : ''}`}
                      style={{ '--graph-cols': graphCols }}
                      title={c.message || c.subject}
                      onClick={() => selectCommit(c)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setHoverCommit(null)
                        setCommitMenu({
                          commit: c,
                          x: Math.min(e.clientX, window.innerWidth - 224),
                          y: Math.min(e.clientY, window.innerHeight - 160)
                        })
                      }}
                      onMouseEnter={(e) => {
                        const r = e.currentTarget.getBoundingClientRect()
                        const x = getEditorSurfaceLeft()
                        setHoverCommit({
                          commit: c,
                          x,
                          y: r.bottom + 6,
                          maxWidth: Math.max(220, window.innerWidth - x - 12)
                        })
                      }}
                      onMouseLeave={() => setHoverCommit(null)}
                    >
                      <GitGraphSvg
                        graph={c.graph}
                        prevGraph={state.commits[i - 1]?.graph}
                        nextGraph={state.commits[i + 1]?.graph}
                        cols={graphCols}
                        selected={selectedCommit?.hash === c.hash}
                        routeColorIndex={commitRouteColor.get(c.hash)}
                        prevRouteColorIndex={commitRouteColor.get(state.commits[i - 1]?.hash)}
                        extraHeight={selectedCommit?.hash === c.hash ? detailHeight : 0}
                      />
                      <div className="git-commit-main">
                        <div className="git-commit-subject">
                          <span>{c.subject}</span>
                          {c.branches?.length > 0 && (
                            <span
                              className="git-commit-branches"
                              title={c.branches.join(', ')}
                            >
                              {c.branches.slice(0, 2).map((branch, branchIndex) => (
                                <span
                                  className="git-commit-branch-chip"
                                  key={branch}
                                  style={{
                                    '--branch-chip-color': graphColor(
                                      branchLaneByName.get(branch) ??
                                      visibleGraphLanes(c.graph, graphCols)[branchIndex] ??
                                      commitLane(c.graph, graphCols)
                                    )
                                  }}
                                >
                                  {branch}
                                </span>
                              ))}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                    {selectedCommit?.hash === c.hash && (
                      <div className="git-commit-detail" ref={detailRef}>
                        {commitFiles.length === 0 ? (
                          <div className="git-empty inline">{t('git.loading')}</div>
                        ) : (
                          <div className="git-list">
                            {commitFiles.map((f) => (
                              <button
                                key={`${f.status}:${f.rel}`}
                                className="git-row git-commit-file"
                                onClick={() => openCommitFileDiff(f)}
                                title={f.from ? `${f.from} -> ${f.rel}` : f.rel}
                              >
                                <span className={`git-badge s-${f.status}`}>{f.status}</span>
                                <span className="git-file">{f.rel}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  )
                ))}
              </div>
            )}
          </section>
          {hoverCommit && createPortal(
            <div
              className="git-commit-pop"
              style={{
                left: hoverCommit.x,
                top: Math.max(12, Math.min(hoverCommit.y, window.innerHeight - 170)),
                maxWidth: Math.min(420, hoverCommit.maxWidth)
              }}
            >
              <div className="git-commit-pop-time">{formatCommitTime(hoverCommit.commit)}</div>
              <div className="git-commit-pop-msg">{hoverCommit.commit.message || hoverCommit.commit.subject}</div>
              {hoverCommit.commit.branches?.length > 2 && (
                <div className="git-commit-pop-branches">
                  <div>分支</div>
                  <div>
                    {hoverCommit.commit.branches.map((branch) => (
                      <span key={branch}>{branch}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>,
            document.body
          )}
          {commitMenu && (
            <div
              className="context-menu git-commit-menu"
              style={{ left: Math.max(8, commitMenu.x), top: Math.max(8, commitMenu.y) }}
              onClick={(e) => e.stopPropagation()}
            >
              <button onClick={() => {
                setCommitBranchName('')
                setCommitDialog({ type: 'branch', commit: commitMenu.commit })
                setCommitMenu(null)
              }}>从此次提交新建分支</button>
              <button onClick={() => {
                setCommitDialog({ type: 'merge', commit: commitMenu.commit })
                setCommitMenu(null)
              }}>合并到当前分支</button>
              <button onClick={() => {
                setCommitDialog({ type: 'restore', commit: commitMenu.commit })
                setCommitMenu(null)
              }}>恢复到此次提交状态</button>
              <div className="menu-sep" />
              <button className="danger" onClick={() => {
                setDeleteBranchName('')
                setCommitDialog({ type: 'deleteBranch', commit: commitMenu.commit })
                setCommitMenu(null)
              }}>删除分支...</button>
            </div>
          )}
          {commitDialog && (
            <div className="git-modal-backdrop" onMouseDown={() => setCommitDialog(null)}>
              <div className="git-modal" onMouseDown={(e) => e.stopPropagation()}>
                {commitDialog.type === 'branch' && (
                  <>
                    <div className="git-modal-head">从提交新建分支</div>
                    <div className="git-modal-body">
                      <div className="git-modal-commit">{commitDialog.commit.subject}</div>
                      <label>
                        <span>分支名称</span>
                        <input value={commitBranchName} onChange={(e) => setCommitBranchName(e.target.value)} autoFocus />
                      </label>
                    </div>
                    <div className="git-modal-foot">
                      <button onClick={() => setCommitDialog(null)}>取消</button>
                      <button className="primary" disabled={!commitBranchName.trim() || state.busy} onClick={createBranchAtCommit}>创建</button>
                    </div>
                  </>
                )}
                {commitDialog.type === 'merge' && (
                  <>
                    <div className="git-modal-head">合并到当前分支</div>
                    <div className="git-modal-body">
                      <p>这会把该提交合并到当前分支，并生成一个新的合并提交。合并前需要当前工作区没有未提交改动。</p>
                      <div className="git-modal-commit">{commitDialog.commit.subject}</div>
                    </div>
                    <div className="git-modal-foot">
                      <button onClick={() => setCommitDialog(null)}>取消</button>
                      <button className="primary" disabled={state.busy} onClick={mergeCommit}>确认合并</button>
                    </div>
                  </>
                )}
                {commitDialog.type === 'restore' && (
                  <>
                    <div className="git-modal-head">恢复到此次提交状态</div>
                    <div className="git-modal-body">
                      <p>这会执行 git reset --hard，把当前分支移动到该提交，并丢弃已跟踪文件的未提交改动和暂存区改动。</p>
                      <div className="git-modal-commit">{commitDialog.commit.subject}</div>
                    </div>
                    <div className="git-modal-foot">
                      <button onClick={() => setCommitDialog(null)}>取消</button>
                      <button className="danger" disabled={state.busy} onClick={restoreToCommit}>确认恢复</button>
                    </div>
                  </>
                )}
                {commitDialog.type === 'checkoutBranch' && (
                  <>
                    <div className="git-modal-head">切换分支</div>
                    <div className="git-modal-body">
                      <p>当前工作区有未提交改动，Git 阻止了直接切换。确认后会保留当前改动并尝试切换到目标分支。</p>
                      <div className="git-modal-commit">{commitDialog.branch.name}</div>
                      {commitDialog.error && <div className="git-error">{commitDialog.error}</div>}
                    </div>
                    <div className="git-modal-foot">
                      <button onClick={() => setCommitDialog(null)}>取消</button>
                      <button className="primary" disabled={state.busy} onClick={confirmCheckoutBranch}>保留改动并切换</button>
                    </div>
                  </>
                )}
                {commitDialog.type === 'deleteBranch' && (
                  <>
                    <div className="git-modal-head">删除分支</div>
                    <div className="git-modal-body">
                      <p>删除分支前请确认该分支已经不需要，或者已经合并到主分支。当前分支不能删除。</p>
                      {commitDialog.branch ? (
                        <div className="git-modal-commit">{deleteBranchName}</div>
                      ) : (
                        <label>
                          <span>要删除的分支</span>
                          <select value={deleteBranchName} onChange={(e) => setDeleteBranchName(e.target.value)} autoFocus>
                            <option value="">选择分支</option>
                            {state.branches.filter((b) => !b.current).map((b) => (
                              <option key={b.name} value={b.name}>{b.name}</option>
                            ))}
                          </select>
                        </label>
                      )}
                    </div>
                    <div className="git-modal-foot">
                      <button onClick={() => setCommitDialog(null)}>取消</button>
                      <button className="danger" disabled={!deleteBranchName || state.busy} onClick={deleteBranch}>确认删除</button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
          {discardFile && (
            <div className="git-modal-backdrop" onMouseDown={() => setDiscardFile(null)}>
              <div className="git-modal" onMouseDown={(e) => e.stopPropagation()}>
                <div className="git-modal-head">放弃本次变更</div>
                <div className="git-modal-body">
                  <p>这会丢弃该文件当前未提交的改动，未跟踪文件会被删除。此操作不能从软件内撤回。</p>
                  <div className="git-modal-commit">{discardFile.rel}</div>
                </div>
                <div className="git-modal-foot">
                  <button onClick={() => setDiscardFile(null)}>取消</button>
                  <button className="danger" disabled={state.busy} onClick={discardChange}>确认放弃</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {workspace && state.repository !== false && (
        <div className="git-footer" ref={branchFooterRef}>
          <div className="git-branch-controls">
            <button
              className="git-branch-btn"
              onClick={() => {
                setBranchCreateOpen(false)
                setBranchOpen((v) => !v)
              }}
            >
              <Icon name="git" size={13} /> {state.summary?.branch || 'HEAD'}
            </button>
            <button
              className={`git-branch-icon${branchCreateOpen ? ' active' : ''}`}
              title={t('git.newBranch')}
              onClick={() => {
                setNewBranch('')
                setBranchOpen(false)
                setBranchCreateOpen((v) => !v)
              }}
            >
              <Icon name={branchCreateOpen ? 'minus' : 'plus'} size={13} />
            </button>
          </div>
          <span>{state.commits.length} {t('git.commits')}</span>
          {branchOpen && (
            <div className="git-branch-pop">
              <div className="git-branch-title">{t('git.branch')}</div>
              <div className="git-branch-list">
                {state.branches.map((b) => (
                  <button
                    key={b.name}
                    className={b.current ? 'active' : ''}
                    disabled={state.busy}
                    onClick={() => {
                      if (!b.current) checkoutBranch(b.name)
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setBranchMenu({
                        branch: b,
                        x: Math.min(e.clientX, window.innerWidth - 208),
                        y: Math.min(e.clientY, window.innerHeight - 90)
                      })
                    }}
                  >
                    <Icon name={b.current ? 'check' : 'git'} size={13} />
                    <span>{b.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {branchCreateOpen && (
            <div className="git-branch-create-pop">
              <div className="git-branch-title">{t('git.newBranch')}</div>
              <div className="git-branch-new">
                <input
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') createBranch()
                    if (e.key === 'Escape') {
                      setNewBranch('')
                      setBranchCreateOpen(false)
                    }
                  }}
                  placeholder={t('git.newBranch')}
                  autoFocus
                />
                <button disabled={!newBranch.trim() || state.busy} onClick={createBranch}>
                  <Icon name="check" size={13} />
                </button>
              </div>
            </div>
          )}
          {branchMenu && (
            <div
              className="context-menu git-branch-menu"
              style={{ left: Math.max(8, branchMenu.x), top: Math.max(8, branchMenu.y) }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                className="danger"
                disabled={branchMenu.branch.current}
                onClick={() => {
                  if (branchMenu.branch.current) return
                  setDeleteBranchName(branchMenu.branch.name)
                  setCommitDialog({ type: 'deleteBranch', branch: branchMenu.branch })
                  setBranchMenu(null)
                  setBranchOpen(false)
                }}
              >
                删除分支...
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
