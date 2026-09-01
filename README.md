# 山境造像 · AI 旅拍一体机 Demo

面向 1080×1920 竖屏景区一体机的高保真应用。游客使用手机微信扫描大屏动态付款码，支付成功后通过设备摄像头拍照，选择最多两种 AI 风格，生成作品并扫码保存。

## 运行

```bash
npm install
npm run dev
```

默认使用模拟支付。进入支付页后点击“开发模式：模拟完成支付”，即可解锁拍照流程。

## 微信支付接入

安卓大屏采用微信支付 API v3 的 Native 支付：服务端下单，大屏展示 `code_url` 动态二维码，游客用自己的手机微信付款。前端轮询本站订单状态；只有微信回调验签、解密并核对商户号、订单号、币种和 990 分金额后，服务端才签发本次体验的支付凭证。`/api/generation` 会再次校验该凭证，不能只修改前端页面绕过支付。

尚未取得商户资料时，在 `.env.local` 使用：

```dotenv
PAYMENT_MODE=mock
PAYMENT_AMOUNT_FEN=990
PUBLIC_BASE_URL=http://127.0.0.1:8787
```

最后一步会把作品保存到 `data/shares/`，并生成 24 小时有效的手机作品页。局域网测试时，手机和一体机需连接同一 Wi-Fi，并使用电脑局域网地址打开前端（例如 `http://192.168.1.20:5173`）；服务会自动把分享二维码生成为该局域网地址。公网部署时，将 `PUBLIC_BASE_URL` 设置为可访问的 HTTPS 域名。

真实接入前，需要准备：

- 已开通 Native 支付权限的微信支付普通商户号。
- 与商户号绑定的公众号、小程序或开放平台 `AppID`。
- 商户 API 证书序列号和 `apiclient_key.pem` 私钥。
- 32 字节 APIv3 密钥。
- 微信支付公钥 ID 和公钥 PEM 文件；本项目按微信支付公钥模式验签。
- 可从公网访问的 HTTPS 域名；微信回调地址将是 `PUBLIC_BASE_URL/api/payments/wechat/notify`。

将密钥文件放到未纳入 Git 的 `secrets/`，然后配置：

```dotenv
PAYMENT_MODE=wechat-native
PAYMENT_AMOUNT_FEN=990
PAYMENT_DESCRIPTION=山境造像 AI 旅拍体验
PUBLIC_BASE_URL=https://kiosk.example.com
WECHAT_PAY_APP_ID=wx...
WECHAT_PAY_MCH_ID=190...
WECHAT_PAY_CERT_SERIAL=...
WECHAT_PAY_PRIVATE_KEY_PATH=secrets/apiclient_key.pem
WECHAT_PAY_API_V3_KEY=32字节APIv3密钥
WECHAT_PAY_PUBLIC_KEY_ID=PUB_KEY_ID_...
WECHAT_PAY_PUBLIC_KEY_PATH=secrets/wechatpay_public_key.pem
```

启用 `MYSQL_ENABLED=true` 时，订单、支付凭证和生图权益使用 MySQL 持久化，并通过商户订单号、微信交易号和生图任务唯一约束保证幂等。未启用 MySQL 时，开发环境仍可回退到 `data/payment-orders.json`；生产环境应启用 MySQL。私钥、APIv3 密钥、支付公钥文件不能放入 APK、Vite 环境变量或 Git。

## 本地 Docker MySQL

仓库提供 MySQL 5.7 Compose 配置，默认仅监听 `127.0.0.1:3307`。先创建本地密码文件：

```bash
copy .env.docker.example .env.docker.local
```

修改 `.env.docker.local` 中的两个密码后启动数据库：

```bash
docker compose --env-file .env.docker.local up -d mysql
npm run db:migrate
npm run db:import-json
```

应用侧 `.env.local` 使用 `MYSQL_HOST=127.0.0.1`、`MYSQL_PORT=3307`、`MYSQL_DATABASE=aiaimage`，账号密码与 `.env.docker.local` 保持一致。Docker 数据保存在命名卷 `aiimage_mysql_data`。

需要由数据库管理员手工执行 SQL 时，请按
[server/db/sql/README.md](server/db/sql/README.md) 的顺序运行完整 Schema、增量升级和目录初始化脚本。

## 质量检查

```bash
npm run lint
npm test
npm run build
```

## 真实 AI 生图配置

当前真实 provider 的配置不在前端页面中，而在 Node 服务端环境变量中。浏览器始终请求本站 `/api/generation`，API Key 不会进入 Vite bundle。

```bash
copy .env.example .env.local
```

在 `.env.local` 中选择一种模式：

