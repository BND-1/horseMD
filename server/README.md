# HorseMD 同步账号服务

HorseMD 官方同步的账号服务。接口约定见 [`docs/official-sync-api.md`](../docs/official-sync-api.md)，设计原因见 [`docs/official-sync-design.md`](../docs/official-sync-design.md) §2–§5。

它只管这几件事：
- 邮箱 + 6 位验证码登录，发访问令牌（1 小时）和刷新令牌（180 天，每次续期都换新）；
- 套餐和订阅状态（Paddle 回调、手动开通）；
- 统计每个用户在对象存储里的用量；
- 用 STS 签发 1 小时的临时凭证，只能读写 `users/<用户 id>/`。

文件内容不经过这里：App 拿临时凭证直接读写对象存储，内容在本机先加密。

只用 Node 22 自带的模块（`node:http`、`node:sqlite`、`node:crypto`）和仓库里已有的 `@smithy/signature-v4`、`@aws-crypto/sha256-js`，没有新依赖。

## 文件

| 文件 | 作用 |
|---|---|
| `index.mjs` | 入口：读环境变量、启动、每小时统计用量、收到 SIGTERM / SIGINT 时停下 |
| `app.mjs` | `createApp({ db, config, mailer, storage, billing, now })`，返回请求处理函数（测试可以传假的存储、邮件和时钟） |
| `db.mjs` | SQLite（WAL），启动时建表；`schema_version` 表留给以后迁移 |
| `tokens.mjs` | 访问令牌签名 / 校验、刷新令牌、验证码、常数时间比较 |
| `plans.mjs` | 套餐额度和「能不能写」的规则 |
| `mailer.mjs` | `log`（开发用，验证码写进日志）和 `resend` |
| `storage.mjs` | STS AssumeRole、ListObjectsV2 统计用量 |
| `billing.mjs` | Paddle：回调验签、订阅事件、客户门户 |
| `admin.mjs` | 命令行：手动开通 / 取消套餐、查看用户 |

## 环境变量

| 变量 | 说明 |
|---|---|
| `HM_ACCOUNT_SECRET` | **必填**，至少 32 个字符，用来签访问令牌和验证码哈希。生成：`openssl rand -base64 48`。换掉它，所有人的访问令牌立刻失效（刷新令牌不受影响） |
| `HM_ACCOUNT_PORT` / `HM_ACCOUNT_HOST` | 监听端口和地址，默认 `8790` / `127.0.0.1` |
| `HM_ACCOUNT_DB` | SQLite 文件，默认 `./data/account.db`（相对当前目录） |
| `HM_ACCOUNT_ORIGINS` | 允许跨域的网站，逗号分隔，默认 `https://horsemd.yangsir.net`；`http://localhost:*`、`http://127.0.0.1:*` 总是允许 |
| `HM_TRUST_PROXY` | 设为 `1` 时，按 `X-Forwarded-For` 的第一个地址做 IP 限流（只在反向代理后面开） |
| `HM_STORAGE_ENDPOINT`、`HM_STORAGE_REGION`、`HM_STORAGE_BUCKET` | 对象存储；区域默认 `us-east-1` |
| `HM_STORAGE_PUBLIC_ENDPOINT` | 发给 App 的地址，默认同 `HM_STORAGE_ENDPOINT` |
| `HM_STORAGE_ACCESS_KEY`、`HM_STORAGE_SECRET_KEY` | 管理密钥（统计用量 + 调 STS） |
| `HM_STORAGE_STS_ENDPOINT` | STS 地址，默认同存储地址（MinIO 就是这样） |
| `HM_STORAGE_ROLE_ARN` | AssumeRole 的 RoleArn；不填就不传（MinIO 不需要） |
| `HM_MAIL` | `log`（默认）或 `resend` |
| `HM_MAIL_LOG` | `log` 模式下验证码写到这个文件（每行一个 JSON：`{ email, code, at }`）；不填就打印到控制台 |
| `HM_RESEND_KEY`、`HM_MAIL_FROM` | Resend 的 API 密钥和发件人（如 `HorseMD <login@horsemd.yangsir.net>`） |
| `HM_PADDLE_ENV` | `sandbox` 用沙盒，其他值都是正式环境 |
| `HM_PADDLE_API_KEY`、`HM_PADDLE_CLIENT_TOKEN`、`HM_PADDLE_WEBHOOK_SECRET` | Paddle 密钥 |
| `HM_PADDLE_PRICES` | 价格对应的套餐：`standard:month:pri_…,standard:year:pri_…,plus:month:pri_…` |

