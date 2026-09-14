# Python 后端与兑换权益迁移实施计划

## 1. 目标

将当前 `server/` Express/TypeScript 后端替换为 `backend/` Python/FastAPI 服务，同时完成兑换码产品化改造：

- 游客流程为 `welcome -> redeem -> camera -> review -> mode -> generation -> results -> download`。
- 兑换码只由管理员后台生成，不提供其他小程序领取接口。
- 兑换成功后签发一次体验权益令牌。
- 经典和 Agent 生图、资产保存、分享和后台鉴权都使用体验权益。
- 删除支付、订单、价格、退款、微信支付和小程序 token 运行时代码。
- 保留 React/Vite、Capacitor Android 和浏览器摄像头回退。

本计划不修改用户当前已有的未提交改动，实施时每个阶段单独验证并提交。

## 2. 最终运行结构

```text
root/
  backend/
    app/
      main.py
      config.py
      api/
      domain/
      db/
      repositories/
      providers/
      vision/
      storage/
      security/
    tests/
    alembic.ini
    pyproject.toml
  src/                         # React/Vite/Capacitor 保留
  public/                      # 前端和分享资源保留
```

从仓库根目录启动：

```text
python -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8787
```

`backend` 和 `backend/app` 增加包初始化文件，避免开发环境和 Uvicorn 的导入路径依赖当前工作目录。

## 3. 阶段一：冻结接口并建立 Python 骨架

### 文件

新增：

- `backend/pyproject.toml`
- `backend/alembic.ini`
- `backend/app/__init__.py`
- `backend/app/main.py`
- `backend/app/config.py`
- `backend/app/dependencies.py`
- `backend/app/cli.py`
- `backend/app/api/errors.py`
- `backend/app/logging/json_logger.py`
- `backend/app/security/tokens.py`
- `backend/tests/test_config.py`

修改：

- `package.json`
- `.env.example`
- `README.md`
- `vite.config.ts`（仅在开发 API 启动命令需要时修改）

### 实现

1. 使用 Pydantic Settings 读取 `APP_ENV`、API、MySQL、AI、视觉、存储、兑换权益和管理员配置。
2. 配置校验覆盖：
   - Provider 枚举和必填密钥。
   - `MAX_STYLES <= 4`。
   - 图片大小、超时、分享有效期和权益有效期为正数。
   - 生产环境必须启用 MySQL。
   - 生产环境管理员会话密钥至少 32 字节。
   - 不再读取支付、微信支付、价格和小程序 token 配置。
3. 添加 FastAPI 应用工厂和统一异常响应。
4. 添加 CORS、请求 ID、安全响应头和 JSON 行日志中间件。
5. 使用 `StaticFiles` 接管 `dist/`、`public/` 和 `/admin` 静态页面；API 路径优先于前端 fallback。
6. 保留现有 `VITE_API_BASE_URL` 约定，Android WebView 仍通过 HTTP 访问独立 Python API。
7. 新增脚本：

```text
python:dev
python:test
python:migrate
python:migrate-legacy
```

`npm run dev:api` 只负责启动 Python API，Node 仍仅用于 Vite、Vitest、Playwright 和 Android 构建。

### 验证

```text
python -m pytest backend/tests/test_config.py
python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8787
curl http://127.0.0.1:8787/api/health
```

健康接口此阶段可以返回数据库和 Provider 的基础状态，但不得返回密钥。

## 4. 阶段二：迁移数据库模型和数据访问层

### 文件

新增：

- `backend/app/db/base.py`
- `backend/app/db/session.py`
- `backend/app/db/models.py`
- `backend/app/db/migrations/env.py`
- `backend/app/db/migrations/versions/001_entitlement_schema.py`
- `backend/app/repositories/entitlement_repository.py`
- `backend/app/repositories/generation_repository.py`
- `backend/app/repositories/catalog_repository.py`
- `backend/app/repositories/share_repository.py`
- `backend/app/repositories/admin_repository.py`
- `backend/tests/test_models.py`
- `backend/tests/test_repositories.py`

修改：

- `compose.yaml`
- `server/db/sql/README.md`（标记旧 Node SQL 为历史并指向 Python migration）

### 新数据库表

正式 schema 创建：

- `redeem_codes`
- `entitlements`
- `generation_jobs`
- `generation_styles`
- `style_versions`
- `background_versions`
- `assets`
- `shares`
- `admin_users`
- `admin_sessions`
- `audit_logs`

不创建：

- `orders`
- `refund_requests`
- `payment_notifications`
- `pricing_versions`
- `mini_program_tokens`

