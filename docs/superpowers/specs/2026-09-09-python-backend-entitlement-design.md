# Python 后端与兑换权益改造设计

## 1. 背景与目标

当前项目由 React/Vite 前端、Express/TypeScript API 和 Capacitor Android WebView 组成。现有后端把支付订单同时作为访问凭证、一次生图权益、任务幂等状态和分享授权的载体，导致支付领域模型与产品实际需求耦合。项目现在只需要兑换码兑换，不再需要支付接口。

本次改造目标：

- 仅将后端运行时从 Node.js/Express 迁移到 Python/FastAPI。
- 保留 React/Vite 前端、Capacitor Android、摄像头调用和现有视觉流程。
- 将游客入口改为“兑换码 -> 拍照 -> 选择经典或 Agent -> 生图 -> 分享”。
- 删除微信支付、模拟支付、订单、退款、价格和支付对账功能。
- 用独立的兑换码、体验权益和生图任务模型替代支付订单模型。
- 保留经典生图、Agent 生图、管理员背景分析发布、风格管理、分享、后台账号权限和审计。
- 生产运行使用 MySQL 持久化，后端通过 HTTP 对外提供 API；不把 HTTPS 作为本次部署前置条件。

本次不改为 Python 服务端模板，不重写 Android 原生容器，也不把摄像头调用迁移到服务器。

## 2. 范围与非目标

### 2.1 包含范围

- Python API 服务和配置加载。
- MySQL 数据访问、迁移和旧数据导入。
- 后台兑换码批量生成、一次性兑换和状态管理。
- 体验权益令牌鉴权。
- 经典和 Agent 生图任务、幂等、资产保存和错误状态。
- AI Provider 和视觉分析适配。
- 分享页面、图片访问和下载。
- 管理员登录、会话、CSRF、角色权限、风格/背景管理和审计。
- 前端游客兑换流程和 API 请求适配。
- 后台删除支付相关菜单和统计。
- Python 单元测试、API 集成测试和前端流程回归。

### 2.2 不包含范围

- 不迁移微信 Native 支付、支付回调、查单、对账和退款。
- 不保留新的价格版本管理能力。
- 不把前端改成 Jinja、HTMX 或桌面 Python UI。
- 不在本次改造中引入 Redis、消息队列或对象存储。
- 不在游客请求中重新执行背景视觉分析。
- 不扩展 Agent 为多背景、多结果或多次扣减权益。

## 3. 设计原则

### 3.1 领域模型独立

兑换码、体验权益、生图任务、生成资产和分享记录分别建模。访问令牌只属于体验权益；生图任务只属于体验权益；分享只引用服务端资产。

### 3.2 API 契约优先

保留前端当前使用的主要 `/api` 路径，替换鉴权头和请求体中与支付相关的命名。删除的支付路径不提供兼容实现，避免新旧业务概念继续混用。

### 3.3 服务端控制

风格提示词、Agent 预分析提示词、背景文件路径和生成供应商配置只由服务端读取。浏览器只提交允许的 ID、体验会话 ID、生成任务 ID 和照片文件。

### 3.4 持久化优先

生产环境的兑换、权益、任务、资产、分享、管理员会话和审计记录写入 MySQL。内存状态只用于同一进程内的短期请求协调，不作为正确性依据。

### 3.5 敏感数据最小化

数据库只保存访问令牌 SHA-256 哈希，不保存明文令牌。日志不记录原始照片、Base64、动态提示词、供应商响应体、令牌或密钥。

## 4. 总体架构

### 4.1 运行时

```text
Android Capacitor WebView / Desktop Browser
             |
             | HTTP /api
             v
Python FastAPI + Uvicorn
  ├── API routers
  ├── Domain services
  ├── SQLAlchemy repositories
  ├── Provider adapters
  ├── Asset storage
  └── Background maintenance
             |
             +── MySQL
             +── local asset directory
             +── AI provider / vision provider
```

浏览器开发环境继续由 Vite 托管前端并代理 `/api`。生产或 Android 环境由独立公网 Python 服务提供 `/api`，前端通过同源地址或 `VITE_API_BASE_URL` 访问。

### 4.2 Python 目录

