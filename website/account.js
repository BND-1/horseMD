/* ───────────────────────────────────────────────────────────
   HorseMD 官网 · 账号页
   邮箱验证码登录 → 套餐 / 用量 → Paddle 订阅。
   接口约定见仓库 docs/official-sync-api.md。
   ─────────────────────────────────────────────────────────── */

/* ── i18n（和首页共用语言选择 horsemd.site.lang）─────────── */
const I18N = {
  zh: {
    'nav.features': '特性', 'nav.guide': '教程', 'nav.account': '账号', 'nav.home': '首页', 'nav.privacy': '隐私',
    'acct.title': 'HorseMD 同步账号',
    'acct.lead': '用邮箱登录，查看套餐和存储用量。不需要密码。',
    'acct.loading': '正在读取账号…',
    'acct.loadFailed': '读不到账号信息。',
    'acct.retry': '重试',
    'api.banner': '正在连接测试服务器：{url}',
    'api.reset': '改回正式服务器',
    'login.email': '邮箱',
    'login.send': '发送验证码',
    'login.resend': '重新发送',
    'login.sending': '正在发送…',
    'login.wait': '{s} 秒后可重发',
    'login.code': '验证码',
    'login.verify': '登录',
    'login.verifying': '正在登录…',
    'login.change': '换一个邮箱',
    'login.sent': '6 位验证码已发到 {email}，10 分钟内有效。',
    'login.expired': '登录已过期，请重新登录。',
    'login.loggedOut': '已退出登录。',
    'me.email': '邮箱', 'me.plan': '套餐', 'me.status': '状态',
    'me.renews': '下次续费', 'me.ends': '到期',
    'me.storage': '存储空间', 'me.file': '单个文件上限', 'me.history': '版本历史',
    'me.usage': '已用 {used} / {total}',
    'me.usageNoPlan': '已用 {used}',
    'me.measured': '统计于 {time}',
    'me.notMeasured': '还没有统计过用量',
    'me.days': '{n} 天',
    'me.none': '—',
    'me.manage': '管理订阅',
    'me.logout': '退出登录',
    'me.opening': '正在打开…',
    'me.apple': '这个订阅是在 App Store 买的，请在 iPhone 的「设置 → Apple 账户 → 订阅」里管理。',
    'plan.none': '还没有订阅', 'plan.standard': '标准版', 'plan.plus': '增强版',
    'status.none': '未订阅', 'status.active': '生效中', 'status.past_due': '付款未成功', 'status.canceled': '已取消',
    'reason.noPlan': '还没有订阅。订阅后就能在你的所有设备之间同步。',
    'reason.noPlanData': '没有生效中的订阅：云端已有的文件还能下载和删除，但不能上传新内容（只读）。',
    'reason.overQuota': '已用空间超过套餐上限：同步暂时只读，可以下载和删除。删掉一些文件或升级套餐后恢复上传。',
    'reason.pastDue': '最近一次扣款没有成功，请在「管理订阅」里更新付款方式，否则订阅会停止。',
    'reason.canceled': '订阅已取消，到期后同步变为只读。',
    'plans.title': '同步套餐',
    'plans.interval': '付费周期',
    'plans.month': '月付', 'plans.year': '年付',
    'plans.perMonth': '{price} / 月', 'plans.perYear': '{price} / 年',
    'plan.standard.storage': '1 GB 存储空间',
    'plan.standard.file': '单个文件最大 5 MB',
    'plan.standard.history': '1 个月版本历史',
    'plan.plus.storage': '10 GB 存储空间',
    'plan.plus.file': '单个文件最大 200 MB',
    'plan.plus.history': '12 个月版本历史',
    'plan.soon': '即将开放',
    'plan.subscribe': '订阅',
    'plan.loginFirst': '登录后订阅',
    'plan.current': '当前套餐',
    'plan.change': '在「管理订阅」中更改',
    'plan.appleManaged': '在 App Store 中管理',
    'plan.unavailable': '暂不可用',
    'plan.loading': '正在读取套餐…',
    'plan.configFailed': '暂时读不到套餐信息，请稍后刷新页面。',
    'plan.opening': '正在打开付款页面…',
    'plan.confirming': '付款完成，正在确认订阅…',
    'plan.active': '订阅已生效，现在可以在 HorseMD 里开启同步了。',
    'plan.pending': '付款已完成，订阅可能要再过一会儿才生效。请稍后刷新这个页面。',
    'plans.e2ee': '<strong>端到端加密。</strong>内容在你的设备上加密后才上传，同步服务看不到文件内容。加密密码只有你知道，丢了无法找回。',
    'err.invalid-email': '这个邮箱地址看起来不对，请检查一下。',
    'err.bad-request': '请求内容不完整，请检查后重试。',
    'err.rate-limited': '操作太频繁了，请过一会儿再试。',
    'err.rate-limited-s': '操作太频繁了，请 {s} 秒后再试。',
    'err.code-invalid': '验证码不对，请检查后重新输入。',
    'err.code-format': '请输入邮件里的 6 位数字验证码。',
    'err.code-expired': '验证码已过期，请重新发送一个。',
    'err.code-attempts': '输错次数太多，这个验证码已失效，请重新发送。',
    'err.unauthorized': '登录状态失效，请重新登录。',
    'err.refresh-invalid': '登录已过期，请重新登录。',
    'err.no-plan': '还没有生效中的订阅。',
    'err.over-quota': '已超出存储空间。',
    'err.billing-unavailable': '在线付款暂未开放。',
    'err.not-found': '还没有可以管理的订阅（还没在官网付过款）。',
    'err.server': '服务器出了点问题，请稍后再试。',
    'err.network': '连不上账号服务，请检查网络后重试。',
    'err.paddle': '付款页面没能打开，请检查网络或关闭拦截插件后重试。',
    'err.unknown': '出了点问题，请稍后再试。',
    '_title': '账号 — HorseMD',
    '_desc': '登录 HorseMD 账号，查看同步套餐、存储用量并管理订阅。',
  },
  en: {
    'nav.features': 'FEATURES', 'nav.guide': 'GUIDE', 'nav.account': 'ACCOUNT', 'nav.home': 'HOME', 'nav.privacy': 'PRIVACY',
    'acct.title': 'HorseMD Sync account',
    'acct.lead': 'Sign in with your email to see your plan and storage. No password needed.',
    'acct.loading': 'Loading your account…',
    'acct.loadFailed': 'Could not load your account.',
    'acct.retry': 'Try again',
    'api.banner': 'Using a test server: {url}',
    'api.reset': 'Back to the official server',
    'login.email': 'Email',
    'login.send': 'Send code',
    'login.resend': 'Send again',
    'login.sending': 'Sending…',
    'login.wait': 'Resend in {s}s',
    'login.code': 'Code',
    'login.verify': 'Sign in',
    'login.verifying': 'Signing in…',
    'login.change': 'Use another email',
    'login.sent': 'We sent a 6-digit code to {email}. It is valid for 10 minutes.',
    'login.expired': 'Your session has expired. Please sign in again.',
    'login.loggedOut': 'You are signed out.',
    'me.email': 'Email', 'me.plan': 'Plan', 'me.status': 'Status',
    'me.renews': 'Renews', 'me.ends': 'Ends',
    'me.storage': 'Storage', 'me.file': 'Max file size', 'me.history': 'Version history',
    'me.usage': '{used} of {total} used',
    'me.usageNoPlan': '{used} used',
    'me.measured': 'Measured {time}',
    'me.notMeasured': 'Not measured yet',
    'me.days': '{n} days',
    'me.none': '—',
    'me.manage': 'Manage subscription',
    'me.logout': 'Sign out',
    'me.opening': 'Opening…',
    'me.apple': 'This subscription was bought in the App Store. Manage it on your iPhone in Settings → Apple Account → Subscriptions.',
    'plan.none': 'No plan', 'plan.standard': 'Standard', 'plan.plus': 'Plus',
    'status.none': 'Not subscribed', 'status.active': 'Active', 'status.past_due': 'Payment failed', 'status.canceled': 'Canceled',
    'reason.noPlan': 'No subscription yet. Subscribe to sync across all your devices.',
    'reason.noPlanData': 'No active subscription: files already in the cloud can still be downloaded and deleted, but nothing new is uploaded (read-only).',
    'reason.overQuota': 'You are over your storage limit: sync is read-only for now (download and delete still work). Delete some files or upgrade to upload again.',
    'reason.pastDue': 'The last payment did not go through. Update your payment method under Manage subscription, or the subscription will stop.',
    'reason.canceled': 'Your subscription is canceled. Sync becomes read-only when it ends.',
    'plans.title': 'Sync plans',
    'plans.interval': 'Billing period',
    'plans.month': 'Monthly', 'plans.year': 'Yearly',
    'plans.perMonth': '{price} / month', 'plans.perYear': '{price} / year',
    'plan.standard.storage': '1 GB of storage',
    'plan.standard.file': 'Files up to 5 MB',
    'plan.standard.history': '1 month of version history',
    'plan.plus.storage': '10 GB of storage',
    'plan.plus.file': 'Files up to 200 MB',
    'plan.plus.history': '12 months of version history',
    'plan.soon': 'Coming soon',
    'plan.subscribe': 'Subscribe',
    'plan.loginFirst': 'Sign in to subscribe',
    'plan.current': 'Current plan',
    'plan.change': 'Change under Manage subscription',
    'plan.appleManaged': 'Managed in the App Store',
    'plan.unavailable': 'Not available',
    'plan.loading': 'Loading plans…',
    'plan.configFailed': 'Could not load the plans. Please refresh the page later.',
    'plan.opening': 'Opening checkout…',
    'plan.confirming': 'Payment received. Confirming your subscription…',
    'plan.active': 'Your subscription is active. You can now turn on sync in HorseMD.',
    'plan.pending': 'Payment received. The subscription may take a little longer to show up; please refresh this page shortly.',
    'plans.e2ee': '<strong>End-to-end encrypted.</strong> Your content is encrypted on your device before it is uploaded, so the sync service cannot read it. Only you know the encryption password, and a lost password cannot be recovered.',
    'err.invalid-email': 'That email address does not look right. Please check it.',
    'err.bad-request': 'Something is missing from the request. Please check and try again.',
    'err.rate-limited': 'Too many attempts. Please wait a moment and try again.',
    'err.rate-limited-s': 'Too many attempts. Please try again in {s} seconds.',
    'err.code-invalid': 'That code is not right. Please check it and try again.',
    'err.code-format': 'Enter the 6-digit code from the email.',
    'err.code-expired': 'That code has expired. Please send a new one.',
    'err.code-attempts': 'Too many wrong tries. This code no longer works; please send a new one.',
    'err.unauthorized': 'Your session is no longer valid. Please sign in again.',
    'err.refresh-invalid': 'Your session has expired. Please sign in again.',
    'err.no-plan': 'There is no active subscription.',
    'err.over-quota': 'You are over your storage limit.',
    'err.billing-unavailable': 'Online payment is not open yet.',
    'err.not-found': 'There is no subscription to manage yet (nothing was bought on this site).',
    'err.server': 'Something went wrong on the server. Please try again later.',
    'err.network': 'Cannot reach the account service. Check your connection and try again.',
    'err.paddle': 'The checkout could not open. Check your connection or disable blockers, then try again.',
    'err.unknown': 'Something went wrong. Please try again later.',
    '_title': 'Account — HorseMD',
    '_desc': 'Sign in to your HorseMD account to see your sync plan and storage, and manage your subscription.',
  },
}

