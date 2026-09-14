# Python 后端部署与启动手册

本文档是当前项目的正式部署入口，适用于：

- 公网服务器运行 Python/FastAPI 后端；
- MySQL 与 Python API 部署在同一台服务器，MySQL 只接受本机连接；
- Android Capacitor APK 运行在单台一体机上，通过 HTTP 访问公网 API；
- 管理员登录后台生成兑换码；
- 游客输入兑换码后完成经典生图或 Agent 生图。

当前运行时不启动旧的 Node/Express API，不包含支付、订单、退款、价格和小程序领取兑换码功能。

## 1. 运行结构

```text
Android APK / 浏览器
          |
          | HTTP
          v
Python FastAPI + Uvicorn :8787
          |
          +-- MySQL（仅 127.0.0.1:3306）
          +-- data/assets     图片资产
          +-- data/shares     分享相关文件
          +-- logs/           JSON 行日志
          +-- AI 图像供应商
```

生产环境由 Python 服务同时提供：

- 游客页面：`/`
- 管理后台：`/admin/`
- API：`/api/*`
- 公开分享页：`/api/shares/{shareId}`

浏览器开发时，Vite 运行在 `http://localhost:5173`，并把 `/api` 代理到 Python API。APK 不运行 Vite，而是把构建后的前端打包进 WebView；APK 通过 `VITE_API_BASE_URL` 指向公网 Python API。

本机开发测试也可以直接连接远程 MySQL：只要 `.env.local` 保持
`MYSQL_ENABLED=true`，并填写远程 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、
`MYSQL_PASSWORD` 和 `MYSQL_DATABASE`。不要为了本机测试改成 SQLite；测试套件内部
使用的临时 SQLite 仅用于隔离自动化测试，不是项目运行数据库。

## 2. 版本和目录要求

### 2.1 构建机

构建前端和 APK 的机器需要：

- Node.js `>=22.12.0`
- npm `>=10`
- Android Studio、JDK 和 Android SDK
- Android SDK Compile/Target SDK 35

### 2.2 Python 服务器

服务器需要：

- Python `>=3.11`
- MySQL 5.7 或兼容版本
- 能访问选定的图像供应商；Agent 模式还需要视觉分析服务
- 服务器本地可写项目目录、`data/` 和 `logs/`

服务器不需要 Node.js，前提是已经把前端 `dist/` 构建产物上传到服务器。如果在服务器上构建前端，则另外安装 Node.js。

### 2.3 推荐目录

以下示例把项目放在 `/opt/shan-jing-ai`：

```text
/opt/shan-jing-ai/
  .env.local
  .venv/
  backend/
  dist/
  public/
  data/
  logs/
```

不要把 `.env.local`、数据库密码、AI 密钥、`data/` 或 `logs/` 提交到 Git。

## 3. 获取代码并创建 Python 环境

在服务器执行：

```bash
sudo mkdir -p /opt/shan-jing-ai
sudo chown -R "$USER":"$USER" /opt/shan-jing-ai
cd /opt/shan-jing-ai

git clone <项目仓库地址> .
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e ./backend
```

如果服务器直接使用当前已构建好的压缩包，则跳过 `git clone`，把项目文件解压到同一目录，再执行虚拟环境和依赖安装命令。

开发或验收环境需要测试依赖时使用：

```bash
python -m pip install -e "./backend[dev]"
```

Windows PowerShell 对应命令：

```powershell
cd E:\AI\AIimage3.2-agent版本
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".\backend[dev]"
```

## 4. 创建环境配置

从示例复制：

```bash
cp .env.example .env.local
chmod 600 .env.local
```

Windows：

```powershell
Copy-Item .env.example .env.local
```

### 4.1 生产环境最小配置

将 `.env.local` 中至少修改为：

