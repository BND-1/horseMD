// Plan limits (docs/official-sync-api.md › Account). Obsidian Sync's tiers.
const MiB = 1024 ** 2
const GiB = 1024 ** 3

export const PLANS = {
  none: { storageBytes: 0, fileBytes: 0, historyDays: 0 },
  standard: { storageBytes: GiB, fileBytes: 5 * MiB, historyDays: 30 },
  plus: { storageBytes: 10 * GiB, fileBytes: 200 * MiB, historyDays: 365 }
}

export const PAID_PLANS = ['standard', 'plus']

export const iso = (ms) => (ms == null ? null : new Date(ms).toISOString())

const NO_PLAN = { id: 'none', status: 'none', ...PLANS.none, renewsAt: null, endsAt: null, source: null }

// `row` is the plans table row (or undefined). past_due counts as active
// (Paddle is still retrying the payment); canceled stays active until
// endsAt; anything past its endsAt, paused or unknown is no plan.
export function planState(row, now) {
  const limits = row && PAID_PLANS.includes(row.plan) ? PLANS[row.plan] : null
  if (!limits) return { active: false, plan: { ...NO_PLAN } }
  const ends = row.ends_at ?? null
  const inTerm = ends == null || ends > now
  const active = ((row.status === 'active' || row.status === 'past_due') && inTerm)
    || (row.status === 'canceled' && ends != null && ends > now)
  if (!active) return { active: false, plan: { ...NO_PLAN } }
  return {
    active: true,
    plan: {
      id: row.plan,
      status: row.status,
      ...limits,
      renewsAt: iso(row.renews_at),
      endsAt: iso(ends),
      source: row.source || null
    }
  }
}

// What the storage may do: no plan → read-only (or no credentials at all
// when nothing is stored, decided by the caller); full → read-only.
export function storageStatus(state, usageBytes) {
  if (!state.active) return { writable: false, reason: 'no-plan' }
  if (usageBytes >= state.plan.storageBytes) return { writable: false, reason: 'over-quota' }
  return { writable: true, reason: null }
}
