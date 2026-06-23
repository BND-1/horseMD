import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons.jsx'

const SYSTEM_PROMPT =
  'You are an AI writing assistant inside a Markdown editor. Help write, format, summarize, and improve the current document. Reply in Markdown. Do not claim you changed the file. When you provide text meant to be applied to the document, put the final replacement/addition in one fenced Markdown code block.'
const AGENT_PROMPT =
  'You are a Markdown editing agent. Rewrite ONLY the selected Markdown fragment to satisfy the user request. Return ONLY the final replacement fragment in one fenced markdown code block. No explanation.'

function applyTextFromReply(text) {
  const blocks = [...String(text || '').matchAll(/```(?:[\w-]+)?\s*\n([\s\S]*?)```/g)]
  return (blocks.at(-1)?.[1] || text || '').trim()
}

function renderInline(text) {
  const out = []
  const src = String(text || '')
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g
  let last = 0
  let key = 0
  for (const m of src.matchAll(re)) {
    if (m.index > last) out.push(src.slice(last, m.index))
    if (m[2]) out.push(<strong key={key++}>{m[2]}</strong>)
    else if (m[4]) out.push(<code key={key++}>{m[4]}</code>)
    else out.push(<a key={key++} href={m[7]} target="_blank" rel="noreferrer">{m[6]}</a>)
    last = m.index + m[0].length
  }
  if (last < src.length) out.push(src.slice(last))
  return out
}

