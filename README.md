# 山境造像 · AI 旅拍一体机

这是一个运行在安卓一体机上的 AI 人像拍摄应用。前端继续使用 React/Vite 和 Capacitor，后端已迁移到 Python/FastAPI。

完整的服务器部署、MySQL 初始化、后台账号、兑换码、systemd 和 Android APK 操作步骤见：
[Python 后端部署与启动手册](docs/deployment-python.md)

当前产品流程：

```text
欢迎页 -> 输入兑换码 -> 拍照 -> 确认照片 -> 选择创作方式
       -> 经典风格 / Agent 背景 -> 生图 -> 结果 -> 分享下载
```

项目不包含支付、订单、退款、价格和小程序领取兑换码功能。兑换码只能由管理员在后台批量生成，游客在一体机页面兑换；每个兑换码只能兑换一次，每个兑换权益只能完成一个生图任务。

## 启动

### Python 后端

需要 Python 3.11 或更高版本：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e "backend[dev]"
python -m alembic -c backend/alembic.ini upgrade head
python -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8787
```

本机开发和生产运行都使用 MySQL，通过远程 `MYSQL_*` 配置连接；项目运行时禁止回退到 SQLite。后端默认只提供同源 API，不会把模型密钥下发到浏览器。

### React 前端

另开终端运行：

```powershell
npm install
npm run dev:web
```

Vite 开发服务器默认运行在 `http://localhost:5173`，需要将 `/api` 代理到正在运行的 Python API。安卓 APK 使用 `VITE_API_BASE_URL` 访问公网 Python API；普通浏览器仍然使用同源 `/api`。

生产前端构建：

```powershell
npm run lint
npm test
npm run build
```

如果将 `STATIC_DIRECTORY=dist` 配置给 Python 后端，FastAPI 会同时托管构建后的游客页面和 `/admin/` 管理页面。

## 管理后台

打开 `http://localhost:8787/admin/` 或 Vite 开发服务器的 `/admin/`，使用管理员账号和密码登录。

账号和密码只从数据库 `admin_users` 表校验，不会使用 `ADMIN_TOKEN` 作为网页登录密码。迁移前数据库已有管理员账号时，直接使用原账号密码；新数据库可先执行：

```powershell
python -m backend.app.admin_cli create-user --username owner --role owner
```

后台目前提供：

- 批量生成兑换码
- 设置兑换码过期时间
- 查看兑换码状态、兑换会话和时间
- 复制本次生成的兑换码

管理接口：

```text
POST /api/admin/auth/login
GET  /api/admin/auth/me
POST /api/admin/auth/logout
POST /api/admin/redeem-codes/generate
GET  /api/admin/redeem-codes
```

登录成功后使用 `admin_session` 会话 Cookie 和 CSRF Cookie 访问后台。`X-Admin-Token` 仅保留给服务器内部运维调用，不是管理页面的登录方式。兑换码明文只在生成响应和管理员页面本次结果中出现，数据库只保存哈希和前缀。

## 访客 API

```text
POST /api/entitlements/redeem
GET  /api/catalog
POST /api/generation
POST /api/agent/generation
POST /api/shares
GET  /api/shares/{shareId}
GET  /api/shares/{shareId}/images/{index}
GET  /api/shares/{shareId}/download/{index}
GET  /api/assets/{assetId}
GET  /api/health
```

生图和分享请求使用 `X-Entitlement-Token`。经典生图和 Agent 生图均使用 `multipart/form-data` 上传照片，客户端只能提交风格 ID 或已发布的背景 ID，不能提交模型提示词。

## 环境变量

复制 `.env.example` 为 `.env.local`，至少配置：

```dotenv
APP_ENV=development
API_HOST=0.0.0.0
API_PORT=8787
ADMIN_TOKEN=请替换为内部运维随机密钥
DATABASE_URL=
MYSQL_ENABLED=true
MYSQL_HOST=远程 MySQL 地址
MYSQL_PORT=3306
MYSQL_USER=数据库用户名
MYSQL_PASSWORD=数据库密码
MYSQL_DATABASE=数据库名
PUBLIC_BASE_URL=http://127.0.0.1:8787
```

图像与视觉供应商全部在数据库的 `model_configs` 表里配置：在后台「模型配置」新增一行（接口地址、接口路径、模型名、API Key），设为默认即可生效，不需要改 `.env` 重启。默认行（`is_default=1`）优先，其余启用行作为同协议的备用线路，主线路故障时自动接管。

供应商名（`provider` 列）可以自由填写供应商店名；当前只适配 `gpt-image-2`，所以只有填 `gpt-image-2` 或 `mock`（仅本地调试）才会精确选中实现，填店名或仓库里其他实现名（`gpt-image-2-url`、`seedream`、`jimeng-i2i`、`gemini-3.1-flash-image`）都按 OpenAI 兼容协议走 `gpt-image-2`。

同一条配置行还承载该线路的容错参数，均在后台「图片生成模型」编辑，不需要改 `.env`：

| 字段 | 作用 | 默认值 |
| --- | --- | --- |
| 请求超时（毫秒） | 单次上游调用超时 | 按行填写 |
| 最大重试次数 | 同一线路内部重试几次 | 3 |
| 熔断阈值 | 连续失败几次后跳过该线路 | 1 |
| 冷却时间（秒） | 跳过后多久放行一次探测 | 60 |

一条线路的最坏耗时约为「最大重试次数 × 请求超时」，必须留在前端 660 秒的请求预算内，否则前端会先超时，备用线路根本轮不到。

Agent 模式还需要管理员发布已完成视觉分析的 JPEG、PNG 或 WebP 背景素材。不要使用 `VITE_` 前缀保存任何服务端密钥。

## 测试

Python 后端：

```powershell
python -m pytest backend/tests
```

前端和浏览器流程：

```powershell
npm run lint
npm test
npm run build
npx playwright test e2e/kiosk-flow.spec.ts
```

## Android

安卓端仍然由 Capacitor 封装。照片由安卓设备摄像头拍摄后通过 HTTP 上传到 Python API，服务器不会调用安卓设备摄像头。明文 HTTP 和摄像头权限配置沿用现有 Android 工程约束。

```powershell
npm run android:sync
npm run android:build
```

旧 Node/支付运行时代码已移除；当前后端唯一运行时是 `backend/` 下的 Python/FastAPI。
