// Cloud services for 云同步 › 添加连接 (rclone / Joplin / Remotely Save):
// the user picks a service and fills only what it needs; the rest (address,
// region, client id) comes from here. The sync itself only knows protocols —
// WebDAV and S3 — so every entry builds an ordinary connection config.
// Connections keep `provider` (the id) for display; an older connection is
// recognized by its address. Nothing here ever rewrites a saved connection:
// one that does not fit its service's form opens in the full form instead.
// Pure (tested by scripts/test-sync-providers.mjs); strings are i18n keys.

const trimSlash = (value) => String(value || '').trim().replace(/\/+$/, '')
const hostOf = (endpoint) => {
  try { return new URL(String(endpoint || '').trim()).hostname.toLowerCase() } catch { return '' }
}

export const QINIU_REGIONS = ['cn-east-1', 'cn-east-2', 'cn-north-1', 'cn-south-1', 'us-north-1', 'ap-southeast-1']

const JIANGUOYUN_ENDPOINT = 'https://dav.jianguoyun.com/dav/'
const CSTCLOUD_ENDPOINT = 'https://s3.cstcloud.cn'
const CSTCLOUD_REGION = 'us-east-1'

// Field ids the forms know: `name` is added to every form.
//   text fields: username, password (secret), bucket, accessKeyId,
//   secretAccessKey (secret), accountId, server, client, endpoint, region,
//   userAgent; `qiniuRegion` is a select over QINIU_REGIONS.
export const SYNC_PROVIDERS = [
  {
    id: 'jianguoyun',
    type: 'webdav',
    fields: ['username', 'password'],
    link: 'https://www.jianguoyun.com/#/safety',
    steps: 3,
    build: (v) => ({ endpoint: JIANGUOYUN_ENDPOINT, username: String(v.username || '').trim(), password: v.password, userAgent: '' }),
    parse: (c) => (trimSlash(c.endpoint) === trimSlash(JIANGUOYUN_ENDPOINT) && !c.userAgent ? { username: c.username || '' } : null),
    matches: (c) => hostOf(c.endpoint) === 'dav.jianguoyun.com'
  },
  {
    id: 'cstcloud',
    type: 's3',
    fields: ['bucket', 'accessKeyId', 'secretAccessKey', 'client'],
    defaults: { client: 'rclone' },
    steps: 3,
    build: (v) => ({
      endpoint: CSTCLOUD_ENDPOINT,
      region: CSTCLOUD_REGION,
      bucket: String(v.bucket || '').trim(),
      accessKeyId: String(v.accessKeyId || '').trim(),
      secretAccessKey: v.secretAccessKey,
      userAgent: String(v.client || '').trim()
    }),
    parse: (c) => (trimSlash(c.endpoint) === CSTCLOUD_ENDPOINT && c.region === CSTCLOUD_REGION
      ? { bucket: c.bucket || '', accessKeyId: c.accessKeyId || '', client: c.userAgent || '' }
      : null),
    matches: (c) => hostOf(c.endpoint) === 's3.cstcloud.cn'
  },
  {
    id: 'qiniu',
    type: 's3',
    fields: ['qiniuRegion', 'bucket', 'accessKeyId', 'secretAccessKey'],
    defaults: { qiniuRegion: 'cn-east-1' },
    link: 'https://portal.qiniu.com/developer/user/key',
    steps: 3,
    build: (v) => {
      const region = QINIU_REGIONS.includes(v.qiniuRegion) ? v.qiniuRegion : QINIU_REGIONS[0]
      return {
        endpoint: `https://s3.${region}.qiniucs.com`,
        region,
        bucket: String(v.bucket || '').trim(),
        accessKeyId: String(v.accessKeyId || '').trim(),
        secretAccessKey: v.secretAccessKey,
        userAgent: ''
      }
    },
    parse: (c) => {
      const match = /^https:\/\/s3\.([a-z0-9-]+)\.qiniucs\.com$/.exec(trimSlash(c.endpoint))
      if (!match || match[1] !== c.region || !QINIU_REGIONS.includes(c.region) || c.userAgent) return null
      return { qiniuRegion: c.region, bucket: c.bucket || '', accessKeyId: c.accessKeyId || '' }
    },
    matches: (c) => /\.qiniucs\.com$/.test(hostOf(c.endpoint))
  },
  {
    id: 'r2',
    type: 's3',
    fields: ['accountId', 'bucket', 'accessKeyId', 'secretAccessKey'],
    link: 'https://dash.cloudflare.com/?to=/:account/r2/api-tokens',
    steps: 3,
    build: (v) => ({
      endpoint: `https://${String(v.accountId || '').trim().toLowerCase()}.r2.cloudflarestorage.com`,
      region: 'auto',
      bucket: String(v.bucket || '').trim(),
      accessKeyId: String(v.accessKeyId || '').trim(),
      secretAccessKey: v.secretAccessKey,
      userAgent: ''
    }),
    parse: (c) => {
      const match = /^https:\/\/([a-z0-9]+)\.r2\.cloudflarestorage\.com$/.exec(trimSlash(c.endpoint))
      if (!match || c.region !== 'auto' || c.userAgent) return null
      return { accountId: match[1], bucket: c.bucket || '', accessKeyId: c.accessKeyId || '' }
    },
    matches: (c) => /\.r2\.cloudflarestorage\.com$/.test(hostOf(c.endpoint))
  },
  {
    id: 'nextcloud',
    type: 'webdav',
    fields: ['server', 'username', 'password'],
    steps: 3,
    build: (v) => {
      const username = String(v.username || '').trim()
      return {
        endpoint: `${trimSlash(v.server)}/remote.php/dav/files/${encodeURIComponent(username)}/`,
        username,
        password: v.password,
        userAgent: ''
      }
    },
    parse: (c) => {
      const match = /^(https?:\/\/.+)\/remote\.php\/dav\/files\/([^/]+)$/.exec(trimSlash(c.endpoint))
      if (!match || c.userAgent) return null
      let user = match[2]
      try { user = decodeURIComponent(user) } catch { return null }
      if (user !== (c.username || '')) return null
      return { server: match[1], username: c.username || '' }
    },
    matches: (c) => /\/remote\.php\/dav\/files\//.test(String(c.endpoint || ''))
  },
  // The full forms: any WebDAV (群晖 / 威联通 NAS, ownCloud…) or S3-compatible
  // service (AWS, MinIO, Backblaze B2…).
  { id: 'webdav', type: 'webdav', generic: true, icon: 'cloud' },
  { id: 's3', type: 's3', generic: true, icon: 'cloud' }
]