```dotenv
APP_ENV=production
API_HOST=0.0.0.0
API_PORT=8787

# Android 和公网浏览器访问的后端地址
PUBLIC_BASE_URL=http://你的公网IP:8787

# 生产使用 MySQL。DATABASE_URL 不要继续保留 SQLite 地址。
DATABASE_URL=
MYSQL_ENABLED=true
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=aiimage-py
MYSQL_PASSWORD=替换为数据库应用密码
MYSQL_DATABASE=aiaimage
MYSQL_CONNECTION_LIMIT=10

# 图像/视觉供应商不在 .env 中配置，改由数据库 model_configs 表决定。
# 在管理员后台「模型配置」新增一行并设为默认即可生效，无需重启。

# 后台运维兼容密钥，不是后台网页登录密码
ADMIN_TOKEN=替换为随机长字符串
ADMIN_SESSION_SECRET=替换为至少32字节随机字符串

# APK 的 Origin。桌面浏览器开发时可加 http://localhost:5173。
CORS_ORIGINS=capacitor://localhost,http://localhost

STATIC_DIRECTORY=dist
PUBLIC_DIRECTORY=public
ASSET_DIRECTORY=data/assets
SHARE_DIRECTORY=data/shares
LOG_FILE=logs/generation.log
```

生成随机值：

```bash
openssl rand -hex 32
```

没有 `openssl` 时：

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

注意：

1. `APP_ENV=production` 要求 `MYSQL_ENABLED=true`，并且必须存在可用的默认 `model_configs` 行；缺失时生图接口返回 `CONFIG_ERROR`，不再静默降级为 mock。
2. `ADMIN_SESSION_SECRET` 至少 32 字节，后台账号密码仍然来自数据库 `admin_users`。
3. `ADMIN_TOKEN` 只用于带 `X-Admin-Token` 的内部运维请求，不要把它当作后台密码。
4. 当前项目按 HTTP 部署，后台 Cookie 会根据 `PUBLIC_BASE_URL` 是否为 HTTPS 设置 `Secure`。使用 HTTP 时不要把 `PUBLIC_BASE_URL` 写成 `https://`。
5. 生图与视觉供应商的地址、模型和密钥统一由管理员后台写入 `model_configs` 表，不再从 `.env.local` 选择供应商。服务端密钥不能写成 `VITE_*`，也不能进入前端代码。

### 4.2 图像供应商配置

图像供应商在管理员后台的「图片生成模型」页面配置，保存到数据库 `model_configs` 表：

1. 新增一行，填写配置名称、供应商、接口地址、编辑接口路径、生成接口路径、模型名、API Key、超时（毫秒）、最大重试次数、熔断阈值与冷却时间（秒）；
2. 点击「获取可用模型」选择模型，「保存配置」后「设为默认」；
3. 只有 `is_default=1` 且 `enabled=1` 的行会生效；其余启用行作为同协议的备用线路，默认线路故障时自动接管。

「供应商」字段是自由文本，用于记录中转站名称（如 `deepcoding`、`NewAPI`）。当前产品只适配 `gpt-image-2`：只有填 `gpt-image-2`（或仅本地调试用的 `mock`）才会精确选中实现，填店名或仓库中其他实现名（`gpt-image-2-url`、`seedream`、`jimeng-i2i`、`gemini-3.1-flash-image`）一律按 OpenAI 兼容协议（默认实现 `gpt-image-2`，经典模式走 `/images/edits`）处理。其余实现代码仍保留在仓库以备将来使用，但配置无法选中它们。

线路容错参数逐个行配置，不在环境变量里：`timeout_ms`、`max_attempts`、`failure_threshold`、`cooldown_seconds`（后三列由迁移 `005_model_config_resilience` 引入，留空则用代码默认值 3 / 1 / 60）。`failure_threshold` 默认 1 是有意为之：一个请求里每个风格只贡献一次线路失败，阈值定高了前几个风格都会在死线路把重试预算烧完。一条线路的最坏耗时约为「`max_attempts` × `timeout_ms`」，必须留在前端 660 秒请求预算内（前端 `abort` 与 Vite 代理超时都是 `660000`），否则前端先超时、备用线路不会被执行。

`GPT_IMAGE_*`、`ARK_*`、`VOLC_*`、`JIMENG_*`、`GEMINI_IMAGE_*` 仅作为非 OpenAI 兼容实现的兜底参数保留；只要数据库里有可用的默认行，运行时就不会读取它们来决定供应商。`PUBLIC_BASE_URL` 按当前项目部署约束可以使用 HTTP。

