# 2026-09-14 默认超时预算使备用生图线路不可达

## 文档信息

- 发现时间：`2026-09-14 11:50:00 +08:00`
- 解决时间：`2026-09-14 14:05:00 +08:00`
- 范围：`backend/app/model_configs.py`、`backend/app/db/models.py`、`backend/app/db/migrations/versions/005_model_config_resilience.py`、`backend/app/providers/`（circuit / failover / http / gpt_image / gpt_image_url）、`backend/app/domain/generation_service.py`、`backend/app/api/admin.py`、`backend/app/config.py`、`src/admin/AdminApp.tsx`
- 关联问题：`2026-09-14-provider-config-in-database.md`（ISSUE-030 引入了降级链，本问题是它的生效条件缺陷）

## 状态定义

见 `2026-08-19-project-review.md`。允许状态：`待处理`、`处理中`、`已解决`、`暂不处理`。

## 问题索引

| 编号 | 优先级 | 状态 | 问题摘要 |
| --- | --- | --- | --- |
| ISSUE-031 | P1 | 已解决 | ISSUE-030 引入的备用线路在默认配置下永远不会被调用：单线路重试预算 903s 已超过前端 660s 硬上限；且熔断阈值按「线路失败次数」计而每个风格只贡献 1 次，阈值 3 等于永不触发 |

## 问题详情

### ISSUE-031：备用线路被超时预算挡在门外

- 优先级：`P1`
- 状态：`已解决`
- 发现时间：`2026-09-14 11:50:00 +08:00`
- 背景：ISSUE-030 让 `model_configs` 的每条启用行成为备用线路（`get_active_model_configs` → `FailoverImageProvider`）。但降级只有在「上一条线路抛错」之后才会发生，而线路内部还有一层重试，两者叠加后的耗时超过了客户端上限。

- 具体缺陷：

  1. **每条线路内部会重试 3 次**：`providers/http.py` 的 `MAX_ATTEMPTS = 3`，且 `UPSTREAM_TIMEOUT` 被标记为 `retryable=True`（`providers/gpt_image.py:56-62`）。单次尝试的超时取自行配置 `timeout_ms`。
  2. **当时数据行的 `timeout_ms = 300000`**（`deepcoding` / `tokenworldai` 均为 300 秒）。因此「厂商挂起不响应」时，一条线路的耗时约为 `3 × 300s + 退避(1s + 2s) ≈ 903s`。
  3. **客户端硬上限是 660s**：`src/services/httpGeneration.ts:14` 的 `controller.abort()` 与 `vite.config.ts:19` 的代理超时都是 `660000`。`/api/generation` 是同步长请求，没有轮询兜底。
  4. 于是 `903s > 660s`：**前端先断开，服务端还没走到 `FailoverImageProvider` 的下一条线路**，备用配置形同虚设。
  5. **熔断阈值默认 3 且按「线路失败次数」计**，而**每个风格只贡献 1 次失败**（`retry_operation` 在 provider 内部完成，对外只抛 1 个 `ProviderError`）。所以阈值 3 意味着一个请求里的前 3 个风格都会在主线路上把重试预算烧完，备用线路要到第 4 个风格才有机会——单请求内几乎不可能触发。

- 实测依据（只读查询远程库 `aiimage-py`）：

  ```text
  generation_jobs 共 12 条：agent/succeeded=3、classic/succeeded=8、classic/failed=1
  单任务耗时（含 1 个风格）：min=6s  中位=50s  max=384s
  多数任务 attempts=1，个别 attempts=2 / 6
  ```

  即单张图的正常耗时约 45–59 秒，`timeout_ms = 300000` 有约 5 倍余量，明显偏大；但直接压到 60s 以下会误杀正常请求。

- 影响：
  - 管理员在后台启用备用行后，`standbyLines` 会变成 1，**看起来已生效，但实际故障场景下不会被使用**，属于「配置显示成功、行为不符合预期」。
  - 线上故障时表现为「游客等待 11 分钟后失败」，而不是「快速切换到备用厂商」。

## 处理结果

- 状态：`已解决`
- 解决时间：`2026-09-14 14:05:00 +08:00`

- 用户给定的两个约束：**不要在 `.env` 里加配置，要调就调数据库**；**当前只适配 `gpt-image-2`**。