// Storage can throw (private mode, blocked site data): never let it break the page.
function lsGet(key) { try { return localStorage.getItem(key) } catch { return null } }
function lsSet(key, value) { try { localStorage.setItem(key, value) } catch { /* ignore */ } }
function lsRemove(key) { try { localStorage.removeItem(key) } catch { /* ignore */ } }
function ssGet(key) { try { return sessionStorage.getItem(key) } catch { return null } }
function ssSet(key, value) { try { sessionStorage.setItem(key, value) } catch { /* ignore */ } }
function ssRemove(key) { try { sessionStorage.removeItem(key) } catch { /* ignore */ } }

const LANG_KEY = 'horsemd.site.lang'
let lang = lsGet(LANG_KEY)
if (lang !== 'zh' && lang !== 'en') {
  lang = navigator.language && navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function t(key, vars) {
  let s = I18N[lang][key]
  if (s == null) s = I18N.zh[key] != null ? I18N.zh[key] : key
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m))
  return s
}

function applyLang() {
  // Dictionary strings are ours (static), so innerHTML is safe here; anything from
  // the server or the user is written with textContent elsewhere.
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const v = I18N[lang][el.dataset.i18n]
    if (v != null) el.innerHTML = v
  })
  document.querySelectorAll('[data-i18n-aria]').forEach(el => {
    const v = I18N[lang][el.dataset.i18nAria]
    if (v != null) el.setAttribute('aria-label', v)
  })
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  document.title = t('_title')
  const meta = document.querySelector('meta[name="description"]')
  if (meta) meta.content = t('_desc')
  $('langToggle').textContent = lang === 'zh' ? 'EN' : '中文'
  lsSet(LANG_KEY, lang)
  renderAll()
}