`approval_requests` 只有在确认仍被风格/背景发布使用时才保留；若无实际运行时引用，则不创建。

### 关键约束

1. `redeem_codes.code_hash` 唯一。
2. `entitlements.redeem_code_id` 唯一。
3. `entitlements.token_hash` 唯一。
4. `generation_jobs.entitlement_id` 唯一。
5. `generation_styles(generation_id, style_id)` 唯一。
6. `assets` 关联生图任务并保存过期时间。
7. 日期统一保存 UTC，响应序列化为 ISO 8601。
8. MySQL 使用 5.7 可用的字段、索引和事务语法。

### Repository 规则

- Repository 只负责查询、事务和模型映射。
- 兑换码和权益兑换必须由一个事务服务调用 `SELECT ... FOR UPDATE`。
- 令牌只保存 SHA-256 哈希；验证使用 `hmac.compare_digest`。
- Repository 不记录照片、令牌、提示词或供应商返回体。
- SQLite 仅用于不依赖行锁的单元测试；并发兑换测试使用 MySQL 测试库。

### 验证

```text
python -m alembic -c backend/alembic.ini upgrade head
python -m pytest backend/tests/test_models.py backend/tests/test_repositories.py
```

新增 MySQL 标记测试：

```text
python -m pytest -m mysql backend/tests/test_redeem_concurrency.py
```

## 5. 阶段三：兑换权益 API

### 文件

新增：

- `backend/app/domain/entitlement_service.py`
- `backend/app/api/entitlements.py`
- `backend/app/api/admin_redeem_codes.py`
- `backend/tests/test_entitlement_service.py`
- `backend/tests/test_entitlement_api.py`

### API

保留：

```text
POST /api/entitlements/redeem
POST /api/admin/redeem-codes/generate
GET  /api/admin/redeem-codes
```

删除：

```text
POST /api/redeem-codes/claim
POST /api/admin/redeem-codes/mini-tokens
```

### 行为

`POST /api/entitlements/redeem`：

1. 校验兑换码为 8 位允许字符。
2. 校验 `sessionId` 为 UUID。
3. 锁定兑换码记录。
4. 拒绝不存在、过期、禁用、已预留和已兑换的兑换码。
5. 创建 `entitlements`，设置 `ENTITLEMENT_TTL_HOURS` 和 `MAX_STYLES`。
6. 标记兑换码为 `redeemed`。
7. 提交后返回权益摘要和一次性明文 `accessToken`。

管理员批量生成：

- 仅允许 `owner` 角色或 `code:write` 权限。
- 数量限制为 1 到 500。
- 可设置有效期。
- 明文兑换码只在成功响应返回。
- 只保存哈希、前缀、状态、有效期和审计记录。
- 不生成或保存任何小程序 token。

### 验证

- 同一兑换码两个并发请求只能一个成功。
- 重复兑换返回 409。
- 过期和禁用返回明确状态码。
- 数据库不出现明文令牌。
- 管理员生成接口的响应只在生成时包含明文兑换码。

## 6. 阶段四：目录、图片校验和存储

### 文件

新增：

- `backend/app/domain/catalog_service.py`
- `backend/app/api/catalog.py`
- `backend/app/storage/assets.py`
- `backend/app/storage/uploads.py`
- `backend/app/security/paths.py`
- `backend/tests/test_images.py`
- `backend/tests/test_storage.py`

迁移：

- `server/catalog/catalog.ts` -> Python catalog repository/service。
- `server/assets/assetStore.ts` -> Python asset store。
- `server/lib/images.ts` -> Python Pillow 校验和上游图片下载保护。

### 实现

1. 将服务端需要的风格名称、提示词、模式、色板和 mock 预览从 TypeScript fixture 迁移为 Python seed 数据或 JSON。
2. Python 不导入 `src/mocks/fixtures/*.ts`，避免后端运行时依赖前端源码。
3. `GET /api/catalog` 返回已发布风格、已发布且已分析背景、产品限制和 Agent 是否可用。
4. 不返回 `pricing`、`paymentMode` 或服务端风格提示词。
5. 图片接收使用 `UploadFile` 配合分块读取，超过 `AI_MAX_INPUT_BYTES` 立即拒绝。
6. Pillow 解码并检查真实格式、像素尺寸和总像素数；只允许 JPEG、PNG、WebP。
7. 资产路径使用根目录解析和 UUID 文件名，禁止路径穿越。
8. 上游图片 URL 只允许 HTTPS、拒绝私网/环回解析、禁止自动重定向并限制响应大小。
9. 保留定期清理过期资产、分享和孤立数据库记录。

