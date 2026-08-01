export const AI_PROVIDER_KINDS = Object.freeze([
  'openai',
  'openai-compatible',
  'anthropic',
  'claude-cli',
  'codex-cli',
  'gemini-cli'
])

export const AI_CONTEXT_SCOPES = Object.freeze(['selection', 'section', 'document'])
export const AI_EVENT_TYPES = Object.freeze(['start', 'delta', 'usage', 'finish', 'error', 'canceled'])
export const AI_ERROR_CODES = Object.freeze([
  'auth',
  'rate-limit',
  'network',
  'timeout',
  'invalid-response',
  'canceled',
  'unknown'
])

export function normalizeAiRequest(request = {}) {
  const provider = AI_PROVIDER_KINDS.includes(request.provider) ? request.provider : null
  const messages = Array.isArray(request.messages)
    ? request.messages
      .map((message) => ({
        role: ['system', 'user', 'assistant'].includes(message?.role) ? message.role : 'user',
        content: String(message?.content || '').slice(0, 500000)
      }))
      .filter((message) => message.content)
    : []
  if (!provider) throw new Error('invalid-ai-provider')
  if (!messages.length) throw new Error('empty-ai-messages')
  return {
    provider,
    model: String(request.model || '').trim().slice(0, 200),
    messages,
    context: request.context || null,
    timeoutMs: Math.min(300000, Math.max(5000, Number(request.timeoutMs) || 120000))
  }
}

export function assertProviderAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('invalid-provider-adapter')
  for (const method of ['capabilities', 'validateConfig', 'invoke', 'cancel']) {
    if (typeof adapter[method] !== 'function') throw new Error(`provider-adapter-missing-${method}`)
  }
  return adapter
}

export function createAiEvent(type, payload = {}) {
  if (!AI_EVENT_TYPES.includes(type)) throw new Error('invalid-ai-event')
  return { type, ...payload }
}