密钥只从环境变量来，不要写进仓库里的任何文件。四个 Paddle 变量（API 密钥、客户端令牌、回调密钥、价格）都有才算开通付款，否则 `/v1/billing/config` 回答 `enabled: false`。

不配存储也能启动：登录、`/v1/me`、付款照常，`/v1/storage/credentials` 回答 `server`。

## 本地运行（接 MinIO）

```bash
# 1. 起一个 MinIO（Homebrew：brew install minio/stable/minio minio/stable/mc）
mkdir -p /tmp/hm-minio
MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin minio server /tmp/hm-minio --address 127.0.0.1:9000

# 2. 建桶
mc alias set hmlocal http://127.0.0.1:9000 minioadmin minioadmin
mc mb hmlocal/horsemd-sync

# 3. 启动账号服务（在仓库根目录）
export HM_ACCOUNT_SECRET="$(openssl rand -base64 48)"
export HM_STORAGE_ENDPOINT=http://127.0.0.1:9000
export HM_STORAGE_BUCKET=horsemd-sync
export HM_STORAGE_ACCESS_KEY=minioadmin
export HM_STORAGE_SECRET_KEY=minioadmin
export HM_MAIL_LOG=/tmp/hm-mail.jsonl
npm run account:dev
```

如果 MinIO 不让 root 密钥调 AssumeRole，就建一个普通用户代替：

```bash
mc admin user add hmlocal hm-account <一个长密码>
mc admin policy attach hmlocal readwrite --user hm-account
```

然后把 `HM_STORAGE_ACCESS_KEY` / `HM_STORAGE_SECRET_KEY` 换成它。临时凭证的权限是「这个用户的权限 ∩ 会话策略」，所以它要有这个桶的读写和列目录权限。

登录试一下：

```bash
curl -s localhost:8790/v1/auth/email/start -H 'content-type: application/json' -d '{"email":"me@example.com"}'
tail -n1 /tmp/hm-mail.jsonl     # 验证码在这里
curl -s localhost:8790/v1/auth/email/verify -H 'content-type: application/json' \
  -d '{"email":"me@example.com","code":"123456","device":"curl"}'
curl -s localhost:8790/v1/me -H "authorization: Bearer <accessToken>"
```

## 手动开通套餐（还没接付款、或者给测试账号用）

```bash
node server/admin.mjs grant me@example.com standard        # 一直有效
node server/admin.mjs grant me@example.com plus 30         # 30 天后到期
node server/admin.mjs show me@example.com
node server/admin.mjs revoke me@example.com                # 回到无套餐：已存的数据只读
```

`HM_ACCOUNT_DB` 要和服务用的是同一个文件。用户不存在时 `grant` 会先建用户（来源记为 `manual`），之后他用这个邮箱登录就是这个账号。服务可以一直开着，下一次请求就看到新套餐。

## 规则摘要

- 套餐：`standard` 1 GiB / 单文件 5 MiB / 历史 30 天；`plus` 10 GiB / 200 MiB / 365 天。
- `past_due`（Paddle 还在重试扣款）算有效；`canceled` 到 `endsAt` 前有效；`paused`、过期都算没有套餐。
- 没有套餐：云端什么都没存 → `no-plan`（402）；存过东西 → 只读凭证（能下载、能删除，不能上传）。
- 用量 ≥ 套餐空间 → 只读，`reason: 'over-quota'`。用量在申请凭证时最多 10 分钟统计一次，另外每小时全量扫一遍。
- Paddle 回调按 `event_id` 去重；同一个订阅的旧事件晚到时不会覆盖新状态（按 `occurred_at`）。