### 验证

```text
python -m pytest backend/tests/test_images.py backend/tests/test_storage.py
```

覆盖伪造 MIME、损坏图片、超大图片、超大像素、路径穿越、私网 URL 和重定向拒绝。

## 7. 阶段五：Provider 和视觉模块迁移

### 文件

新增：

- `backend/app/providers/base.py`
- `backend/app/providers/mock.py`
- `backend/app/providers/gpt_image.py`
- `backend/app/providers/gpt_image_url.py`
- `backend/app/providers/seedream.py`
- `backend/app/providers/jimeng.py`
- `backend/app/providers/gemini.py`
- `backend/app/providers/errors.py`
- `backend/app/vision/analyze.py`
- `backend/tests/test_providers.py`
- `backend/tests/test_gemini.py`
- `backend/tests/test_vision.py`

迁移来源：

- `server/providers/types.ts`
- `server/providers/mock.ts`
- `server/providers/gptImage2.ts`
- `server/providers/gptImageUrl.ts`
- `server/providers/seedream.ts`
- `server/providers/jimengI2i.ts`
- `server/providers/geminiImageEdit.ts`
- `server/vision/analyze.ts`
- `server/lib/errors.ts`
- `server/lib/urls.ts`

### 实现

1. 所有 Provider 实现统一 `generate`，支持双图的 Provider 实现 `compose`。
2. Provider 选择只在配置依赖注入层完成，API 路由不判断供应商名称。
3. HTTP 调用统一使用 HTTPX，设置连接、读取和总超时。
4. 复用现有错误码映射、重试上限、响应大小限制和上游 URL 安全策略。
5. Seedream、Jimeng 签名和轮询逻辑保持行为一致，但改为 Python 实现并单独测试。
6. Gemini 经典 Edit 和 Agent 双图 Compose 保持请求协议和输出图片校验。
7. Agent 视觉分析继续使用管理员预分析；游客请求不调用视觉模型。
8. 动态 Agent prompt 只存在于当前请求内存和成功响应，不写数据库、不写日志、不进后台接口。
9. mock Provider 可离线运行，但不再依赖支付或订单数据。

### 验证

Provider 测试使用 HTTPX mock transport，不调用真实供应商：

- 正常 base64/url 图片响应。
- 非 JSON 鉴权失败。
- 限流、超时和上游 5xx。
- Gemini 图片 Data URI 提取。
- Agent 双图请求中的背景和游客照片。
- 视觉提示词清洗、长度限制和固定安全约束。

## 8. 阶段六：生图任务、幂等和分享 API

### 文件

新增：

- `backend/app/domain/generation_service.py`
- `backend/app/domain/share_service.py`
- `backend/app/api/generation.py`
- `backend/app/api/shares.py`
- `backend/app/jobs/maintenance.py`
- `backend/tests/test_generation_api.py`
- `backend/tests/test_share_api.py`

### API

保留：

```text
POST /api/generation
POST /api/agent/generation
POST /api/shares
GET  /api/shares/{id}
GET  /api/shares/{id}/images/{index}
GET  /api/shares/{id}/download/{index}
```

鉴权头统一改为：

```text
X-Entitlement-Token
```

不接受 `X-Payment-Token`。

### multipart 协议

经典：

```text
photo       JPEG/PNG/WebP 文件
sessionId   字符串
generationId UUID
sceneId     允许的场景 ID
styles      JSON 数组字符串
```

Agent：

```text
photo       JPEG/PNG/WebP 文件
sessionId   字符串
generationId UUID
backgroundId 允许的背景 ID
```

### 任务流程

1. 校验权益令牌、会话和有效期。
2. 分块保存并校验输入照片。
3. 计算 `sessionId + photo bytes + mode parameters` 的请求哈希。
4. 锁定权益记录。
5. 首次请求创建唯一任务并进入 `processing`。
6. 同一任务同一哈希返回处理中或已保存结果。
7. 同权益不同任务返回 `GENERATION_ALREADY_CONSUMED`。
8. 同任务不同哈希返回 `GENERATION_REQUEST_MISMATCH`。
9. Provider 成功后保存资产、任务明细和完成状态。
10. 可重试错误将任务置为 `failed`；不可安全重试错误置为 `uncertain`。
11. 进程重启后从数据库恢复已完成资产；不恢复动态 prompt。

Provider 全局并发限制默认 1。数据库唯一约束负责正确性，内存任务字典只作为重复请求等待优化，不能作为唯一幂等机制。