```text
backend/
  app/
    main.py
    config.py
    dependencies.py
    api/
      health.py
      catalog.py
      entitlements.py
      generation.py
      shares.py
      admin.py
    domain/
      entitlement_service.py
      generation_service.py
      catalog_service.py
      share_service.py
      admin_service.py
    db/
      base.py
      models.py
      session.py
      migrations/
    repositories/
      entitlement_repository.py
      generation_repository.py
      catalog_repository.py
      share_repository.py
      admin_repository.py
    providers/
      base.py
      mock.py
      gpt_image.py
      seedream.py
      jimeng.py
      gemini.py
    vision/
      analyze.py
    storage/
      assets.py
    security/
      tokens.py
      admin_auth.py
    logging/
      json_logger.py
  tests/
  pyproject.toml
```

Provider、领域服务和 repository 通过 Python 类型协议或抽象基类隔离。API 路由只负责请求解析、依赖注入、状态码和响应格式，不直接拼接供应商请求或执行复杂 SQL。

## 5. 数据模型

### 5.1 `redeem_codes`

保留现有兑换码的核心语义：

```text
id
code_hash
code_prefix
status: available | reserved | redeemed | disabled
session_id
reserved_at
redeemed_at
expires_at
created_at
```

不再使用 `order_id` 字段。兑换码的消费结果通过 `entitlements.redeem_code_id` 关联。

### 5.2 `entitlements`

新增体验权益表：

```text
id CHAR(36) PRIMARY KEY
redeem_code_id CHAR(36) UNIQUE NOT NULL
session_id VARCHAR(100) NOT NULL
token_hash CHAR(64) UNIQUE NOT NULL
status ENUM('active','consumed','expired','revoked') NOT NULL
max_styles INT NOT NULL
expires_at DATETIME NOT NULL
generation_id CHAR(36) NULL UNIQUE
created_at DATETIME NOT NULL
consumed_at DATETIME NULL
```

`token_hash` 用于常量时间比较。兑换接口只在成功响应中返回一次明文 `accessToken`。权益是否已经绑定任务由 `generation_id` 和任务状态共同决定。

### 5.3 `generation_jobs`

将 `order_id` 替换为 `entitlement_id`：

```text
id CHAR(36) PRIMARY KEY
entitlement_id CHAR(36) NOT NULL UNIQUE
session_id VARCHAR(100) NOT NULL
mode ENUM('classic','agent') NOT NULL
scene_id VARCHAR(80) NULL
background_id VARCHAR(80) NULL
request_hash CHAR(64) NOT NULL
status ENUM('queued','processing','succeeded','failed','uncertain','cancelled') NOT NULL
source_path VARCHAR(500) NULL
source_expires_at DATETIME NULL
error_code VARCHAR(80) NULL
attempts INT NOT NULL DEFAULT 0
started_at DATETIME NULL
completed_at DATETIME NULL
created_at DATETIME NOT NULL
updated_at DATETIME NOT NULL
```

动态 Agent prompt 不写入数据库。它只存在于当前请求的内存和成功响应中，既不进入日志，也不进入后台接口。服务重启后，任务重放仍可恢复已保存的资产，但不返回历史 prompt；前端只在本次请求成功且响应携带 prompt 时显示调试内容。

### 5.4 `generation_styles`

保留经典模式明细，与 `generation_jobs` 一对多关联：

```text
generation_id
style_id
style_version
status
output_path
output_expires_at
attempts
error_code
started_at
completed_at
```

### 5.5 其他表

保留并迁移：

- `style_versions`
- `background_versions`
- `assets`
- `shares`
- `admin_users`
- `admin_sessions`
- `audit_logs`

删除新业务依赖：

- `orders`
- `refund_requests`
- `payment_notifications`
- `pricing_versions`
- `approval_requests` 中仅服务于退款和价格发布的类型

风格发布和背景发布继续保留审批/权限约束；若 `approval_requests` 当前仅用于支付相关流程，应在迁移脚本中拆分或删除无用类型，不影响风格和背景发布。

## 6. 兑换流程

### 6.1 游客兑换

请求：

```http
POST /api/entitlements/redeem
Content-Type: application/json
```

```json
{
  "code": "ABCD2345",
  "sessionId": "uuid"
}
```

事务步骤：

1. 校验兑换码格式和会话 UUID。
2. `SELECT ... FOR UPDATE` 锁定兑换码。
3. 检查状态、有效期和是否被禁用。
4. 创建 `entitlements` 记录，生成高熵随机令牌并只保存哈希。
5. 将兑换码标记为 `redeemed`，写入会话和兑换时间。
6. 提交事务。
7. 返回权益摘要和明文访问令牌。

并发请求只能有一个事务成功；失败事务必须回滚权益创建和兑换码状态。

响应：