```dotenv
# 离线演示
AI_PROVIDER=mock
VITE_GENERATION_MODE=mock

# GPT Image 2：OpenAI Images API 兼容服务
AI_PROVIDER=gpt-image-2
VITE_GENERATION_MODE=api
GPT_IMAGE_BASE_URL=https://你的自定义服务/v1
GPT_IMAGE_API_KEY=服务端密钥
GPT_IMAGE_MODEL=gpt-image-2
GPT_IMAGE_ENDPOINT=/images/edits

# 火山方舟 Seedream
AI_PROVIDER=seedream
VITE_GENERATION_MODE=api
ARK_API_KEY=火山方舟APIKey
ARK_SEEDREAM_MODEL=你的推理接入点ID

# 即梦图生图 3.0 智能参考
AI_PROVIDER=jimeng-i2i
VITE_GENERATION_MODE=api
VOLC_ACCESS_KEY_ID=火山引擎AccessKeyID
VOLC_SECRET_ACCESS_KEY=火山引擎SecretAccessKey
JIMENG_SCALE=0.5
JIMENG_WIDTH=1024
JIMENG_HEIGHT=1536

# Gemini 3.1 Flash Image：上传原图后进行 Edit 修图
AI_PROVIDER=gemini-3.1-flash-image
VITE_GENERATION_MODE=api
GEMINI_IMAGE_BASE_URL=https://deepcoding.sbs/v1
GEMINI_IMAGE_API_KEY=服务端密钥
GEMINI_IMAGE_MODEL=gemini-3.1-flash-image
GEMINI_IMAGE_ENDPOINT=/chat/completions
```

启动前后端：

```bash
npm install
npm run dev
```

前端仍运行在 `http://localhost:5173`，API 服务运行在 `http://127.0.0.1:8787`，Vite 会自动代理 `/api`。生产构建后使用 `npm run start`，Node 服务会同时托管 `dist` 和 API。

GPT Image 2 适配器发送 `multipart/form-data`，支持上游返回 `data[0].b64_json` 或 `data[0].url`。Seedream 适配器发送 JSON，并兼容 `data[0]`/`images[0]` 的 base64 或 URL 返回。即梦图生图适配器使用火山引擎 AK/SK 在 Node 服务端签名，提交 `jimeng_i2i_v30` 异步任务并在适配器内部查询至完成。Gemini 适配器使用 OpenAI 兼容聊天接口，将游客原图和数据库风格提示词作为 Edit 修图请求提交，并从 `choices[0].message.content` 的图片 Data URI 中提取 JPEG、PNG 或 WebP 结果；它不支持本站的纯文本空白生图流程。前端流程不变。各服务的真实图片进度通常不是流式百分比，页面上的进度是有界的等待反馈，不代表供应商实际进度。

也可以用项目自带脚本直接测试 GPT Image 2 图片编辑。脚本会自动查找 `test/` 或 `src/test/` 下的第一张图片，并把结果保存到 `test/output/`：

```bash
copy .env.example .env.local
# 在 .env.local 中填写 GPT_IMAGE_BASE_URL 和 GPT_IMAGE_API_KEY
npm run test:gpt-image-2
```

如需指定输入、输出或修改指令：

```bash
npm run test:gpt-image-2 -- --input src/test/你的图片.png --output test/output/result.png --prompt "保留人物不变，把背景改成雪山日落"
```

API Key、火山引擎 AK/SK 只能写入 `.env.local` 或部署平台的服务端密钥配置，不能使用 `VITE_GPT_IMAGE_API_KEY`、`VITE_ARK_API_KEY`、`VITE_VOLC_ACCESS_KEY_ID`、`VITE_GEMINI_IMAGE_API_KEY` 等前端变量。

## 生图日志

服务端会将每个接口的请求开始、完成、状态码、404、JSON 解析异常，以及生图参数校验、每个风格的模型调用、上游失败、成功和总耗时写入 `logs/generation.log`，每行是一条 JSON 日志。生图成功日志包含请求 ID、provider、实际模型、风格 ID、风格名称、生成资源 ID、输出类型、输出大小和耗时；失败日志包含错误码、上游 HTTP 状态和安全截断后的错误摘要，可用于定位认证失败、限流、超时、上游返回格式错误等问题。日志不会记录 API Key、原始照片、Base64 图片、生成图片内容或提示词。可通过 `LOG_LEVEL`、`LOG_FILE` 和 `LOG_RETENTION_DAYS` 配置日志级别、文件路径和保留天数。


- `getUserMedia` 可用时调用真实摄像头；权限拒绝或无摄像头时自动使用示例图。
- AI 生图由 `GenerationService` mock 实现，不调用任何模型供应商。
- 二维码为演示分享 URL；真实上线需后端、对象存储和公网 HTTPS 分享页。
- 模拟支付仅用于 Demo。生产必须使用 `PAYMENT_MODE=wechat-native`，并通过公网 HTTPS 接收微信回调。

## 后续接入

页面只依赖 `src/services/contracts.ts` 中的接口。后续可分别替换 `PaymentService`、`GenerationService` 与 `ShareService`，无需改动主流程组件。