- 变更内容：

  1. **容错参数全部进数据库**（迁移 `005_model_config_resilience`）。`model_configs` 新增三列 `max_attempts`、`failure_threshold`、`cooldown_seconds`，均可空，NULL 时回落 `backend/app/model_configs.py` 的代码常量 `DEFAULT_MAX_ATTEMPTS=3` / `DEFAULT_FAILURE_THRESHOLD=1` / `DEFAULT_COOLDOWN_SECONDS=60`，所以存量行不需要回填。

  2. **默认熔断阈值由 3 改为 1**（`DEFAULT_FAILURE_THRESHOLD`）。这是本问题最关键的一处：既然每个风格只贡献 1 次线路失败，阈值必须让降级在第一次失败就发生，否则请求内的后续风格会反复撞死线路。`CircuitBreaker.record_failure()` 现在接受逐行的阈值与冷却时间，`GenerationLine` 携带这两个值，`_provider_for` 从行配置组装。

  3. **重试次数逐行生效**：`retry_operation(operation, max_attempts=...)`，`GptImageProvider` / `GptImageUrlProvider` 传入本行配置。`max_attempts` 上线设为 5，避免把超时预算撑爆。

  4. **可选实现收敛为 `gpt-image-2`**：新增 `SELECTABLE_PROVIDER_KEYS = {mock, gpt-image-2}`，`resolve_provider_key` 只认它。`PROVIDER_KEYS`（六个实现的注册表）保留给 `factory` 与既有测试，因此 `gpt-image-2-url` / `seedream` / `jimeng-i2i` / `gemini-3.1-flash-image` 的实现代码仍在仓库中，但配置无法选中它们——写了会降级到 `gpt-image-2` 而不是切换协议。后台下拉同步只列 `gpt-image-2` 与 `mock`（标注仅本地调试）。

  5. **移除环境变量**：`Settings.provider_failure_threshold`、`Settings.provider_cooldown_seconds` 已删除（连同 `positive_integer` 白名单与 `.env.example` 条目）。`shared_circuit_breaker()` 不再接收 `settings`。

  6. **后台可编辑**：`ModelConfigInput` 新增 `maxAttempts` / `failureThreshold` / `cooldownSeconds`（带范围校验 1–5 / 1–20 / 1–3600），`_model_config_dict` 回传，创建与更新端点写入；`AdminApp.tsx` 在图片生成模式下新增三个输入框，留空即用默认值（输入框以 placeholder 显示当前默认值）。

  7. **文档同步**：`AGENTS.md`、`CLAUDE.md`、`README.md`、`docs/deployment-python.md` 更新了实现选择范围与「容错参数在行上」的说明。同时修正了 `AGENTS.md` 中「Agent 仅支持 mock 与 gemini」的过时描述——Agent 合成现在走同一套数据库解析的 provider 与备用链。

- 验证证据：

  ```text
  pytest backend/tests/                  80 passed（原 74，新增 6 条：
                                          可选实现降级、默认阈值为 1、
                                          行级参数读取、NULL 回落、
                                          非正值清洗、重试次数生效；
                                          test_migrations 增加新列存在且可空断言）
  npm test                               16 passed
  npm run lint                           干净
  npm run build                          通过类型检查（tsc -b && vite build）
  ```

- 注意：迁移已在远程库执行（`004_model_configs` → `005_model_config_resilience`）。新增列可空，对当时仍在运行的旧版本代码向后兼容，不需要停机。

## 遗留与后续

- **数据侧仍需人工调两个值**：`deepcoding` / `tokenworldai` 的 `timeout_ms` 仍为 `300000`，建议按实测中位 50s 调到 `120000`（约 2.4 倍余量）；`tokenworldai` 行仍是 `enabled=0`，需要在后台启用才会进入降级链。这两项是数据侧操作，本轮未擅自改动生产数据。
- **4 风格 + 挂起型故障的极端组合**：即使按上述配置，一次生成 4 个风格时若主线路是「挂起不响应」型故障（每次尝试都吃满超时），660s 预算仍可能不够。彻底解决需要代码层取舍：超时不做同线路重试直接降级、提高前端/Vite 超时上限，或把风格生成改为并发。当前未实施。
- 备用线路只覆盖「主线路失败」。主线路能返回但质量下降时不会自动切换，需要人工在后台「设为默认」。
- 视觉分析（`vision_analysis`，当前 `baibai`）仍走单行 `get_default_model_config`，**没有降级链**；`/api/health` 的 `agentVision` 也没有 `standbyLines` 字段。
