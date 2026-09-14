# 2026-09-14 生图厂商不稳定导致的生成链路脆弱

## 文档信息

- 发现时间：`2026-09-14 11:00:00 +08:00`
- 解决时间：`2026-09-14 11:35:00 +08:00`
- 范围：`backend/app/providers/`（重试与错误分类）、`backend/app/domain/generation_service.py`（多层生成编排与落库）、`backend/app/jobs/generation_queue.py`（任务认领）、以及前台生成页与结果页的部分成功展示
- 关联问题：见 `2026-08-19-project-review.md`、`2026-09-14-admin-login-error-message.md`

## 状态定义

见 `2026-08-19-project-review.md`。允许状态：`待处理`、`处理中`、`已解决`、`暂不处理`。

## 问题索引

| 编号 | 优先级 | 状态 | 问题摘要 |
| --- | --- | --- | --- |
| ISSUE-029 | P0 | 已解决 | 生图厂商抖动会被放大成游客体验事故：多风格全量丢弃、错误误判锁死任务、失败重试实际不可用、重试无退避 |

## 问题详情

### ISSUE-029：厂商抖动被放大为游客侧事故

- 优先级：`P0`
- 状态：`已解决`
- 发现时间：`2026-09-14 11:00:00 +08:00`
- 背景：本项目的可用性下限由生图厂商决定，而厂商抖动（超时、429、5xx、返空、截断）是常态。问题不在于厂商会抖，而在于四处设计把「一次抖动」放大成「游客拿不到任何作品」。
- 线上数据实证（只读查询 `generation_jobs`）：

  ```text
  succeeded = 11   failed = 1
  attempts 分布：1 次 10 条，2 次 1 条，6 次 1 条
  ```

  `attempts = 6` 说明游客在设备前反复点了 6 次重试；而失败入口 `KioskFlow.tsx:324` 的「重试生成」会退回风格页整体重来，每次都重新调用上游全部风格。

#### 29-A：多风格全量丢弃，整体成功率是单张的四次方

- 位置：`backend/app/domain/generation_service.py` 的 `_run()`（原 `486-512` 行）与 `process_queued_job()`（原 `288-317` 行）
- 现象：四个风格在 `for` 循环里串行调用上游，结果只收集到内存列表，全部结束后才调用 `_persist_results()` 落库。任一风格抛出 `ProviderError` 时，`except` 分支直接 `queue.fail()` 并向上抛错，**已经生成成功、且上游已经计费的图片被整体丢弃**。
- 影响：单张成功率 p 时，四张全成功的概率是 p⁴。p=0.9 时整体只有 65.6%，p=0.8 时只有 41%。游客看到的是「全部失败」，并倾向于立刻再点一次重试，重复消耗上游成本。
- 修复：改为逐张独立捕获。每张成功立即进入结果集，失败只记录该风格的错误码并继续处理其余风格；落库阶段成功风格标 `succeeded`、失败风格单独标 `failed` 并写入 `error_code`，任务整体标 `succeeded`（有作品交付，因此 `share_service.py:45` 的分享校验与后台统计均不受影响）。响应新增 `failures` 数组。全部风格都失败时才维持原有整体失败语义。
- 额度语义：只要有一张成功即视为已交付并消费额度（`_persist_results` 保持原有 consume 逻辑）。为不让游客为丢失的图二次付费，`_run()` 新增 `_is_salvage_request()`：当请求的 `styleId` 集合是**该任务中已失败风格的子集**时，允许沿用同一个 `generationId` 补画，`GenerationQueue.claim()` 增加 `style_ids` 参数以只重置待补画的风格，不打扰已交付的作品。

#### 29-B：错误分类误判，把瞬时抖动锁成「请联系工作人员」

- 位置：`backend/app/providers/errors.py`、`backend/app/providers/images.py` 的 `decode_image_value()`
- 现象：`decode_image_value()` 把「返空、data URL 结构异常、base64 截断、解码后校验失败、格式不匹配」统一抛为 `UPSTREAM_BAD_RESPONSE` 且 `retryable=False`。而失败分类直接决定任务状态：`queue.fail(..., uncertain=not error.retryable)`。于是 `uncertain=True`，`_run()` 走到 else 分支返回 `409 GENERATION_ALREADY_CONSUMED`「本次生图任务状态无法自动重试，请联系工作人员处理」。
- 影响：这些都是瞬时故障（上游半张图、字段丢失、网关抖动），却被当成永久失败。本项目部署在单台安卓自助设备上、无人值守，「请联系工作人员」等于流程当场终止。
- 修复：新增 `transient_upstream_error()` 与错误码 `UPSTREAM_TRANSIENT`（`retryable=True`），把「上游返回了无法使用的图片/无效响应」全部归为可重试；只有确定性错误（图片过大、4xx 参数类响应）保持不可重试。`fetch_image_url()` 中未被捕获的 `validate_image_bytes` 异常也一并纳入该分类（此前会直接冒泡成 500）。

