import { createHmac } from 'node:crypto'
import { safeEqual } from './tokens.mjs'
import { PAID_PLANS } from './plans.mjs'

// HM_PADDLE_PRICES: `standard:month:pri_…,plus:year:pri_…`
export function parsePrices(text) {
  const prices = []
  for (const entry of String(text || '').split(',').map((part) => part.trim()).filter(Boolean)) {
    const [plan, interval, priceId, ...rest] = entry.split(':').map((part) => part.trim())
    if (rest.length || !PAID_PLANS.includes(plan) || !['month', 'year'].includes(interval) || !priceId) {
      throw new Error(`HM_PADDLE_PRICES 里的「${entry}」格式不对，应为 standard:month:pri_…`)
    }
    prices.push({ plan, interval, priceId })
  }
  return prices
}

export const HANDLED_EVENTS = new Set([
  'subscription.created',
  'subscription.updated',
  'subscription.activated',
  'subscription.canceled',
  'subscription.past_due',
  'subscription.paused',
  'subscription.resumed'
])

// Paddle subscription status → ours. trialing is a running plan; paused
// and anything unknown give no plan (planState treats them as inactive).
const STATUS = { active: 'active', trialing: 'active', past_due: 'past_due', canceled: 'canceled', paused: 'paused' }

const time = (value) => {
  const ms = Date.parse(value ?? '')
  return Number.isFinite(ms) ? ms : null
}

export function createBilling({ env = 'production', apiKey = '', clientToken = '', webhookSecret = '', prices = [], fetch = globalThis.fetch } = {}) {
  const environment = env === 'sandbox' ? 'sandbox' : 'production'
  const apiBase = environment === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com'
  const enabled = Boolean(apiKey && clientToken && webhookSecret && prices.length)
  const planByPrice = new Map(prices.map((price) => [price.priceId, price.plan]))

  return {
    enabled,
    environment,
    hasWebhookSecret: Boolean(webhookSecret),

    config() {
      if (!enabled) return { enabled: false }
      return { enabled: true, environment, clientToken, prices: prices.map(({ plan, interval, priceId }) => ({ plan, interval, priceId })) }
    },

    planForPrice: (priceId) => planByPrice.get(priceId) || null,

    // Paddle-Signature: ts=<unix>;h1=<hex>[;h1=<hex>] (two h1 during a
    // secret rotation). HMAC-SHA256 over `<ts>:<raw body bytes>`.
    verifySignature(header, rawBody, nowMs) {
      if (!webhookSecret || typeof header !== 'string') return false
      let ts = null
      const signatures = []
      for (const part of header.split(';')) {
        const index = part.indexOf('=')
        if (index < 0) continue
        const key = part.slice(0, index).trim()
        const value = part.slice(index + 1).trim()
        if (key === 'ts') ts = value
        else if (key === 'h1') signatures.push(value.toLowerCase())
      }
      if (!ts || !/^\d{1,12}$/.test(ts) || !signatures.length) return false
      if (Math.abs(nowMs / 1000 - Number(ts)) > 300) return false
      const expected = createHmac('sha256', webhookSecret).update(`${ts}:`).update(rawBody).digest('hex')
      let match = false
      for (const signature of signatures) if (safeEqual(signature, expected)) match = true
      return match
    },

    // One verified event. Runs in a transaction; the event id is stored so a
    // redelivery changes nothing.
    handleEvent({ store, event, now }) {
      const eventId = typeof event?.event_id === 'string' ? event.event_id : null
      const type = typeof event?.event_type === 'string' ? event.event_type : null
      if (!eventId || !type) return { error: 'bad-request' }
      if (!HANDLED_EVENTS.has(type)) return { ignored: 'event-type' }
      return store.transaction(() => {
        if (store.paddleEventSeen(eventId)) return { duplicate: true }
        store.recordPaddleEvent(eventId, type, now)
        const data = event.data || {}
        const customerId = typeof data.customer_id === 'string' ? data.customer_id : null
        const claimedUser = data.custom_data && typeof data.custom_data.userId === 'string' ? data.custom_data.userId : null
        let user = claimedUser ? store.userById(claimedUser) : null
        if (!user && customerId) user = store.userByCustomer(customerId)
        if (!user) return { ignored: 'unknown-user' }
        if (customerId && user.paddle_customer_id !== customerId) store.setCustomer(user.id, customerId)

        const items = Array.isArray(data.items) ? data.items : []
        const plan = items.map((item) => planByPrice.get(item?.price?.id || item?.price_id)).find(Boolean)
        if (!plan) return { ignored: 'unknown-price' }

        // Paddle does not promise delivery order: an older event for the
        // same subscription must not undo a newer one.
        const occurredAt = time(event.occurred_at) ?? now
        const current = store.getPlan(user.id)
        if (current?.source === 'paddle' && current.subscription_id === data.id && current.event_at != null && current.event_at > occurredAt) {
          return { ignored: 'stale' }
        }

        const status = STATUS[data.status] || 'none'
        const scheduled = data.scheduled_change
        let endsAt = scheduled && (scheduled.action === 'cancel' || scheduled.action === 'pause') ? time(scheduled.effective_at) : null
        if (status === 'canceled') endsAt = time(data.canceled_at) ?? time(data.current_billing_period?.ends_at) ?? endsAt ?? occurredAt
        store.setPlan(user.id, {
          plan,
          status,
          renewsAt: status === 'canceled' ? null : time(data.next_billed_at),
          endsAt,
          source: 'paddle',
          subscriptionId: typeof data.id === 'string' ? data.id : null,
          eventAt: occurredAt,
          now
        })
        return { applied: true }
      })
    },

    // https://developer.paddle.com/api-reference/customer-portals/create-customer-portal-session
    async portalUrl(customerId, subscriptionIds = []) {
      const response = await fetch(`${apiBase}/customers/${encodeURIComponent(customerId)}/portal-sessions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(subscriptionIds.length ? { subscription_ids: subscriptionIds } : {}),
        signal: AbortSignal.timeout(15000)
      })
      let json = null
      try { json = await response.json() } catch { /* reported below */ }
      if (!response.ok) throw new Error(`Paddle portal HTTP ${response.status}${json?.error?.code ? ` ${json.error.code}` : ''}`)
      const url = json?.data?.urls?.general?.overview
      if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error('Paddle 没有返回客户门户地址。')
      return url
    }
  }
}
