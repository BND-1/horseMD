# HorseMD 同步：账号服务接口（v1，2026-11-20）

Design and reasons: [`official-sync-design.md`](./official-sync-design.md) §2–§6.
This file is the contract between the three parts; change it first, then the code.

```
官网 /account ──┐
App（桌面/手机）─┼── HTTPS JSON ──▶ 账号服务 server/  ──STS──▶ 对象存储（MinIO / 七牛 / R2）
                │                    SQLite                      users/<uid>/…
App ────────────┴──── S3（临时凭证，内容先在本机加密）────────────────────────┘
```

The account service never sees file content. It holds accounts, sessions,
subscriptions and usage, and signs short-lived storage credentials limited to
the user's own prefix.

## Conventions

- Base URL: production `https://api.horsemd.yangsir.net` (not deployed yet);
  local `http://127.0.0.1:<port>`.
- JSON in and out, UTF-8. Every response is `{ ok: true, ... }` or
  `{ ok: false, error: <code>, message: <中文说明> }` with a 4xx/5xx status.
- Auth: `Authorization: Bearer <accessToken>` on every route marked 🔒.
- Error codes (stable, clients switch on them): `bad-request`,
  `invalid-email`, `rate-limited` (+ `retryAfter` seconds), `code-invalid`,
  `code-expired`, `code-attempts`, `unauthorized` (access token missing /
  bad / expired → refresh), `refresh-invalid` (log in again), `no-plan`,
  `over-quota`, `billing-unavailable` (Paddle not configured), `not-found`,
  `server`.
- CORS: `Access-Control-Allow-Origin` for the configured site origins
  (`HM_ACCOUNT_ORIGINS`, comma separated; default
  `https://horsemd.yangsir.net`) and any `http://localhost:*` /
  `http://127.0.0.1:*`; `Authorization, Content-Type` allowed; OPTIONS → 204.
  The apps call it from the main process / native HTTP (no CORS involved).

## Login: email + 6-digit code (no password)

### `POST /v1/auth/email/start`  `{ email }`
Sends a code. Lower-cased, trimmed; must look like an email (≤ 254 chars).
- Code: 6 digits, valid 10 minutes, stored only as a hash, 5 wrong tries
  then dead. A new code replaces the previous one.
- Limits: one per email per 60 s, 5 per email per hour, 20 per IP per hour
  → `rate-limited` with `retryAfter`.
- Always answers `{ ok: true, expiresIn: 600 }` for a valid address (the
  account is created on verify, not here).

### `POST /v1/auth/email/verify`  `{ email, code, device? }`
`device`: free text shown in the session list (e.g. "Mac mini · HorseMD 0.14.4").
Creates the user on first success.
→ `{ ok, accessToken, accessExpiresAt, refreshToken, user: { id, email } }`
- `accessToken`: HMAC-SHA256 signed (`HM_ACCOUNT_SECRET`), 1 hour,
  `{ sub: userId, sid: sessionId, exp }`; format `v1.<base64url payload>.<base64url sig>`.
- `refreshToken`: 32 random bytes base64url, stored only as SHA-256; 180
  days; rotated on every refresh.

### `POST /v1/auth/refresh`  `{ refreshToken }`
→ same shape as verify (new access + NEW refresh token; the old one stops
working). Unknown / revoked / expired → `refresh-invalid`. Reusing an
already-rotated token revokes that whole session (theft signal).

### `POST /v1/auth/logout`  `{ refreshToken }` → `{ ok }` (session revoked; idempotent)

## Account

### 🔒 `GET /v1/me`
```
{ ok, user: { id, email, createdAt },
  plan: { id: 'none'|'standard'|'plus', status: 'none'|'active'|'past_due'|'canceled',
          storageBytes, fileBytes, historyDays, renewsAt|null, endsAt|null, source: 'paddle'|'apple'|'manual'|null },
  usage: { bytes, objects, measuredAt|null },
  storage: { writable: boolean, reason: null|'no-plan'|'over-quota' } }
```
Plans (configurable later): `standard` 1 GiB / 5 MiB per file / 30 days;
`plus` 10 GiB / 200 MiB / 365 days; `none` 0.

### 🔒 `POST /v1/storage/credentials`
→ `{ ok, endpoint, region, bucket, prefix: 'users/<userId>', accessKeyId,
secretAccessKey, sessionToken, expiresAt, writable, fileBytes }`
- STS AssumeRole (AWS-compatible; MinIO for development) with a session
  policy: `s3:ListBucket` on the bucket with `s3:prefix` `users/<uid>/*`
  (and `users/<uid>`), object actions on `arn:aws:s3:::<bucket>/users/<uid>/*`:
  `GetObject`, `DeleteObject` always; `PutObject` only when writable.
- Duration 1 hour.
- No active plan and nothing stored → `no-plan` (402). No active plan but
  data stored → read-only credentials (`writable: false`, the user can still
  download / delete). Over quota → read-only.