function renderMarkdown(md) {
  const out = []
  const lines = String(md || '').split('\n')
  let list = []
  let code = null
  const flushList = (key) => {
    if (!list.length) return
    out.push(<ul key={`ul-${key}`}>{list}</ul>)
    list = []
  }
  const flushCode = (key) => {
    if (code == null) return
    out.push(<pre key={`code-${key}`}><code>{code.join('\n')}</code></pre>)
    code = null
  }
  lines.forEach((raw, i) => {
    const fence = raw.match(/^```/)
    if (fence) {
      code == null ? (flushList(i), code = []) : flushCode(i)
      return
    }
    if (code != null) {
      code.push(raw)
      return
    }
    const line = raw.trim()
    if (!line) {
      flushList(i)
      return
    }
    const h = line.match(/^(#{1,6})\s+(.+)$/)
    const li = line.match(/^[-*]\s+(.+)$/)
    const quote = line.match(/^>\s?(.+)$/)
    if (h) {
      flushList(i)
      out.push(<div key={i} className={`ai-md-h ai-md-h${Math.min(h[1].length, 3)}`}>{renderInline(h[2])}</div>)
    } else if (li) {
      list.push(<li key={i}>{renderInline(li[1])}</li>)
    } else if (quote) {
      flushList(i)
      out.push(<blockquote key={i}>{renderInline(quote[1])}</blockquote>)
    } else {
      flushList(i)
      out.push(<p key={i}>{renderInline(line)}</p>)
    }
  })
  flushList('end')
  flushCode('end')
  return out
}

export default function AiPanel({ t, tab, settings, onChangeSettings, getSelection, onApply, onClose }) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelOptions, setModelOptions] = useState([])
  const [modelStatus, setModelStatus] = useState('')
  const [agentMode, setAgentMode] = useState(false)
  const [messages, setMessages] = useState([
    { role: 'assistant', content: t('ai.welcome') }
  ])
  const endRef = useRef(null)
  useEffect(() => endRef.current?.scrollIntoView({ block: 'end' }), [messages, busy])

  useEffect(() => {
    setModelOptions([])
    setModelStatus('')
  }, [settings.aiProvider])

  const resetChat = () => {
    setMessages([{ role: 'assistant', content: t('ai.welcome') }])
    setInput('')
  }

  const isDeepseek = settings.aiProvider === 'deepseek'
  const active = isDeepseek
    ? {
        apiKey: settings.aiDeepseekApiKey,
        baseUrl: settings.aiDeepseekBaseUrl,
        model: settings.aiDeepseekModel
      }
    : {
        apiKey: settings.aiOpenaiApiKey,
        baseUrl: settings.aiOpenaiBaseUrl,
        model: settings.aiOpenaiModel
      }
  const modelKey = isDeepseek ? 'aiDeepseekModel' : 'aiOpenaiModel'
  const providerName = isDeepseek ? 'DeepSeek' : 'OpenAI'

  const fetchModels = async () => {
    if (!active.apiKey?.trim() || !active.baseUrl?.trim() || loadingModels) {
      setModelStatus(t('ai.needKeyBase'))
      return
    }
    setLoadingModels(true)
    setModelStatus('')
    const res = await window.api.aiModels({
      apiKey: active.apiKey,
      baseUrl: active.baseUrl
    })
    setLoadingModels(false)
    if (!res.ok) {
      setModelStatus(t('ai.modelsFailed', { msg: res.error }))
      return
    }
    setModelOptions(res.models || [])
    setModelStatus((res.models || []).length ? t('ai.modelsLoaded', { n: res.models.length }) : t('ai.noModels'))
  }

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    if (!active.apiKey?.trim() || !active.baseUrl?.trim() || !active.model?.trim()) {
      setMessages((m) => [...m, { role: 'assistant', content: t('ai.needConfig') }])
      setSettingsOpen(true)
      return
    }
    const next = [...messages, { role: 'user', content: text }]
    setInput('')
    setMessages(next)
    setBusy(true)
    const selected = agentMode ? getSelection?.() : null
    if (agentMode && !selected?.text) {
      setBusy(false)
      setMessages((m) => [...m, { role: 'assistant', content: t('ai.needSelection') }])
      return
    }
    const context = agentMode
      ? `Selected Markdown fragment:\n\n${selected.text}`
      : tab?.content
      ? `Current Markdown document (${tab.title || tab.path || 'Untitled'}):\n\n${tab.content.slice(0, 20000)}`
      : 'No document is currently open.'
    const res = await window.api.aiChat({
      apiKey: active.apiKey,
      baseUrl: active.baseUrl,
      model: active.model,
      messages: [
        { role: 'system', content: agentMode ? AGENT_PROMPT : SYSTEM_PROMPT },
        { role: 'user', content: context },
        ...(agentMode ? [{ role: 'user', content: text }] : next.slice(-12).map((m) => ({ role: m.role, content: m.content })))
      ]
    })
    setBusy(false)
    const content = res.ok ? res.text : t('ai.error', { msg: res.error })
    if (agentMode && res.ok) onApply?.(selected, applyTextFromReply(content))
    setMessages((m) => [...m, { role: 'assistant', content: agentMode && res.ok ? t('ai.agentApplied') : content }])
  }

  return (
    <aside className="ai-panel">
      <div className="ai-head">
        <div className="ai-title">
          <Icon name="sparkle" size={16} />
          <div>
            <span>{t('ai.title')}</span>
            <span className="ai-provider-line">{providerName} · {active.model || t('ai.noModel')}</span>
          </div>
        </div>
        <div className="ai-head-actions">
          <button className="icon-btn" title={t('ai.newChat')} onClick={resetChat}>
            <Icon name="plus" size={15} />
          </button>
          <button className="icon-btn" title={t('ai.settings')} onClick={() => setSettingsOpen(true)}>
            <Icon name="settings" size={15} />
          </button>
          <button className="icon-btn" title={t('tip.close')} onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </div>
      </div>
      <div className="ai-messages">
        <div className="ai-mode-tabs">
          <button className={!agentMode ? 'active' : ''} onClick={() => setAgentMode(false)}>{t('ai.chatMode')}</button>
          <button className={agentMode ? 'active' : ''} onClick={() => setAgentMode(true)}>{t('ai.agentMode')}</button>
        </div>
        {messages.map((m, i) => (
          <div key={i} className={`ai-msg ${m.role}`}>
            <div className="ai-msg-role">{m.role === 'user' ? t('ai.you') : t('ai.assistant')}</div>
            <div className="ai-msg-body">{m.role === 'assistant' ? renderMarkdown(m.content) : m.content}</div>
          </div>
        ))}
        {busy && <div className="ai-busy">{t('ai.thinking')}</div>}
        <div ref={endRef} />
      </div>
      <div className="ai-compose">
        <textarea
          value={input}
          placeholder={t('ai.placeholder')}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button className="ai-send" title={t('ai.send')} onClick={send} disabled={busy || !input.trim()}>
          <Icon name="chevron-up" size={16} />
        </button>
      </div>
      {settingsOpen && (
        <div className="ai-modal-backdrop" onMouseDown={() => setSettingsOpen(false)}>
          <div className="ai-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="ai-modal-head">
              <div className="ai-title">
                <Icon name="settings" size={16} />
                <span>{t('ai.settings')}</span>
              </div>
              <button className="icon-btn" title={t('tip.close')} onClick={() => setSettingsOpen(false)}>
                <Icon name="close" size={15} />
              </button>
            </div>
            <div className="ai-provider-tabs">
              <button
                className={settings.aiProvider !== 'deepseek' ? 'active' : ''}
                onClick={() => onChangeSettings({ aiProvider: 'openai' })}
              >
                OpenAI
              </button>
              <button
                className={settings.aiProvider === 'deepseek' ? 'active' : ''}
                onClick={() => onChangeSettings({ aiProvider: 'deepseek' })}
              >
                DeepSeek
              </button>
            </div>
            <div className="ai-form">
              <label>{t('ai.key')}<input type="password" value={active.apiKey} onChange={(e) => onChangeSettings({ [isDeepseek ? 'aiDeepseekApiKey' : 'aiOpenaiApiKey']: e.target.value })} /></label>
              <label>{t('ai.baseUrl')}<input placeholder={isDeepseek ? '' : t('ai.openaiBaseHint')} value={active.baseUrl} onChange={(e) => onChangeSettings({ [isDeepseek ? 'aiDeepseekBaseUrl' : 'aiOpenaiBaseUrl']: e.target.value })} /></label>
              <label>
                {t('ai.model')}
                <div className="ai-model-row">
                  <input value={active.model} onChange={(e) => onChangeSettings({ [modelKey]: e.target.value })} />
                  {modelOptions.length > 0 && (
                    <select value="" onChange={(e) => e.target.value && onChangeSettings({ [modelKey]: e.target.value })}>
                      <option value="">{t('ai.chooseModel')}</option>
                      {modelOptions.map((id) => <option key={id} value={id}>{id}</option>)}
                    </select>
                  )}
                  <button type="button" onClick={fetchModels} disabled={loadingModels}>
                    {loadingModels ? t('ai.fetchingModels') : t('ai.fetchModels')}
                  </button>
                </div>
                {modelStatus && <span className="ai-model-status">{modelStatus}</span>}
              </label>
            </div>
            <div className="ai-modal-foot">
              <button onClick={() => setSettingsOpen(false)}>{t('edit.confirm')}</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