```json
{
  "entitlement": {
    "code": "ABCD2345",
    "status": "used",
    "maxStyles": 4,
    "expiresAt": "2026-09-10T12:00:00.000Z",
    "sessionId": "uuid"
  },
  "accessToken": "server-issued-token"
}
```

### 6.2 后台生成兑换码

兑换码只由管理员在后台生成，不提供给其他小程序或外部系统领取兑换码的接口。后台继续使用受权限保护的批量生成接口：

```http
POST /api/admin/redeem-codes/generate
Content-Type: application/json
```

```json
{
  "count": 50,
  "expiresAt": "2026-10-01T00:00:00.000Z"
}
```

接口只在管理员响应中返回新生成的明文兑换码；数据库保存兑换码哈希、前缀、状态、有效期和审计信息。兑换码明文由后台操作员立即复制保存，后续游客通过 `POST /api/entitlements/redeem` 手工输入使用。

## 7. 生图授权与幂等

### 7.1 鉴权头

所有需要权益的接口改用：

```http
X-Entitlement-Token: <access-token>
```

兼容期不接受 `X-Payment-Token`，避免支付命名残留继续进入 Python 服务。

### 7.2 权益绑定任务

服务端以事务锁定权益记录：

1. 按 `sessionId + tokenHash` 查找有效权益。
2. 若无任务，按请求指纹创建唯一 `generation_jobs`。
3. 若已有相同 `generationId` 且请求指纹一致，按任务状态返回处理中或恢复结果。
4. 若已有不同任务，返回 `GENERATION_ALREADY_CONSUMED`。
5. 若同任务指纹不一致，返回 `GENERATION_REQUEST_MISMATCH`。

经典模式最多使用 `maxStyles` 个已发布风格，Agent 模式固定一个已发布背景并生成一个结果。一次权益只允许选择一种模式完成一次任务。

### 7.3 请求格式

经典和 Agent 生图都改为 `multipart/form-data`，照片字段名为 `photo`，其他字段为普通表单字段：

```text
sessionId
generationId
sceneId / backgroundId
styles: JSON array string, classic only
photo: JPEG/PNG/WebP
```

服务端使用流式上传或受限临时文件接收照片，限制总大小，校验文件头、MIME、像素尺寸和解码结果。不得信任客户端声明的 `Content-Type`。

## 8. AI Provider 与 Agent

### 8.1 Provider 接口

统一接口至少包含：

```python
async def generate(photo: ImageInput, style: StyleDefinition) -> GeneratedAsset
async def compose(
    photo: ImageInput,
    background: ImageInput,
    prompt: str,
    background_id: str,
) -> GeneratedAsset
```

Provider 选择只发生在配置和依赖注入层。路由不根据 provider 名称分支。

### 8.2 经典模式

- 从数据库读取已发布风格和服务端提示词。
- 服务端拼接人物保真、场景和质量约束。
- 使用单槽并发控制保护上游供应商。
- 成功结果写入 `assets` 和 `generation_styles`。

### 8.3 Agent 模式

- 游客只提交 `backgroundId`。
- 服务端只允许已发布、启用、`analysis_status=ready` 的栅格背景。
- 读取预分析结果，不在每个游客请求重复调用视觉模型。
- 按服务端规则生成最终提示词。
- 仅调用支持双图合成的 Provider。
- 结果写入 `assets`，任务状态写入 `generation_jobs`。

### 8.4 错误和超时

统一错误码：

```text
INVALID_INPUT
CONFIG_ERROR
UPSTREAM_AUTH
UPSTREAM_RATE_LIMIT
UPSTREAM_TIMEOUT
UPSTREAM_BAD_RESPONSE
GENERATION_IN_PROGRESS
GENERATION_ALREADY_CONSUMED
GENERATION_REQUEST_MISMATCH
GENERATION_FAILED
```

对外返回中文消息和 `retryable`，日志只记录错误类别、供应商、任务 ID 和耗时，不记录上游原文。

## 9. 分享与资源存储

- 生图结果始终保存到服务端资产目录或后续替换的对象存储。
- `/api/shares` 只接受当前 `sessionId` 所拥有且未过期的 `assetId`。
- 分享记录保存资产引用和过期时间，不接受客户端 `imageUrl` 或 Data URL。
- 分享页面、图片访问和下载路径保持现有功能。
- 后台维护任务定期删除过期分享、过期资产和孤立元数据。
- 图片只接受 JPEG、PNG、WebP；SVG 不作为真实生图或分享资产格式。

## 10. 管理后台调整

### 10.1 删除