### 4.3 Agent 模式配置

Agent 访客入口只有在以下条件同时满足时才会出现在目录中：

1. 数据库存在默认的 `image_generation` 行（管理员后台「图片生成模型」已设为默认）；
2. 数据库存在默认的 `vision_analysis` 行；
3. 数据库存在已发布、启用且 `analysis_status=ready` 的背景；
4. 背景图片是 JPEG、PNG 或 WebP；
5. 视觉分析配置完整：在管理员后台的“视觉模型”页面填写 NewAPI 兼容的接口地址和 API Key，点击“获取可用模型”，选择模型后保存并设为默认；不再从 `.env.local` 读取 `VISION_*` 配置。

Python 管理后台提供管理员登录，以及概览、体验权益、生图任务、风格版本、Agent 背景、兑换码、系统监控和审计日志。订单、支付、退款、价格和小程序 token 不属于当前迁移范围。风格和背景的素材、草稿、分析、发布操作均写入 MySQL 和 `data/assets/`；只有已发布、启用且 `analysis_status=ready` 的背景会进入游客目录。

## 5. MySQL 初始化

### 5.1 本机 MySQL

由于远程 MySQL 访问已关闭，API 和数据库在同一台服务器时使用：

```dotenv
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
```

在数据库服务器本机执行以下 SQL。用户名、密码和数据库名按 `.env.local` 保持一致：

```sql
CREATE DATABASE IF NOT EXISTS `aiaimage`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'aiimage-py'@'localhost'
  IDENTIFIED BY '替换为数据库应用密码';
CREATE USER IF NOT EXISTS 'aiimage-py'@'127.0.0.1'
  IDENTIFIED BY '替换为数据库应用密码';

GRANT ALL PRIVILEGES ON `aiaimage`.* TO 'aiimage-py'@'localhost';
GRANT ALL PRIVILEGES ON `aiaimage`.* TO 'aiimage-py'@'127.0.0.1';
FLUSH PRIVILEGES;
```

测试本机连接：

```bash
mysql -h 127.0.0.1 -P 3306 -u aiimage-py -p aiaimage -e "SELECT 1;"
```

不要为了让 APK 访问而开放公网 `3306`。公网只需要访问 Python API 的 `8787` 端口。

### 5.2 Docker MySQL（仅本地或临时环境）

项目提供 `compose.yaml`，默认把容器 MySQL 映射到本机 `127.0.0.1:3307`：

```powershell
Copy-Item .env.docker.example .env.docker.local
docker compose --env-file .env.docker.local up -d mysql
```

使用 Docker MySQL 时，将 Python 配置改成：

```dotenv
MYSQL_ENABLED=true
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3307
MYSQL_USER=aiaimage
MYSQL_PASSWORD=本地应用密码
MYSQL_DATABASE=aiaimage
DATABASE_URL=
```

生产服务器优先使用已有的受控 MySQL 实例；Docker 方案必须额外安排卷备份。

## 6. 执行数据库迁移

必须在 `.venv` 激活、`.env.local` 已配置并且数据库可连接的情况下，从项目根目录执行：

```bash
cd /opt/shan-jing-ai
source .venv/bin/activate
python -m alembic -c backend/alembic.ini upgrade head
```

检查迁移状态：

```bash
python -m alembic -c backend/alembic.ini current
mysql -h 127.0.0.1 -u aiimage-py -p aiaimage \
  -e "SHOW TABLES;"
```

当前 Python schema 主要包含：

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

执行 `upgrade head` 时，迁移 `003_seed_default_styles` 会幂等初始化 5 个默认风格到
`style_versions`，不会覆盖管理员已有的同名版本，也不会创建支付、订单或价格数据。
`background_versions` 不会写入代码内置占位图；需要在管理后台上传真实的 JPEG、PNG 或
WebP 图片，完成视觉理解后再发布。