function $(id) { return document.getElementById(id) }

/* ── API base ─────────────────────────────────────────────── */
// ?api=<url> points the page at another server (local testing). Only loopback,
// private-network and our own *.yangsir.net hosts are accepted, so a crafted link
// cannot send someone's login code to a stranger's server.
const DEFAULT_API = 'https://sync.yangsir.net'
const API_KEY = 'horsemd.account.api'

function cleanApi(raw) {
  let url
  try { url = new URL(raw) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  const h = url.hostname
  const loopback = h === 'localhost' || h === '127.0.0.1' || h === '[::1]'
  const privateNet = /^(10\.\d+|192\.168|172\.(1[6-9]|2\d|3[01])|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d+\.\d+$/.test(h)
  const ours = h === 'yangsir.net' || h.endsWith('.yangsir.net')
  if (!(loopback || privateNet || ours)) return null
  if (url.protocol === 'http:' && !(loopback || privateNet)) return null
  return url.origin + url.pathname.replace(/\/+$/, '')
}

function resolveApi() {
  let fromQuery = null
  try { fromQuery = new URL(location.href).searchParams.get('api') } catch { /* ignore */ }
  if (fromQuery) {
    const v = cleanApi(fromQuery)
    if (v) { ssSet(API_KEY, v); return v }
  }
  const remembered = ssGet(API_KEY)
  const v = remembered && cleanApi(remembered)
  return v || DEFAULT_API
}
const API = resolveApi()

/* ── Session: refresh token in localStorage, access token in memory ── */
const STORE_KEY = 'horsemd.account.v1'
let accessToken = null
let accessExp = 0
let memRefresh = null   // used when localStorage is unavailable

function readStore() {
  const raw = lsGet(STORE_KEY)
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    // A token belongs to the server that issued it; ignore one from another API base.
    if (v && v.api === API && typeof v.refreshToken === 'string') return v
  } catch { /* ignore */ }
  return null
}
function currentRefresh() {
  const s = readStore()
  return s ? s.refreshToken : memRefresh
}
function saveSession(data) {
  accessToken = data.accessToken
  accessExp = toMillis(data.accessExpiresAt) || 0
  memRefresh = data.refreshToken
  const email = data.user && data.user.email ? data.user.email : null
  lsSet(STORE_KEY, JSON.stringify({ api: API, refreshToken: data.refreshToken, email }))
}
function clearSession() {
  accessToken = null
  accessExp = 0
  memRefresh = null
  lsRemove(STORE_KEY)
}

/* ── HTTP ─────────────────────────────────────────────────── */
async function call(path, opts = {}) {
  const headers = {}
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.auth && accessToken) headers.Authorization = 'Bearer ' + accessToken
  let res
  try {
    res = await fetch(API + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'omit',
      cache: 'no-store',
    })
  } catch {
    return { ok: false, error: 'network' }
  }
  let data = null
  try { data = await res.json() } catch { /* non-JSON answer */ }
  if (!data || typeof data !== 'object') return { ok: false, error: 'server', status: res.status }
  if (!res.ok && data.ok !== false) return { ok: false, error: 'server', status: res.status }
  return data
}