删除导航、组件、接口和统计：

- 订单与支付。
- 待支付/已支付/支付失败统计。
- 价格管理。
- 退款申请。
- 微信支付健康信息和交易号。

### 10.2 保留和改名

- “兑换码”保留，支持生成、有效期和状态查看。
- 删除小程序 token 生成、领取和相关审计功能。
- “生图任务”显示 `generationId`、`entitlementId`、`sessionId`、模式、状态、错误码和时间。
- 概览改为兑换码总量、已兑换权益、今日生图、成功率、失败任务和当前 Provider。
- 健康页保留数据库、存储、Provider、视觉模型和任务状态检查。
- 管理员登录、会话、CSRF、角色权限和审计继续保留。

## 11. 前端适配

### 11.1 游客流程

将入口改为：

```text
welcome -> redeem -> camera -> review -> mode -> styles/backgrounds
         -> generating -> results -> download
```

删除 `payment` 阶段以及支付页的订单创建、二维码、倒计时、模拟支付和支付轮询。

### 11.2 类型和服务

- `paymentOrder` 从 `KioskSession` 删除。
- `paymentToken` 重命名为 `entitlementToken`。
- 删除 `PaymentOrder` 和 `PaymentService`。
- 生图和分享服务参数改用 `entitlementToken`。
- HTTP 请求头改为 `X-Entitlement-Token`。
- 经典和 Agent 服务使用 `FormData` 发送照片文件。
- 兑换失败、过期、已使用和服务不可用状态继续在兑换页显示。
- 保留摄像头失败时的示例图回退。

### 11.3 Mock 模式

浏览器离线 mock 继续可用，但 mock 兑换服务的状态和字段必须与真实 Python API 一致。不能让 mock 路径继续依赖支付订单概念。

## 12. 配置和启动

Python 配置使用环境变量，命名尽量沿用现有 AI、视觉、数据库、存储和管理员配置：

```dotenv
APP_ENV=development
API_HOST=0.0.0.0
API_PORT=8787
MYSQL_ENABLED=true
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=aiaimage
MYSQL_USER=root
MYSQL_PASSWORD=...
AI_PROVIDER=mock
AI_REQUEST_TIMEOUT_MS=120000
AI_MAX_INPUT_BYTES=10485760
ENTITLEMENT_TTL_HOURS=24
MAX_STYLES=4
SHARE_EXPIRY_HOURS=24
ADMIN_TOKEN=...
ADMIN_SESSION_SECRET=...
```

Python 项目使用 `pyproject.toml` 固定依赖版本。建议命令：

```text
python -m venv .venv
python -m pip install -e ".[dev]"
python -m alembic upgrade head
python -m uvicorn app.main:app --host 0.0.0.0 --port 8787
pytest
```

前端开发命令继续使用 Vite；`npm run dev:api` 改为启动 Python API，或新增 `python:dev` 供开发者直接运行。

## 13. 数据迁移

### 13.1 新数据库

提供 Alembic 初始迁移，直接创建兑换、权益、任务、风格、背景、资产、分享和后台相关表。支付专用表不创建。

### 13.2 现有数据库

提供一次性命令：

```text
python -m app.cli migrate-legacy
```

迁移规则：

- 管理员、风格、背景、资产、分享和审计数据保留。
- 已成功兑换的 `voucher` 订单转换为已消费或已绑定的 entitlement。
- 可恢复的历史兑换码按现有哈希导入；小程序 token 记录不迁移到新业务。
- 微信支付订单、退款、支付通知和价格版本不导入新业务表。
- 旧支付表先保留但不被新运行时代码读取，仅供迁移命令核对；验证新系统稳定后再通过单独、人工确认的脚本清理。
- 历史订单如果无法安全映射到兑换码或权益，记录迁移统计并跳过，不猜测归属。

迁移命令必须输出数量统计和错误数量，不输出令牌、图片内容、提示词或密钥。

## 14. 测试与验收

### 14.1 Python 单元测试

- 配置加载、生产配置校验和敏感字段保护。
- 兑换码格式、生成、过期、禁用和状态转换。
- 并发兑换的行锁和唯一约束。
- 令牌哈希验证和常量时间比较。
- 权益一次任务绑定和状态机。
- 请求指纹一致性、重放、不匹配和失败重试。
- 图片文件头、MIME、大小和尺寸校验。
- Provider 请求构造、超时、错误分类和响应解析。
- Agent 预分析提示词清理、边界和最终拼接。
- 资产所有权、分享过期和下载路径。
- 管理员登录、CSRF、角色权限和审计。