旧 TS 数据库不是完全兼容结构。不要直接对旧支付业务库执行 Python 迁移并假定数据已经完成转换。正式切换前应先备份；无法可靠映射的旧订单不要人工猜测归属。当前 Python 运行时不读取支付、退款、价格和小程序 token 表。

## 7. 创建后台管理员

迁移完成后执行：

```bash
source .venv/bin/activate
python -m backend.app.admin_cli create-user --username owner --role owner
```

命令会交互式要求输入两次密码。角色说明：

- `owner`：可以登录后台并生成兑换码；
- `operator`：保留后台读取权限；
- `technical`：保留技术读取权限。

验证管理员登录：

1. 打开 `http://你的公网IP:8787/admin/`；
2. 使用上面创建的账号密码登录；
3. 确认页面能看到“兑换码”；
4. 生成 1 个测试兑换码；
5. 在一体机游客页面输入该兑换码。

后台登录不是 `ADMIN_TOKEN` 登录。登录成功后使用数据库中的 `admin_users` 账号，并通过 `admin_session` 和 CSRF Cookie 维持会话。

## 8. 构建并启动 Python API

### 8.1 生产构建

在构建机或服务器执行：

```bash
npm ci
npm run lint
npm test
npm run build
```

`npm run build` 生成 `dist/`。将 `dist/`、`public/`、`backend/`、`pyproject.toml`、`alembic.ini` 和 Python 依赖安装到服务器。

### 8.2 前台启动验证

```bash
cd /opt/shan-jing-ai
source .venv/bin/activate
python -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8787
```

生产后端使用 Python/FastAPI。`npm run start` 仅作为本地便捷入口，实际执行
Uvicorn；不要启动已经移除的旧 Node API。开发时可使用：

```bash
npm run dev
```

该命令启动 Vite 和 Python API。单独启动 Python API 可使用：

```bash
npm run python:dev
```

开发 API 默认命令：

```bash
npm run dev:api
```

### 8.3 HTTP 验收

另开终端执行：

```bash
curl -i http://127.0.0.1:8787/api/health
curl -i http://127.0.0.1:8787/api/catalog
curl -i http://127.0.0.1:8787/
curl -i http://127.0.0.1:8787/admin/
```

预期：

- `/api/health` 返回 JSON，`api`、`database`、`storage` 状态正常或可接受的 `degraded`；
- `/api/catalog` 返回 `styles`、`backgrounds`、`product` 和 `runtime`；
- `/` 返回游客页面；
- `/admin/` 返回后台页面；
- 返回内容不包含价格、支付模式或服务端提示词。

从外网再执行一次：

```bash
curl -i http://你的公网IP:8787/api/health
```

## 9. 使用 systemd 守护进程

创建服务文件：

```bash
sudo nano /etc/systemd/system/shan-jing-ai.service
```

写入以下内容，并按实际部署用户修改 `User`：

```ini
[Unit]
Description=Shan Jing AI Python API
After=network-online.target mysql.service
Wants=network-online.target

[Service]
Type=simple
User=shan-jing
WorkingDirectory=/opt/shan-jing-ai
EnvironmentFile=/opt/shan-jing-ai/.env.local
ExecStart=/opt/shan-jing-ai/.venv/bin/python -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8787
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

准备用户和目录：

```bash
sudo useradd --system --home /opt/shan-jing-ai --shell /usr/sbin/nologin shan-jing
sudo chown -R shan-jing:shan-jing /opt/shan-jing-ai
sudo chmod 600 /opt/shan-jing-ai/.env.local
```

启动和设置开机启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now shan-jing-ai
sudo systemctl status shan-jing-ai --no-pager
```

日志和重启：

```bash
sudo journalctl -u shan-jing-ai -f
sudo systemctl restart shan-jing-ai
sudo systemctl stop shan-jing-ai
```

升级版本时：

```bash
cd /opt/shan-jing-ai
sudo systemctl stop shan-jing-ai
git pull
source .venv/bin/activate
python -m pip install -e ./backend
python -m alembic -c backend/alembic.ini upgrade head
sudo chown -R shan-jing:shan-jing /opt/shan-jing-ai
sudo systemctl start shan-jing-ai
curl -fsS http://127.0.0.1:8787/api/health
```