### 分享

- 分享接口只接受 `assetId`。
- 校验资产属于当前会话对应的权益任务且未过期。
- 不接受客户端 `imageUrl`、Data URL 或任意服务器路径。
- 分享页面继续提供品牌明信片、原图下载和过期提示。
- 分享 ID 使用高熵随机值并限制格式。

### 验证

- 经典单风格、多风格和最大 4 风格。
- Agent 单背景单结果。
- 同一任务并发请求只执行一次。
- 进程内缓存清空后可从数据库恢复结果。
- 任务失败重试和不可重试状态。
- 未授权、过期权益、资产越权、分享过期和非法图片。

## 9. 阶段七：管理员 API 迁移

### 文件

新增：

- `backend/app/security/admin_auth.py`
- `backend/app/domain/admin_service.py`
- `backend/app/api/admin.py`
- `backend/tests/test_admin_api.py`

迁移来源：

- `server/routes/admin.ts`
- `server/lib/health.ts`
- `server/jobs/generationQueue.ts`

### 保留接口

- `/api/admin/auth/login`
- `/api/admin/auth/logout`
- `/api/admin/auth/me`
- `/api/admin/summary`
- `/api/admin/entitlements`
- `/api/admin/generations`
- `/api/admin/generations/{id}/retry`
- `/api/admin/redeem-codes`
- `/api/admin/redeem-codes/generate`
- `/api/admin/styles`
- `/api/admin/style-assets`
- `/api/admin/backgrounds`
- `/api/admin/background-assets`
- `/api/admin/backgrounds/{id}/analyze`
- `/api/admin/backgrounds/{id}/publish`
- `/api/admin/styles/{id}/publish`
- `/api/admin/styles/{id}/rollback`
- `/api/admin/health`
- `/api/admin/audit-logs`

### 删除接口和权限

- `/api/admin/orders`
- `/api/admin/dashboard` 中支付字段
- `/api/admin/pricing`
- `/api/admin/refunds`
- `/api/admin/redeem-codes/mini-tokens`
- `price:write`
- `refund:request`
- `refund:write`

### 实现

1. 保留数据库管理员会话、Cookie、CSRF 和 `X-Admin-Token` bootstrap。
2. 保留 owner/operator/technical 权限。
3. 将订单统计改为兑换码、权益和生图任务统计。
4. 生图任务显示 `generationId`、`entitlementId`、`sessionId`、模式、状态、错误码和时间。
5. 风格和背景版本化接口沿用当前发布、回滚、分析和资源校验逻辑。
6. 所有写操作写入审计日志，但不记录明文兑换码、令牌、照片或 prompt。
7. 健康检查返回数据库、存储、Provider、视觉配置和任务状态。

## 10. 阶段八：前端游客和后台适配

### 游客文件

修改：

- `src/types/index.ts`
- `src/features/session/sessionReducer.ts`
- `src/features/kiosk/KioskFlow.tsx`
- `src/services/contracts.ts`
- `src/services/index.ts`
- `src/services/httpEntitlement.ts`
- `src/services/httpGeneration.ts`
- `src/services/httpAgentGeneration.ts`
- `src/services/httpShare.ts`
- `src/services/httpCatalog.ts`
- `src/mocks/services/entitlement.ts`
- `src/mocks/services/generation.ts`
- `src/styles/global.css`

删除：

- `src/services/httpPayment.ts`
- PaymentService、PaymentOrder 类型和 payment 阶段状态。

### 游客改造

1. 欢迎页直接进入兑换页。
2. 删除支付二维码、支付倒计时、支付轮询、模拟支付和支付重试。
3. `paymentToken` 改为 `entitlementToken`。
4. `REDEEMED` 直接进入 camera。
5. 生图和分享请求头改为 `X-Entitlement-Token`。
6. 将照片 Data URL 转为 Blob/File 后通过 `FormData` 上传。
7. mock 服务保持同样的权益字段和任务行为，不再模拟支付订单。
8. 保留 `getUserMedia`、权限失败和示例照片回退。
9. 更新步骤编号、提示文案和错误文案，去除“支付”字样。

### 后台文件

修改：

- `src/admin/AdminApp.tsx`
- `src/admin/admin.css`

1. 删除订单、价格、退款导航和组件。
2. 将概览指标改为兑换码、权益和生图任务。
3. 将订单号字段替换为权益 ID。
4. 删除支付、退款、交易号和价格配置文案。
5. 保留兑换码批量生成、复制、有效期和状态列表。
6. 删除小程序 token 生成和领取 UI。