### 14.2 API 集成测试

至少覆盖：

1. 生成兑换码。
2. 兑换成功并获得权益令牌。
3. 重复兑换被拒绝。
4. 使用权益完成经典生图。
5. 同一任务重放返回相同资产。
6. 更换照片、风格或背景返回请求不匹配。
7. Agent 背景白名单和未分析背景拒绝。
8. 分享只允许当前会话的服务端资产。
9. 过期资产和分享不可访问。
10. 管理员管理风格、背景和兑换码。

### 14.3 前端回归

继续执行：

```text
npm run lint
npm test
npm run build
npx playwright test e2e/kiosk-flow.spec.ts
```

Playwright 流程改为 mock 兑换码路径，覆盖经典和 Agent 两条路线。真实 provider 烟测仍单独执行，不纳入普通测试。

### 14.4 运行验收

后端切换后必须：

- 重启 Python API。
- 请求 `GET /api/health` 并确认数据库、存储和 Provider 状态。
- 请求 `GET /api/catalog`，确认不返回支付模式和价格字段。
- 使用一个测试兑换码完成兑换。
- 使用返回令牌完成一次经典或 Agent 生图。
- 验证重复任务、分享和下载。
- 确认前端 `http://localhost:5173` 与 Android WebView 配置的 API 地址都能访问。

## 15. 分阶段实施

### 阶段一：Python 骨架和领域模型

- 建立 Python 项目、配置、日志、数据库会话和 Alembic。
- 创建兑换、权益、任务、资产、分享和后台模型。
- 实现健康检查和基础错误处理。

### 阶段二：兑换与目录

- 实现兑换码 repository、权益 service 和兑换 API。
- 实现管理员批量生成兑换码、有效期和状态查询。
- 实现 catalog、风格和背景查询。
- 添加并发兑换测试。

### 阶段三：Provider 与生图

- 迁移 mock、GPT、Seedream、Jimeng 和 Gemini provider。
- 迁移视觉分析和 Agent 组合。
- 实现 multipart 图片上传、服务端资产保存、任务幂等和恢复。

### 阶段四：分享与后台

- 迁移分享页面和资源接口。
- 迁移管理员账号、会话、CSRF、风格、背景、兑换码和审计接口。
- 删除后台支付、价格和退款模块。

### 阶段五：前端切换与清理

- 删除支付页面和 PaymentService。
- 改为兑换入口和 `X-Entitlement-Token`。
- 修改 mock、单元测试和 Playwright。
- 停止 Node API，保留 Node 作为前端构建工具。

### 阶段六：迁移验证与旧代码清理

- 执行旧数据导入和端到端验证。
- 更新 README、AGENTS.md、问题台账和部署说明。
- 确认没有运行时代码引用支付模块。
- 再删除旧 Node server、支付表迁移和支付专用依赖。

## 16. 风险与取舍

- **multipart 改造范围较大**：前端服务层、API 测试和 Provider 输入都需要同步切换，但可以避免 Base64 放大请求体和内存峰值。
- **旧数据映射可能不完整**：无法可靠映射的历史订单不自动猜测，保留统计和只读历史。
- **MySQL 版本差异**：优先使用 MySQL 5.7 兼容 SQL，避免依赖仅 MySQL 8 支持的语法。
- **任务跨进程恢复**：正确性以数据库状态和唯一约束为准，进程内任务缓存只用于减少重复等待。
- **HTTP 部署安全边界**：本项目按现有部署约束允许 HTTP；应通过网络访问控制、管理员强口令、令牌哈希和最小暴露面降低风险，不把 HTTPS 作为本次迁移前置条件。
- **供应商差异**：所有供应商统一映射为内部错误码，真实供应商验证仍需要独立烟测和问题记录。

## 17. 完成标准

满足以下条件才认为迁移完成：

- Python API 可以独立启动并通过健康检查。
- 生产运行时不再依赖 Node.js/Express。
- 游客只通过兑换码获得一次体验权益。
- 支付、订单、退款和价格接口及前端入口均已删除。
- 经典和 Agent 流程均可使用 Python API 完成。
- 生图任务、资产所有权和分享过期逻辑经过集成测试。
- 管理后台保留必要运营能力且不显示支付概念。
- MySQL 迁移和旧数据导入有可重复命令。
- lint、Vitest、Vite build、Python pytest 和 Playwright 回归全部通过。
- 相关问题记录补充迁移结果、提交和验证证据。