## Billing (Paddle Billing; Apple IAP later)

### `GET /v1/billing/config`
→ `{ ok, enabled, environment: 'sandbox'|'production', clientToken, prices: [{ plan, interval: 'month'|'year', priceId }] }`.
`enabled: false` (and nothing else) when Paddle is not configured.

### 🔒 `POST /v1/billing/portal` → `{ ok, url }`
Paddle customer portal session for the user's Paddle customer
(`POST https://api.paddle.com/customers/{id}/portal-sessions`, sandbox:
`sandbox-api.paddle.com`). No Paddle customer yet → `not-found`.

### `POST /v1/webhooks/paddle`
- Verifies `Paddle-Signature: ts=<unix>;h1=<hex>` = HMAC-SHA256 over
  `<ts>:<raw body>` with `HM_PADDLE_WEBHOOK_SECRET`; |now − ts| ≤ 300 s;
  else 401. Constant-time compare.
- Handles `subscription.created|updated|activated|canceled|past_due|paused|resumed`:
  user = `data.custom_data.userId` (set by the site's checkout), else the
  customer already linked; plan = the price id's plan; status from
  `data.status`; `renewsAt` = `next_billed_at`; `endsAt` from
  `scheduled_change` / `canceled_at`. Stores `customer_id` on the user.
- Idempotent by `event_id` (stored); unknown events → 200 ignored.

## Usage

The service measures each user's prefix (ListObjectsV2 with the admin
credentials, paginated) at most every 10 minutes when credentials are
asked for, and in a background sweep every hour; `GET /v1/me` shows the
last measurement.

## Server configuration (env)

| var | meaning |
|---|---|
| `HM_ACCOUNT_PORT` / `HM_ACCOUNT_HOST` | listen (default 8790 / 127.0.0.1) |
| `HM_ACCOUNT_DB` | SQLite path (default `./data/account.db`) |
| `HM_ACCOUNT_SECRET` | ≥ 32 chars, signs access tokens (required) |
| `HM_ACCOUNT_ORIGINS` | CORS origins |
| `HM_STORAGE_ENDPOINT`, `HM_STORAGE_REGION`, `HM_STORAGE_BUCKET` | object storage |
| `HM_STORAGE_PUBLIC_ENDPOINT` | endpoint handed to apps (default = endpoint) |
| `HM_STORAGE_ACCESS_KEY`, `HM_STORAGE_SECRET_KEY` | admin key (usage + STS) |
| `HM_STORAGE_STS_ENDPOINT` | STS endpoint (MinIO: same as storage) |
| `HM_STORAGE_ROLE_ARN` | AssumeRole RoleArn (MinIO ignores it) |
| `HM_MAIL` | `log` (dev: codes written to the log / `HM_MAIL_LOG` file) or `resend` |
| `HM_RESEND_KEY`, `HM_MAIL_FROM` | Resend API |
| `HM_PADDLE_ENV`, `HM_PADDLE_API_KEY`, `HM_PADDLE_CLIENT_TOKEN`, `HM_PADDLE_WEBHOOK_SECRET`, `HM_PADDLE_PRICES` (`standard:month:pri_…,plus:year:pri_…`) | billing |

Secrets come only from the environment, never from files in the repo.

## App side

- Connection type `horsemd`: `{ id, type: 'horsemd', provider: 'horsemd', name, server, email, userId, createdAt }`;
  the credential store holds `{ refreshToken }`.
- `createProvider` → asks `/v1/storage/credentials` (refreshing the access
  token when needed) → `S3Provider` with `sessionToken` and prefix
  `users/<uid>/<workspace prefix>`; credentials refresh themselves 5 minutes
  before `expiresAt` (a throttled sync can run longer than an hour).
- New folders on HorseMD 同步 default to 端到端加密 on (Obsidian).

## Implementation notes (2026-11-20, from building it)

- Login codes are stored as HMAC-SHA256 keyed by `HM_ACCOUNT_SECRET` (a plain
  SHA-256 of 6 digits is reversible by trying all of them).
- Status codes: `code-*` 400 (`code-invalid` carries `attemptsLeft`), `no-plan`
  402, `rate-limited` 429, `billing-unavailable` 503, body over 64 KB 413.
- Usage is re-measured at once when the cached figure would refuse the user
  (no plan + nothing stored, or over quota), not only after 10 minutes.
- Every authenticated request checks the session is not revoked (logout is
  immediate). Refresh-token rotation has no grace window: clients must
  serialize renewals (the app does, per connection).
- Paddle events are applied in `occurred_at` order per subscription; an event
  for an unknown user / price is answered 200 `ignored`. `enabled` in
  `/v1/billing/config` needs all four Paddle variables; the webhook needs only
  its secret.
- Apps renew storage credentials older than 15 s at the start of a run, so
  an ended plan / full storage turns read-only on the next run. Credentials
  already issued stay valid up to their hour at the storage itself.
