# 2026-09-14 管理后台登录错误提示失真

## 文档信息

- 发现时间：`2026-09-14 10:30:00 +08:00`
- 最后更新时间：`2026-09-14 10:30:00 +08:00`
- 范围：管理后台登录页（`src/admin/AdminApp.tsx`）与登录接口 `POST /api/admin/auth/login` 的错误提示语义
- 关联问题：见 `2026-08-19-project-review.md`

## 状态定义

见 `2026-08-19-project-review.md`。允许状态：`待处理`、`处理中`、`已解决`、`暂不处理`。

## 问题索引

| 编号 | 优先级 | 状态 | 问题摘要 |
| --- | --- | --- | --- |
| ISSUE-028 | P1 | 待处理 | 任何非 JSON 的失败响应都被显示为「账号或密码错误」，掩盖真实的 500 / 数据库不可用 |

## 问题详情

### ISSUE-028：登录失败提示一律显示为「账号或密码错误」

- 优先级：`P1`
- 状态：`待处理`
- 发现时间：`2026-09-14 10:30:00 +08:00`
- 复现场景：后端可正常启动并监听 `8787`，但 MySQL 不可达（例如未配置 `.env.local`、远程库抖动、网络中断）
- 复现步骤：
  1. 启动后端，确认 `GET /api/health` 返回 `status: "down"`，`checks.database.status = "down"`，`details.code = "MYSQL_TIMEOUT"`
  2. 提交登录：`POST /api/admin/auth/login`，body 为任意合法 JSON 账号密码
  3. 观察结果：接口返回 `HTTP 500`，响应体为纯文本 `Internal Server Error`
  4. 后台页面显示的却是「账号或密码错误」
- 观察到的证据：

  ```text
  $ curl -s -w "\n[HTTP %{http_code}]\n" -X POST \
      http://127.0.0.1:8787/api/admin/auth/login \
      -H "Content-Type: application/json" \
      -d '{"username":"owner","password":"whatever"}'
  Internal Server Error
  [HTTP 500]
  ```

  服务端日志中的真实原因：

  ```text
  pymysql.err.OperationalError: (2003, "Can't connect to MySQL server on '127.0.0.1'")
  ```

- 根因链（四步，缺一不可）：
  1. `backend/app/security/admin_auth.py:113` 的 `select(AdminUser).where(...)` 会立即建立数据库连接。数据库不可达时抛出 `sqlalchemy.exc.OperationalError`，`AdminAuth.login()` 未捕获，异常穿透到 ASGI 层，FastAPI 返回 `500`，响应体是纯文本而非 JSON。
  2. `src/admin/AdminApp.tsx:33-35` 的 `readPayload()` 用 `response.json().catch(() => ({}))` 兜底。纯文本响应体不是合法 JSON，解析失败后返回空对象 `{}`。
  3. `src/admin/AdminApp.tsx:36-38` 的 `payloadMessage(payload, '账号或密码错误')` 判断 `typeof payload.message === 'string'`。空对象没有 `message`，因此返回兜底文案「账号或密码错误」。
  4. `src/admin/AdminApp.tsx:89` 的 `if (!response.ok || !payload.user) throw new Error(payloadMessage(...))` 抛出该文案，`:91-92` 的 `catch` 把它写入 `setError()`，渲染到登录页。

  因此密码正确性从未被评估：`verify_admin_password()`（`admin_auth.py:80`）根本不会执行，因为第 113 行的查询先失败了。

- 影响：
  - 服务端任何非 JSON 的失败响应都会被伪装成凭据错误，包括 `500`、`502`、`504` 以及反向代理返回的 HTML 错误页。
  - 生产环境中远程 MySQL 短暂不可用或连接数打满时，运维会被误导去排查账号密码，而不是数据库连通性，直接拉长故障定位时间。
  - `500`（服务端故障）与 `401`（凭据错误）在用户可见层面无法区分；而真实 401 的语义是「账号或密码错误」，`admin_auth.py:125` 的 `ApiError("ADMIN_UNAUTHORIZED", ..., 401)` 才是该文案唯一合法的来源。
- 建议修复方向（未实施）：
  - 只把 `HTTP 401` 映射为「账号或密码错误」；其他状态码显示通用失败提示并带上状态码，例如「登录服务异常（HTTP 500），请稍后重试」，同时保留服务端返回的 `message`（若为合法 JSON）。
  - 可进一步让后端在数据库不可用时返回结构化错误（如 `503` + `DATABASE_UNAVAILABLE`），避免绕过 `ApiError` 处理器直接落到 500 纯文本。
- 备注：本次是在无数据库的本地开发环境中确认该问题。提示失真本身与是否存在数据库无关，只要服务端返回非 JSON 失败响应即可复现。
- 状态跟进（`2026-09-14 10:40:00 +08:00`）：补齐 `.env.local` 并重启后，远程 MySQL 已可达，`POST /api/admin/auth/login` 对错误凭据恢复返回 `401` + `{"code":"ADMIN_UNAUTHORIZED","message":"账号或密码错误"}`，本问题的触发条件当前不成立。**但前端代码未做任何修改**，缺陷依然存在，只要服务端再出现非 JSON 的失败响应（500/502/504 或反向代理 HTML 错误页）就会重新伪装成「账号或密码错误」。因此状态保持 `待处理`，不得标记为 `已解决`。