#### 29-C：`failed` 分支的认领条件失效，可重试任务实际无法重试

- 位置：`backend/app/domain/generation_service.py` 原 `415-427` 行
- 现象：该分支的注释写着「允许重试可重试的失败任务（如超时、429、5xx错误）」，但它调用的是 `GenerationQueue.claim()`，而 `claim()` 的查询条件是 `GenerationJob.status == "queued"`。此时任务状态是 `failed`，查询必然为空，`claimed` 为假，于是返回 `409 GENERATION_IN_PROGRESS`「生图任务正在重试，请稍后查询结果」。
- 影响：注释描述的能力从未生效。游客点击重试只会拿到一个错误的「正在重试」提示并被卡住。
- 修复：重试路径改为先把任务置回 `queued`、清空 `error_code` 与 `completed_at`，再调用 `claim()`；并把 `failed` 与 `uncertain` 统一纳入可重试范围。新增配置 `MAX_GENERATION_ATTEMPTS`（默认 3）作为重试上限，超限返回 `GENERATION_ATTEMPTS_EXHAUSTED`，避免无限重试持续打上游。

#### 29-D：重试无退避且不读 `Retry-After`，生效 provider 完全没有重试

- 位置：`backend/app/providers/http.py` 的 `retry_once()`
- 现象：实现为最多 2 次尝试、固定 `await asyncio.sleep(1)`。既不读取上游的 `Retry-After`，也没有指数退避或抖动。更严重的是，`.env.local` 中实际生效的 `AI_PROVIDER=gpt-image-2-url` 对应的 `providers/gpt_image_url.py` **完全没有接入重试**——`gemini.py` 与 `gpt_image.py` 调用了 `retry_once`，而线上真正使用的文件一次都没有。
- 影响：上游明确要求「30 秒后再来」时，代码 1 秒后就重发，必然再次收到 429；所有瞬时故障都直接穿透到游客。
- 修复：`retry_once()` 重写为 `retry_operation()`：最多 3 次尝试，指数退避（1s 起、上限 8s）叠加 25% 抖动，`429`/`503` 优先采用 `Retry-After`（数字形式，上限 8s）。新增 `parse_retry_after()`，`map_provider_status()` 增加 `retry_after_seconds` 参数并把提示写入 `details.retryAfterSeconds`。`gpt_image_url.py`（`generate` 与 `compose`）、`seedream.py` 全部接入重试；不可重试错误（如 401）立即失败，不浪费重试预算。

- 影响面（修复前）：
  - 四风格生成的整体成功率被压到单张成功率四次方，游客与商户同时受损。
  - 任何一次上游返空都会把任务推进死锁状态，在无人值守设备上无法自愈。
  - 失败重试入口形同虚设。
  - 生效 provider 无重试，瞬时故障零缓冲。

- 验证证据：
  - 后端 `python -m pytest backend/tests` → `62 passed`（新增 3 条接口级用例：部分成功保留与补偿补画、`uncertain` 任务可重试、全失败不消费额度）
  - 新增 provider 层用例：瞬时坏响应被判定为可重试、首次返空第二次自动恢复、429 重试并采用上游 `Retry-After`、401 立即失败不重试、退避函数增长/封顶/优先采用上游提示
  - 前端 `npm test` → `16 passed`；`npm run lint` 无告警；`npm run build` 通过类型检查
  - 重启 Python API 后 `GET http://127.0.0.1:8787/api/health` 返回 `overall ok`（`database ok` / `imageGeneration ok` / provider `gpt-image-2-url`），`GET /api/catalog` 返回 5 个风格与 1 个背景，经 Vite 代理 `localhost:5173/api/health` 返回 200，`logs/generation.log` 无异常事件
- 验证边界说明：部分成功与 `uncertain` 重试的**端到端触发依赖上游真实抖动**，本次未在真实上游上制造故障（避免产生图片费用与测试数据）。这两条路径由测试中的 ASGI 集成用例覆盖，运行的是同一套路由与 service 代码。

- 尚未处理（建议后续单独立项）：
  - 无熔断器与多厂商故障切换。`model_configs` 表已存在备用行 `tokenworldai`（同模型 `gpt-image-2`，`enabled=0`），但 `get_default_model_config()` 只取 `is_default=1` 一行，且 `_provider_for()` 硬编码返回 `GptImageProvider`，备用线路形同虚设。
  - 健康检查只判断数据库里是否存在配置行，不探测上游可达性，厂商宕机时仍报 `ok`。
  - 缺少按厂商维度的成功率/延迟/错误码统计，故障时无法快速定位。
  - 超时链路三层不一致：DB 行 `timeout_ms=300000`、前端 `660_000`、Vite 代理 `660_000`（`AGENTS.md` 中「Vite 代理 360 秒」的描述已过时）。
  - `ApiError.retryable` 已返回给前端但前端从未使用。