## 11. 阶段九：测试、启动和文档切换

### 测试修改

修改：

- `e2e/kiosk-flow.spec.ts`
- `e2e/real-upload.integration.spec.ts`
- `playwright.config.ts`
- 现有 `src/**/*.test.ts`

新增：

- `backend/tests/conftest.py`
- `backend/tests/test_api_flow.py`
- `backend/tests/test_migrations.py`

Playwright mock 流程：

1. welcome -> redeem。
2. 输入测试兑换码并模拟成功响应。
3. 使用示例照片。
4. 完成经典路线。
5. 完成 Agent 路线。
6. 分享、下载、重置。
7. 删除所有支付 route mock 和支付断言。

### 命令

最终必须通过：

```text
npm run lint
npm test
npm run build
python -m pytest backend/tests
npx playwright test e2e/kiosk-flow.spec.ts
```

Node build 只用于浏览器和 Android 产物；Python API 单独启动和验收。

### 文档

修改：

- `README.md`
- `AGENTS.md`
- `.env.example`
- `server/db/sql/README.md`
- `docs/redeem-codes-spring-boot.md`
- `docs/issues/2026-08-19-project-review.md`
- `docs/issues/2026-09-02-agent-image-mode.md`

删除或标记历史：

- `server/payment/`
- `server/routes/payments.ts`
- `server/routes/entitlements.ts`
- `server/payment/mysqlOrderRepository.ts`
- `server/db/importLegacy.ts`
- `server/db/sql/002_upgrade_payment.sql`

旧 Node 后端文件在 Python API 完成并通过切换验收前不删除；最终清理必须单独提交。

## 12. 旧数据迁移

### 新部署

直接执行 Alembic 初始迁移，创建新业务 schema，不创建支付和小程序 token 表。

### 现有数据库

迁移前要求人工备份并停机切换。`python -m backend.app.cli migrate-legacy` 按以下顺序执行：

1. 读取旧 `redeem_codes`、`orders`、`generation_jobs`、`generation_styles` 和 `assets`。
2. 创建新 `entitlements` 及新任务/明细表。
3. 将兑换码哈希、状态、有效期和兑换时间导入新兑换码表。
4. 对可可靠关联的 `voucher` 订单创建 entitlement：
   - `redeem_codes.order_id` 能关联订单时，写入 `redeem_code_id`。
   - 使用旧 `access_token_hash` 作为新 entitlement 的 `token_hash`。
   - 已绑定成功生图的权益标记为 consumed，否则标记为 active。
5. 使用同一 `generationId` 导入可恢复任务和资产引用。
6. 无法可靠映射的旧订单不猜测归属，只输出数量统计。
7. 旧支付表保留为只读历史，Python 新运行时代码不读取。
8. `mini_program_tokens` 不迁移到新业务；确认不再需要后由人工清理。

迁移命令不得输出明文令牌、兑换码、照片、prompt、供应商响应或密钥。需要导入的历史明文兑换码只在迁移前已存在的管理员导出中处理，不能通过日志传递。

## 13. 每阶段提交规则

每一阶段完成后：

1. 运行与改动范围匹配的测试。
2. 运行 `git diff --check`。
3. 确认没有把 `.env.local`、`data/`、`logs/`、`dist/`、`dist-server/` 或测试输出加入暂存区。
4. 提交信息简短说明改动和验证结果。
5. 服务端改动完成后重启 Python API，检查：

```text
GET http://127.0.0.1:8787/api/health
GET http://localhost:5173
```

6. 访问受影响接口，确认运行中的服务已经加载新逻辑。

## 14. 最终切换验收

1. 停止 Node API。
2. 启动 Python API。
3. 请求 `/api/health`，确认数据库、存储和 Provider。
4. 请求 `/api/catalog`，确认无 `pricing` 和 `paymentMode`。
5. 后台生成兑换码并复制保存。
6. 游客输入兑换码获得权益令牌。
7. 使用令牌完成经典生图。
8. 使用另一枚测试兑换码完成 Agent 生图。
9. 验证重复任务重放、不同请求 409、分享和下载。
10. 登录后台确认兑换码、权益、生图任务、风格、背景、健康和审计可用。
11. 确认 `/api/payments/*`、小程序 token 接口、价格和退款接口不存在。
12. 执行完整测试集并记录结果到问题台账。

迁移只有在 Python 服务独立运行、前端两条生图路线通过、支付概念从运行时代码和后台界面移除后才标记完成。
