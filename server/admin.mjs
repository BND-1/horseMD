import { createStore, openDb } from './db.mjs'
import { normalizeEmail } from './email.mjs'
import { PAID_PLANS, iso, planState } from './plans.mjs'

// Owner / test CLI, works on the database directly (the server may run):
//   node server/admin.mjs grant <email> <plan> [days]
//   node server/admin.mjs revoke <email>
//   node server/admin.mjs show <email>
const DAY = 24 * 3600 * 1000
const [command, rawEmail, plan, days] = process.argv.slice(2)

function usage(message) {
  if (message) console.error(message)
  console.error('用法：node server/admin.mjs grant <email> <standard|plus> [天数]')
  console.error('      node server/admin.mjs revoke <email>')
  console.error('      node server/admin.mjs show <email>')
  process.exit(1)
}

if (!['grant', 'revoke', 'show'].includes(command)) usage()
const email = normalizeEmail(rawEmail)
if (!email) usage('邮箱地址格式不对。')

const db = openDb(process.env.HM_ACCOUNT_DB || './data/account.db')
const store = createStore(db)
const now = Date.now()

function describe(user) {
  const row = store.getPlan(user.id)
  const usage = store.getUsage(user.id)
  return {
    user: { id: user.id, email: user.email, createdAt: iso(user.created_at), paddleCustomerId: user.paddle_customer_id || null },
    plan: planState(row, now).plan,
    stored: row ? { plan: row.plan, status: row.status, source: row.source, subscriptionId: row.subscription_id, renewsAt: iso(row.renews_at), endsAt: iso(row.ends_at) } : null,
    usage: usage ? { bytes: usage.bytes, objects: usage.objects, measuredAt: iso(usage.measured_at) } : null,
    sessions: store.activeSessions(user.id, now).map((session) => ({ id: session.id, device: session.device, lastUsedAt: iso(session.last_used_at) }))
  }
}

try {
  if (command === 'grant') {
    if (!PAID_PLANS.includes(plan)) usage(`套餐只能是 ${PAID_PLANS.join(' / ')}。`)
    let endsAt = null
    if (days !== undefined) {
      const count = Number(days)
      if (!Number.isInteger(count) || count <= 0) usage('天数要是正整数。')
      endsAt = now + count * DAY
    }
    const user = store.transaction(() => {
      const user = store.userByEmail(email) || store.createUser(email, now)
      store.setPlan(user.id, { plan, status: 'active', endsAt, source: 'manual', now })
      return user
    })
    console.log(JSON.stringify(describe(user), null, 2))
  } else {
    const user = store.userByEmail(email)
    if (!user) {
      console.error(`没有这个用户：${email}`)
      process.exitCode = 1
    } else if (command === 'revoke') {
      store.deletePlan(user.id)
      console.log(JSON.stringify(describe(user), null, 2))
    } else {
      console.log(JSON.stringify(describe(user), null, 2))
    }
  }
} finally {
  db.close()
}
