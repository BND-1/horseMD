import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { newId } from './tokens.mjs'

// All timestamps are unix milliseconds.
const MIGRATIONS = [
  // 1: first schema (2026-11-20)
  `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    paddle_customer_id TEXT
  );
  CREATE INDEX IF NOT EXISTS users_paddle_customer ON users(paddle_customer_id);

  CREATE TABLE IF NOT EXISTS login_codes (
    email TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS code_sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    ip TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS code_sends_email ON code_sends(email, at);
  CREATE INDEX IF NOT EXISTS code_sends_ip ON code_sends(ip, at);

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

  -- Every refresh token ever issued, as SHA-256. A rotated one is kept until
  -- it would have expired so that its reuse can be recognized.
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    rotated_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS refresh_tokens_session ON refresh_tokens(session_id);

  -- One row per user: the current plan, whichever source set it last.
  CREATE TABLE IF NOT EXISTS plans (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL,
    status TEXT NOT NULL,
    renews_at INTEGER,
    ends_at INTEGER,
    source TEXT NOT NULL,
    subscription_id TEXT,
    event_at INTEGER,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS usage (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    bytes INTEGER NOT NULL,
    objects INTEGER NOT NULL,
    measured_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS paddle_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );
  `
]

export function openDb(path) {
  const file = path === ':memory:' ? path : resolve(path)
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db)
  return db
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
  const current = db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v ?? 0
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(MIGRATIONS[version])
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version + 1)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const SEND_COLUMNS = { email: 'email', ip: 'ip' }

// Data access. node:sqlite is synchronous, so a transaction never
// interleaves with another request inside this process.
export function createStore(db) {
  const q = (sql) => db.prepare(sql)
  let depth = 0

  const store = {
    db,

    transaction(fn) {
      if (depth > 0) return fn()
      db.exec('BEGIN IMMEDIATE')
      depth++
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      } finally {
        depth--
      }
    },

    // users
    userById: (id) => q('SELECT * FROM users WHERE id = ?').get(String(id)),
    userByEmail: (email) => q('SELECT * FROM users WHERE email = ?').get(email),
    userByCustomer: (customerId) => q('SELECT * FROM users WHERE paddle_customer_id = ? ORDER BY created_at LIMIT 1').get(customerId),
    createUser(email, now) {
      const id = newId('u')
      q('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(id, email, now)
      return store.userById(id)
    },
    setCustomer: (userId, customerId) => q('UPDATE users SET paddle_customer_id = ? WHERE id = ?').run(customerId, userId),

    // login codes
    getCode: (email) => q('SELECT * FROM login_codes WHERE email = ?').get(email),
    putCode: (email, hash, expiresAt, now) => q(`
      INSERT INTO login_codes (email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)
      ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
        attempts = 0, created_at = excluded.created_at`).run(email, hash, expiresAt, now),
    bumpCodeAttempts(email) {
      q('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?').run(email)
      return store.getCode(email)?.attempts ?? 0
    },
    deleteCode: (email) => q('DELETE FROM login_codes WHERE email = ?').run(email),
    recordSend: (email, ip, now) => q('INSERT INTO code_sends (email, ip, at) VALUES (?, ?, ?)').run(email, ip, now),
    // Ascending send times since `since` for one email or one IP.
    sendTimes(kind, value, since) {
      const column = SEND_COLUMNS[kind]
      if (!column) throw new Error(`unknown send kind ${kind}`)
      return q(`SELECT at FROM code_sends WHERE ${column} = ? AND at > ? ORDER BY at`).all(value, since).map((row) => row.at)
    },

    // sessions + refresh tokens
    createSession({ userId, device, refreshHash, now, expiresAt }) {
      const id = newId('s', 16)
      q('INSERT INTO sessions (id, user_id, device, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, userId, device || null, now, now, expiresAt)
      q('INSERT INTO refresh_tokens (hash, session_id, issued_at, expires_at) VALUES (?, ?, ?, ?)').run(refreshHash, id, now, expiresAt)
      return id
    },
    sessionById: (id) => q('SELECT * FROM sessions WHERE id = ?').get(String(id)),
    refreshByHash: (hash) => q(`
      SELECT t.hash, t.session_id, t.expires_at, t.rotated_at, s.user_id, s.revoked_at, s.device
      FROM refresh_tokens t JOIN sessions s ON s.id = t.session_id WHERE t.hash = ?`).get(hash),
    rotateRefresh({ oldHash, newHash, sessionId, now, expiresAt }) {
      q('UPDATE refresh_tokens SET rotated_at = ? WHERE hash = ?').run(now, oldHash)
      q('INSERT INTO refresh_tokens (hash, session_id, issued_at, expires_at) VALUES (?, ?, ?, ?)').run(newHash, sessionId, now, expiresAt)
      q('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?').run(now, expiresAt, sessionId)
    },
    revokeSession: (id, now) => q('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(now, id),
    activeSessions: (userId, now) => q('SELECT id, device, created_at, last_used_at, expires_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_used_at DESC').all(userId, now),

    // plans
    getPlan: (userId) => q('SELECT * FROM plans WHERE user_id = ?').get(userId),
    setPlan(userId, { plan, status, renewsAt = null, endsAt = null, source, subscriptionId = null, eventAt = null, now }) {
      q(`
        INSERT INTO plans (user_id, plan, status, renews_at, ends_at, source, subscription_id, event_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, status = excluded.status, renews_at = excluded.renews_at,
          ends_at = excluded.ends_at, source = excluded.source, subscription_id = excluded.subscription_id,
          event_at = excluded.event_at, updated_at = excluded.updated_at`)
        .run(userId, plan, status, renewsAt, endsAt, source, subscriptionId, eventAt, now)
    },
    deletePlan: (userId) => q('DELETE FROM plans WHERE user_id = ?').run(userId),

    // usage
    getUsage: (userId) => q('SELECT * FROM usage WHERE user_id = ?').get(userId),
    setUsage: (userId, bytes, objects, now) => q(`
      INSERT INTO usage (user_id, bytes, objects, measured_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET bytes = excluded.bytes, objects = excluded.objects, measured_at = excluded.measured_at`)
      .run(userId, bytes, objects, now),
    // Users whose prefix can hold data: anyone measured before (credentials
    // were asked for) or holding a plan.
    usageUserIds: () => q('SELECT user_id FROM usage UNION SELECT user_id FROM plans').all().map((row) => row.user_id),

    // Paddle
    paddleEventSeen: (eventId) => Boolean(q('SELECT 1 FROM paddle_events WHERE event_id = ?').get(eventId)),
    recordPaddleEvent: (eventId, type, now) => q('INSERT INTO paddle_events (event_id, event_type, received_at) VALUES (?, ?, ?)').run(eventId, type, now),

    // Housekeeping (hourly).
    prune(now) {
      store.transaction(() => {
        q('DELETE FROM login_codes WHERE expires_at < ?').run(now - HOUR)
        q('DELETE FROM code_sends WHERE at < ?').run(now - 2 * HOUR)
        q('DELETE FROM refresh_tokens WHERE expires_at < ?').run(now)
        q('DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?').run(now - 30 * DAY, now - 30 * DAY)
        // Paddle retries a webhook for 3 days at most.
        q('DELETE FROM paddle_events WHERE received_at < ?').run(now - 30 * DAY)
      })
    }
  }
  return store
}