// One refresh at a time across tabs: the server revokes a session when a rotated
// refresh token is used twice, so two tabs refreshing together would log both out.
let refreshing = null
function refresh() {
  if (!refreshing) {
    refreshing = withLock(doRefresh).finally(() => { refreshing = null })
  }
  return refreshing
}
function withLock(fn) {
  try {
    if (navigator.locks && navigator.locks.request) {
      return navigator.locks.request('horsemd-account-refresh', fn)
    }
  } catch { /* fall through */ }
  return fn()
}
async function doRefresh() {
  // Read inside the lock: another tab may have rotated the token a moment ago.
  const token = currentRefresh()
  if (!token) return { ok: false, error: 'refresh-invalid' }
  const r = await call('/v1/auth/refresh', { method: 'POST', body: { refreshToken: token } })
  if (r.ok && r.accessToken && r.refreshToken) {
    saveSession(r)
    return { ok: true }
  }
  // Only a definite "log in again" drops the session; a network blip keeps it.
  if (r.error === 'refresh-invalid') clearSession()
  return { ok: false, error: r.error || 'server' }
}

async function authed(path, opts = {}) {
  if (!accessToken || (accessExp && accessExp - Date.now() < 60 * 1000)) {
    const f = await refresh()
    if (!f.ok) return f
  }
  let r = await call(path, { ...opts, auth: true })
  if (!r.ok && r.error === 'unauthorized') {
    const f = await refresh()
    if (!f.ok) return f
    r = await call(path, { ...opts, auth: true })
  }
  return r
}