export const providerById = (id) => SYNC_PROVIDERS.find((item) => item.id === id) || null

// The service a saved connection belongs to (for its card and its edit
// form). A saved id wins; otherwise the address decides; otherwise the
// protocol's full form.
export function providerOfConnection(connection) {
  if (!connection) return null
  // A saved service counts while the address still belongs to it (the full
  // form may have pointed the connection elsewhere since).
  const saved = providerById(connection.provider)
  if (saved && saved.type === connection.type && (saved.generic || saved.matches(connection))) return saved
  const matched = SYNC_PROVIDERS.find((item) => !item.generic && item.type === connection.type && item.matches(connection))
  return matched || providerById(connection.type)
}

// The values for a service's own form, or null: the saved connection uses
// settings that form cannot show (another region, a custom client id…), so
// it is edited in the full form — never silently changed.
export function providerFormValues(provider, connection) {
  if (!provider || provider.generic || !connection) return null
  try {
    return provider.parse(connection)
  } catch {
    return null
  }
}

// The connection config the main process stores (addWebDav / addS3 /
// update) for a service form.
export function buildProviderConnection(provider, values) {
  const name = String(values.name || '').trim()
  if (provider.generic) return { ...values, name, provider: '' }
  return { ...provider.build({ ...(provider.defaults || {}), ...values }), name, provider: provider.id }
}