数据库迁移只向前执行。不要在没有备份和验证的情况下执行 Alembic downgrade。

## 10. 防火墙和端口

当前部署至少需要：

- 公网开放 TCP `8787`，供 Android APK 和验收浏览器访问；
- MySQL TCP `3306` 只监听本机或受控内网地址；
- 不开放公网 `3306`；
- SSH 端口只允许运维来源访问。

示例 UFW：

```bash
sudo ufw allow 8787/tcp
sudo ufw deny 3306/tcp
sudo ufw status
```

如果云厂商有安全组，还要在安全组中同步设置。`8787` 不能被安全组拦截，否则 APK 会显示网络不可用。

## 11. Android APK 配置和构建

APK 构建前，在项目根目录 `.env.local` 写入：

```dotenv
VITE_API_BASE_URL=http://你的公网IP:8787
```

这个变量只对原生 Android WebView 生效。普通浏览器仍然使用同源 `/api`；服务端密钥不能放在这个变量中。

在安装 Android Studio、JDK 和 SDK 的构建机执行：

```powershell
npm ci
npm run android:sync
npm run android:build
```

当前脚本执行 `assembleDebug`，APK 通常位于：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

安装到设备：

```powershell
adb install -r android\app\build\outputs\apk\debug\app-debug.apk
```

现有 Android 工程已配置：

- `INTERNET`；
- `CAMERA`；
- `usesCleartextTraffic=true`；
- Capacitor `androidScheme=http`；
- WebView 通过 HTTP 上传照片到 Python API。

照片由 Android 设备摄像头拍摄，服务器不会访问设备摄像头。首次启动时需要在系统设置中允许应用使用摄像头。

APK 安装后验收：

1. 打开应用，确认首页不是空白；
2. 输入后台生成的测试兑换码；
3. 确认可以拍照或使用示例图回退；
4. 完成一次经典生图；
5. 验证结果查看、分享和下载；
6. 使用另一枚兑换码验证 Agent 目录是否按 `/api/catalog` 配置显示。

## 12. 兑换码业务操作

管理员操作：

1. 打开 `/admin/`；
2. 输入数据库管理员账号密码；
3. 进入兑换码页面；
4. 填写数量和可选过期时间；
5. 点击生成；
6. 立即复制并保存本次返回的明文兑换码。

数据库只保存兑换码哈希和前缀，后台列表不会再次显示完整兑换码。兑换码不通过小程序或其他外部系统自动领取。

游客操作：

```text
输入兑换码
  -> 获得一次性体验权益
  -> 拍照
  -> 经典风格或 Agent 背景
  -> 生图
  -> 分享和下载
```

每个兑换码只能成功兑换一次；每个体验权益只允许完成一次生图任务。生图和分享请求使用服务端返回的 `X-Entitlement-Token`，不是管理员 `ADMIN_TOKEN`。

## 13. 日常检查

每日或每次发布后执行：

```bash
curl -fsS http://127.0.0.1:8787/api/health
curl -fsS http://127.0.0.1:8787/api/catalog
sudo systemctl is-active shan-jing-ai
df -h /opt/shan-jing-ai
```

重点检查：

- `database.status` 不是 `down`；
- `storage.status` 不是 `down`，剩余空间高于保留阈值；
- `runtime.agentEnabled` 与当前 Agent 配置一致；
- `backgrounds` 中存在可用的已发布背景时，Agent 才会显示；
- `logs/generation.log` 或 systemd 日志没有持续出现上游鉴权、超时或磁盘不足。

日志不得包含原始照片、Base64、访问令牌、兑换码明文、动态提示词、供应商响应体或密钥。

## 14. 备份和恢复

至少备份两类数据：

1. MySQL 数据库；
2. `data/assets/` 和 `data/shares/` 图片资产。

示例：

```bash
mkdir -p /backup/shan-jing
mysqldump --single-transaction --routines --triggers \
  -h 127.0.0.1 -u aiimage-py -p aiaimage \
  | gzip > /backup/shan-jing/aiaimage-$(date +%F-%H%M%S).sql.gz

tar -czf /backup/shan-jing/assets-$(date +%F-%H%M%S).tar.gz \
  -C /opt/shan-jing-ai data/assets data/shares
```