/* ── Helpers ──────────────────────────────────────────────── */
function toMillis(v) {
  if (v == null || v === '') return null
  let n
  if (typeof v === 'number') n = v
  else if (/^\d+$/.test(String(v))) n = Number(v)
  else n = Date.parse(v)
  if (!Number.isFinite(n)) return null
  return n < 1e12 ? n * 1000 : n   // seconds or milliseconds
}
function fmtDate(v, withTime) {
  const ms = toMillis(v)
  if (ms == null) return null
  const d = new Date(ms)
  const loc = lang === 'zh' ? 'zh-CN' : 'en-GB'
  const o = withTime
    ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: 'long', day: 'numeric' }
  try { return d.toLocaleString(loc, o) } catch { return d.toISOString().slice(0, 10) }
}
function fmtBytes(n) {
  n = Number(n)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  const s = i === 0 || n >= 100 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, '')
  return s + ' ' + units[i]
}
function errText(code, vars) {
  const key = 'err.' + code
  return I18N[lang][key] != null ? t(key, vars) : t('err.unknown')
}
function looksLikeEmail(s) {
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ── UI state ─────────────────────────────────────────────── */
// Messages are kept as keys so a language switch re-translates them.
const msgs = { email: null, code: null, action: null, global: null, plan: null }
let view = 'loading'           // loading | loadFailed | login | account
let loginStep = 'email'        // email | code
let pendingEmail = ''
let sendCooldownUntil = 0
let rateLimitUntil = 0
let cooldownTimer = null
let busy = { send: false, verify: false, portal: false }
let me = null
let billing = null             // null = loading, 'error', or the config
let interval = 'month'
const priceText = {}           // priceId → formatted amount from Paddle
let pendingPlan = null
let polling = false

function setMsg(slot, key, vars, isError) {
  msgs[slot] = key ? { key, vars, isError: !!isError } : null
  renderMsgs()
}
function setErr(slot, code, vars) {
  msgs[slot] = code ? { err: code, vars, isError: true } : null
  renderMsgs()
}
function msgString(m) {
  if (!m) return ''
  if (m.err) {
    if (m.err === 'rate-limited' && m.vars && m.vars.until) {
      const s = Math.max(1, Math.ceil((m.vars.until - Date.now()) / 1000))
      return Date.now() < m.vars.until ? t('err.rate-limited-s', { s }) : ''
    }
    return errText(m.err, m.vars)
  }
  return t(m.key, m.vars)
}
function renderMsgs() {
  const map = { email: 'emailErr', code: 'codeErr', action: 'actionErr', global: 'globalMsg', plan: 'planMsg' }
  for (const [slot, id] of Object.entries(map)) {
    const el = $(id)
    const m = msgs[slot]
    el.textContent = msgString(m)
    el.classList.toggle('is-error', !!(m && m.isError))
  }
  $('emailInput').setAttribute('aria-invalid', msgs.email && msgs.email.isError ? 'true' : 'false')
  $('codeInput').setAttribute('aria-invalid', msgs.code && msgs.code.isError ? 'true' : 'false')
}

function renderAll() {
  renderView()
  renderLogin()
  renderAccount()
  renderPlans()
  renderMsgs()
  renderBanner()
}

function renderBanner() {
  const on = API !== DEFAULT_API
  $('apiBanner').hidden = !on
  if (on) $('apiBannerText').textContent = t('api.banner', { url: API })
}

function renderView() {
  $('loadingView').hidden = !(view === 'loading' || view === 'loadFailed')
  $('loadingText').textContent = view === 'loadFailed' ? t('acct.loadFailed') : t('acct.loading')
  $('retryBtn').hidden = view !== 'loadFailed'
  $('loginView').hidden = view !== 'login'
  $('accountView').hidden = view !== 'account'
}

/* ── Login ────────────────────────────────────────────────── */
function renderLogin() {
  // The email row stays visible during the code step (read-only), so the address is in view.
  $('codeForm').hidden = loginStep !== 'code'
  $('emailInput').readOnly = loginStep === 'code'
  $('codeHint').textContent = loginStep === 'code' ? t('login.sent', { email: pendingEmail }) : ''
  renderSendBtn()
  const vb = $('verifyBtn')
  vb.disabled = busy.verify
  vb.textContent = busy.verify ? t('login.verifying') : t('login.verify')
}

function renderSendBtn() {
  const btn = $('sendBtn')
  const until = Math.max(sendCooldownUntil, rateLimitUntil)
  const left = Math.ceil((until - Date.now()) / 1000)
  if (busy.send) {
    btn.textContent = t('login.sending')
    btn.disabled = true
  } else if (left > 0) {
    btn.textContent = t('login.wait', { s: left })
    btn.disabled = true
  } else {
    btn.textContent = loginStep === 'code' ? t('login.resend') : t('login.send')
    btn.disabled = false
  }
}

function startCooldownTimer() {
  if (cooldownTimer) return
  cooldownTimer = setInterval(() => {
    renderSendBtn()
    if (msgs.email && msgs.email.err === 'rate-limited') renderMsgs()
    if (Date.now() >= Math.max(sendCooldownUntil, rateLimitUntil)) {
      clearInterval(cooldownTimer)
      cooldownTimer = null
      if (msgs.email && msgs.email.err === 'rate-limited') setErr('email', null)
    }
  }, 1000)
}

async function sendCode(e) {
  e.preventDefault()
  if (busy.send) return
  const email = $('emailInput').value.trim().toLowerCase()
  if (!looksLikeEmail(email)) {
    setErr('email', 'invalid-email')
    $('emailInput').focus()
    return
  }
  setErr('email', null)
  setMsg('global', null)
  busy.send = true
  renderSendBtn()
  const r = await call('/v1/auth/email/start', { method: 'POST', body: { email } })
  busy.send = false
  if (r.ok) {
    pendingEmail = email
    loginStep = 'code'
    // The server allows one code per 60 s; show it instead of letting the click fail.
    sendCooldownUntil = Date.now() + 60 * 1000
    startCooldownTimer()
    setErr('code', null)
    renderLogin()
    $('codeInput').value = ''
    $('codeInput').focus()
    return
  }
  if (r.error === 'rate-limited') {
    const secs = Number(r.retryAfter) > 0 ? Number(r.retryAfter) : 60
    rateLimitUntil = Date.now() + secs * 1000
    setErr('email', 'rate-limited', { until: rateLimitUntil })
    startCooldownTimer()
  } else {
    setErr('email', r.error || 'unknown')
  }
  renderSendBtn()
}

async function verifyCode(e) {
  if (e) e.preventDefault()
  if (busy.verify) return
  const code = $('codeInput').value.replace(/\D/g, '')
  if (code.length !== 6) {
    setErr('code', 'code-format')
    $('codeInput').focus()
    return
  }
  setErr('code', null)
  busy.verify = true
  renderLogin()
  const r = await call('/v1/auth/email/verify', {
    method: 'POST',
    body: { email: pendingEmail, code, device: '网页' },
  })
  busy.verify = false
  if (r.ok && r.accessToken && r.refreshToken) {
    saveSession(r)
    loginStep = 'email'
    $('codeInput').value = ''
    setErr('code', null)
    renderLogin()
    await loadMe()
    return
  }
  if (r.error === 'rate-limited' && Number(r.retryAfter) > 0) {
    setErr('code', 'rate-limited-s', { s: Math.ceil(Number(r.retryAfter)) })
  } else {
    setErr('code', r.error || 'unknown')
  }
  renderLogin()
  $('codeInput').focus()
  $('codeInput').select()
}

function changeEmail() {
  loginStep = 'email'
  pendingEmail = ''
  setErr('code', null)
  renderLogin()
  $('emailInput').focus()
}

function showLogin(noticeKey) {
  view = 'login'
  me = null
  loginStep = 'email'
  setMsg('global', noticeKey || null)
  renderAll()
}

/* ── Account ──────────────────────────────────────────────── */
async function loadMe() {
  view = me ? 'account' : 'loading'
  renderView()
  const r = await authed('/v1/me')
  if (r.ok && r.user && r.plan) {
    me = r
    view = 'account'
    setMsg('global', null)
    renderAll()
    return
  }
  if (r.error === 'refresh-invalid' || r.error === 'unauthorized') {
    clearSession()
    showLogin('login.expired')
    return
  }
  view = 'loadFailed'
  setErr('global', r.error || 'unknown')
  renderAll()
}

function renderAccount() {
  if (!me) return
  const plan = me.plan || {}
  const usage = me.usage || {}
  const storage = me.storage || {}
  const planId = plan.id || 'none'
  const status = plan.status || 'none'

  $('meEmail').textContent = me.user.email || ''
  $('mePlan').textContent = I18N[lang]['plan.' + planId] != null ? t('plan.' + planId) : planId
  $('meStatus').textContent = I18N[lang]['status.' + status] != null ? t('status.' + status) : status

  // An end date wins over a renewal date: a canceled plan shows when it stops.
  const ends = fmtDate(plan.endsAt)
  const renews = fmtDate(plan.renewsAt)
  $('meDateRow').hidden = !ends && !renews
  $('meDateLabel').textContent = ends ? t('me.ends') : t('me.renews')
  $('meDate').textContent = ends || renews || ''

  const used = Number(usage.bytes) || 0
  const total = Number(plan.storageBytes) || 0
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0
  const bar = $('meBar')
  bar.setAttribute('aria-valuenow', String(Math.round(pct)))
  bar.setAttribute('aria-label', t('me.storage'))
  bar.classList.toggle('is-over', total > 0 ? used >= total : used > 0)
  // Keep a sliver visible when something is stored, so "almost nothing" is not "nothing".
  $('meBarFill').style.width = (used > 0 && pct < 1 ? 1 : pct) + '%'
  const usageText = total > 0
    ? t('me.usage', { used: fmtBytes(used), total: fmtBytes(total) })
    : t('me.usageNoPlan', { used: fmtBytes(used) })
  $('meUsage').textContent = usageText
  bar.setAttribute('aria-valuetext', usageText)
  const measured = fmtDate(usage.measuredAt, true)
  $('meMeasured').textContent = measured ? t('me.measured', { time: measured }) : t('me.notMeasured')

  $('meFile').textContent = Number(plan.fileBytes) > 0 ? fmtBytes(plan.fileBytes) : t('me.none')
  $('meHistory').textContent = Number(plan.historyDays) > 0 ? t('me.days', { n: plan.historyDays }) : t('me.none')

  let noteKey = null
  if (storage.reason === 'over-quota') noteKey = 'reason.overQuota'
  else if (storage.reason === 'no-plan') noteKey = used > 0 ? 'reason.noPlanData' : 'reason.noPlan'
  else if (status === 'past_due') noteKey = 'reason.pastDue'
  else if (status === 'canceled' && ends) noteKey = 'reason.canceled'
  if (plan.source === 'apple') noteKey = noteKey ? noteKey : 'me.apple'
  const note = $('meNote')
  note.hidden = !noteKey
  note.textContent = noteKey ? t(noteKey) : ''
  note.classList.toggle('is-warn', storage.writable === false || status === 'past_due')

  const portal = $('portalBtn')
  portal.hidden = plan.source !== 'paddle'
  portal.disabled = busy.portal
  portal.textContent = busy.portal ? t('me.opening') : t('me.manage')
}

async function openPortal() {
  if (busy.portal) return
  busy.portal = true
  setErr('action', null)
  renderAccount()
  const r = await authed('/v1/billing/portal', { method: 'POST', body: {} })
  busy.portal = false
  renderAccount()
  if (r.ok && typeof r.url === 'string' && /^https:\/\//.test(r.url)) {
    location.assign(r.url)
    return
  }
  if (r.error === 'refresh-invalid') { clearSession(); showLogin('login.expired'); return }
  setErr('action', r.ok ? 'server' : (r.error || 'unknown'))
}

async function logout() {
  const token = currentRefresh()
  clearSession()
  showLogin('login.loggedOut')
  $('emailInput').focus()
  // Revoke on the server too; the local session is already gone either way.
  if (token) call('/v1/auth/logout', { method: 'POST', body: { refreshToken: token } })
}

/* ── Plans + Paddle ───────────────────────────────────────── */
function priceFor(plan, iv) {
  if (!billing || billing === 'error' || !billing.enabled || !Array.isArray(billing.prices)) return null
  return billing.prices.find(p => p && p.plan === plan && p.interval === iv && p.priceId) || null
}

function renderPlans() {
  document.querySelectorAll('.seg-btn').forEach(b => {
    b.setAttribute('aria-pressed', b.dataset.interval === interval ? 'true' : 'false')
  })
  const enabled = billing && billing !== 'error' && billing.enabled
  const plan = me && me.plan ? me.plan : null
  const subscribed = plan && (plan.status === 'active' || plan.status === 'past_due') && plan.id !== 'none'

  document.querySelectorAll('.plan').forEach(card => {
    const id = card.dataset.plan
    const price = priceFor(id, interval)
    const priceEl = card.querySelector('[data-price]')
    const btn = card.querySelector('[data-buy]')
    card.classList.toggle('is-current', !!(subscribed && plan.id === id))

    if (billing === null) priceEl.textContent = ' '
    else if (!enabled) priceEl.textContent = t('plan.soon')
    else if (price && priceText[price.priceId]) {
      priceEl.textContent = t(interval === 'year' ? 'plans.perYear' : 'plans.perMonth', { price: priceText[price.priceId] })
    } else priceEl.textContent = price ? ' ' : t('plan.unavailable')

    let label
    let disabled = false
    let action = null
    if (billing === null) { label = t('plan.loading'); disabled = true }
    else if (!enabled) { label = t('plan.soon'); disabled = true }
    else if (!price) { label = t('plan.unavailable'); disabled = true }
    else if (!me) { label = t('plan.loginFirst'); action = 'login' }
    else if (subscribed && plan.id === id) { label = t('plan.current'); disabled = true }
    else if (subscribed && plan.source === 'apple') { label = t('plan.appleManaged'); disabled = true }
    // A second checkout would create a second subscription; plan changes go through the portal.
    else if (subscribed && plan.source === 'paddle') { label = t('plan.change'); action = 'portal' }
    else if (subscribed) { label = t('plan.current'); disabled = true }
    else { label = t('plan.subscribe'); action = 'buy' }
    if (polling) disabled = true
    btn.textContent = label
    btn.disabled = disabled
    btn.dataset.action = action || ''
    btn.classList.toggle('btn-ghost', action !== 'buy' && action !== 'login')
  })
}

async function loadBilling() {
  const r = await call('/v1/billing/config')
  if (!r.ok) {
    billing = 'error'
    setMsg('plan', 'plan.configFailed', null, true)
  } else {
    billing = r
  }
  renderPlans()
  if (billing !== 'error' && billing.enabled && billing.clientToken) loadPrices()
}

let paddleReady = null
function loadPaddle() {
  if (paddleReady) return paddleReady
  const cfg = billing
  paddleReady = new Promise((resolve, reject) => {
    if (window.Paddle && window.Paddle.Initialized) { resolve(window.Paddle); return }
    const s = document.createElement('script')
    s.src = 'https://cdn.paddle.com/paddle/v2/paddle.js'
    s.async = true
    s.onload = () => {
      try {
        const P = window.Paddle
        if (cfg.environment === 'sandbox') P.Environment.set('sandbox')
        P.Initialize({ token: cfg.clientToken, eventCallback: onPaddleEvent })
        resolve(P)
      } catch (err) { reject(err) }
    }
    s.onerror = () => reject(new Error('paddle-load'))
    document.head.appendChild(s)
  })
  // Let a later click try again after a failed load (blocker, network).
  paddleReady.catch(() => { paddleReady = null })
  return paddleReady
}

// Localized amounts come from Paddle itself; without them the cards still work.
async function loadPrices() {
  try {
    const P = await loadPaddle()
    const items = billing.prices.filter(p => p && p.priceId).map(p => ({ priceId: p.priceId, quantity: 1 }))
    if (!items.length || typeof P.PricePreview !== 'function') return
    const res = await P.PricePreview({ items })
    const lines = (res && res.data && res.data.details && res.data.details.lineItems) || []
    for (const li of lines) {
      const id = li.price && li.price.id
      const ft = li.formattedTotals || {}
      if (id && (ft.total || ft.subtotal)) priceText[id] = ft.total || ft.subtotal
    }
    renderPlans()
  } catch { /* amounts are optional */ }
}

function onPaddleEvent(ev) {
  if (ev && ev.name === 'checkout.completed') confirmPurchase()
}

async function startCheckout(planId) {
  const price = priceFor(planId, interval)
  if (!price || !me) return
  setMsg('plan', 'plan.opening')
  try {
    const P = await loadPaddle()
    pendingPlan = planId
    P.Checkout.open({
      items: [{ priceId: price.priceId, quantity: 1 }],
      customer: { email: me.user.email },
      customData: { userId: me.user.id },
    })
    setMsg('plan', null)
  } catch {
    setErr('plan', 'paddle')
  }
}

// The webhook may land a few seconds after Paddle reports success: poll /v1/me.
async function confirmPurchase() {
  if (polling) return
  polling = true
  setMsg('plan', 'plan.confirming')
  renderPlans()
  const until = Date.now() + 30 * 1000
  let done = false
  while (Date.now() < until) {
    await sleep(2000)
    const r = await authed('/v1/me')
    if (r.ok && r.plan) {
      me = r
      if (r.plan.status === 'active' && (!pendingPlan || r.plan.id === pendingPlan)) { done = true; break }
    } else if (r.error === 'refresh-invalid') break
  }
  polling = false
  pendingPlan = null
  if (done) {
    try { window.Paddle.Checkout.close() } catch { /* overlay may be closed already */ }
    view = 'account'
    setMsg('plan', 'plan.active')
  } else {
    setMsg('plan', 'plan.pending')
  }
  renderAll()
}

function onPlanClick(e) {
  const btn = e.target.closest('[data-buy]')
  if (!btn || btn.disabled) return
  const action = btn.dataset.action
  if (action === 'buy') startCheckout(btn.dataset.buy)
  else if (action === 'portal') openPortal()
  else if (action === 'login') {
    $('top').scrollIntoView({ behavior: 'smooth', block: 'start' })
    const input = loginStep === 'code' ? $('codeInput') : $('emailInput')
    input.focus({ preventScroll: true })
  }
}

/* ── Wiring ───────────────────────────────────────────────── */
$('langToggle').addEventListener('click', () => {
  lang = lang === 'zh' ? 'en' : 'zh'
  applyLang()
})
$('emailForm').addEventListener('submit', sendCode)
$('codeForm').addEventListener('submit', verifyCode)
$('codeInput').addEventListener('input', () => {
  const el = $('codeInput')
  const digits = el.value.replace(/\D/g, '').slice(0, 6)
  if (digits !== el.value) el.value = digits
  if (msgs.code) setErr('code', null)
  // One-time-code autofill fills all six at once: sign in without another tap.
  if (digits.length === 6 && !busy.verify) verifyCode()
})
$('emailInput').addEventListener('input', () => { if (msgs.email && msgs.email.err !== 'rate-limited') setErr('email', null) })
$('changeEmail').addEventListener('click', changeEmail)
$('retryBtn').addEventListener('click', loadMe)
$('portalBtn').addEventListener('click', openPortal)
$('logoutBtn').addEventListener('click', logout)
$('apiReset').addEventListener('click', () => {
  ssRemove(API_KEY)
  location.replace(location.pathname)
})
document.querySelectorAll('.seg-btn').forEach(b => {
  b.addEventListener('click', () => { interval = b.dataset.interval; renderPlans() })
})
document.querySelector('.plan-grid').addEventListener('click', onPlanClick)

// Another tab signed out (or in): follow it instead of using a dead token.
window.addEventListener('storage', e => {
  if (e.key !== STORE_KEY) return
  if (!readStore() && view === 'account') {
    accessToken = null
    memRefresh = null
    showLogin('login.loggedOut')
  } else if (readStore() && view === 'login') {
    loadMe()
  }
})

/* ── Start ────────────────────────────────────────────────── */
const stored = readStore()
if (stored && stored.email) $('emailInput').value = stored.email
view = currentRefresh() ? 'loading' : 'login'
applyLang()
if (view === 'loading') loadMe()
loadBilling()