恢复前：

1. 停止 `shan-jing-ai`；
2. 确认备份文件来源和时间；
3. 先恢复到临时数据库或临时目录验证；
4. 再恢复生产数据；
5. 启动服务并检查 `/api/health`、`/api/catalog` 和后台登录。

## 15. 故障排查

### 15.1 `Access denied for user ...`

这通常表示命令在非数据库服务器上执行，或者 MySQL 用户只允许其他 Host：

```bash
mysql -h 127.0.0.1 -P 3306 -u aiimage-py -p aiaimage -e "SELECT 1;"
```

请在数据库所在服务器本机执行，并确认 `.env.local` 使用 `MYSQL_HOST=127.0.0.1`。不要通过公网开放 MySQL 端口解决。

### 15.2 后台登录后又回到登录页

检查：

1. 访问地址是否与 `PUBLIC_BASE_URL` 的协议一致；
2. HTTP 部署时 `PUBLIC_BASE_URL` 是否是 `http://...`；
3. 浏览器是否保留了旧 Cookie，必要时清除 `admin_session` 和 `admin_csrf` 后重新登录；
4. `admin_users` 是否存在且 `active=1`；
5. `journalctl -u shan-jing-ai` 是否有数据库错误。

### 15.3 `/api/health` 正常但 Agent 不显示

执行：

```bash
curl -s http://127.0.0.1:8787/api/catalog
```

确认 `runtime.agentEnabled=true` 且 `backgrounds` 非空。仅配置 Gemini 密钥还不够；还需要已发布、已分析、可读取的 JPEG/PNG/WebP 背景。

### 15.4 APK 能打开但请求失败

检查：

1. 构建 APK 时 `.env.local` 是否包含正确的 `VITE_API_BASE_URL`；
2. 公网访问 `http://你的公网IP:8787/api/health` 是否成功；
3. 云安全组和服务器防火墙是否放行 `8787`；
4. Android 系统是否允许摄像头权限；
5. API 是否仍由 systemd 运行。

修改 `.env.local` 后必须重新执行 `npm run build` 或 `npm run android:build`，Vite 不会在已生成的 APK 中动态读取新地址。

### 15.5 生图失败

先看：

```bash
curl -s http://127.0.0.1:8787/api/health
sudo journalctl -u shan-jing-ai --since "10 minutes ago"
tail -n 100 logs/generation.log
```

重点区分：

- `CONFIG_ERROR`：供应商或 Agent 配置不完整；
- `UPSTREAM_AUTH`：供应商密钥或模型权限问题；
- `UPSTREAM_TIMEOUT`：上游响应超时；
- `STORAGE_LOW_SPACE`：本地资产磁盘空间不足；
- `GENERATION_ALREADY_CONSUMED`：同一兑换权益已经绑定其他任务，不是新的生图请求。

## 16. 最终验收清单

- [ ] Python `>=3.11` 和虚拟环境安装完成。
- [ ] `APP_ENV=production`、`MYSQL_ENABLED=true`、`DATABASE_URL` 未指向 SQLite。
- [ ] MySQL 用户可从 `127.0.0.1` 登录，公网 `3306` 未开放。
- [ ] `python -m alembic -c backend/alembic.ini upgrade head` 成功。
- [ ] 已创建数据库管理员，能用账号密码登录 `/admin/`。
- [ ] 后台能生成兑换码，列表不显示完整明文。
- [ ] `/api/health`、`/api/catalog`、`/`、`/admin/` 外网可访问。
- [ ] Python API 由 systemd 自动启动和重启。
- [ ] APK 使用正确 `VITE_API_BASE_URL` 构建。
- [ ] APK 摄像头权限、HTTP API、生图、分享和下载均已验证。
- [ ] `data/`、`.env.local` 和 MySQL 已安排备份。
- [ ] 没有启动旧 Node API，也没有使用旧小程序领取接口。
