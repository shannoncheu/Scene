# Scene · 百变小克的影视工坊

Scene 是一个可自行部署的私人观影档案。它从 Trakt 同步电影和单集观看历史，并在一个页面里汇集时间线、海报墙、剧集进度、观影统计和影院票根。

## 项目特点

- **观影档案** · 支持按年份、类型、片名和日期范围浏览。重温保留为独立事件，电影作品数、剧集集次和观看次数分别统计。
- **热力图与追剧进度** · 按设置的时区统计活跃日期、年度趋势和估算时长，显示已看集数与已播集数。
- **影院票根** · 上传照片后可自动裁剪、手动旋转，并在独立票根页查看。图片经过格式和大小校验。
- **Trakt 同步** · 首次导入全部历史，日常同步优先检查变更并增量读取。遇到历史差异或到达定期校对时间才扫描全部记录。
- **手动补录与日期修正** · 先预览再确认。补录成功后按 Trakt 返回的真实记录 ID 入库，普通补录不会强制整库校对。日期修正会用新日期替换所选 Trakt 事件，提交前请核对。
- **私人访问** · Trakt OAuth 2.0 + PKCE，单账号白名单、服务端加密令牌和会话校验。后台同步只读，补录与日期修正需要明确确认。

## 技术栈

![Next.js](https://img.shields.io/badge/Next.js-15-000000?logo=nextdotjs)
![React](https://img.shields.io/badge/React-19-20232A?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-0F172A?logo=tailwindcss)
![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-6-2D3748?logo=prisma&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)
![Caddy](https://img.shields.io/badge/Caddy-1F88C0?logo=caddy&logoColor=white)

| 层 | 实现 |
| --- | --- |
| 页面与 API | Next.js App Router、React、TypeScript |
| 界面 | Tailwind CSS、自定义 CSS、Radix Dialog、Lucide 图标 |
| 存储与图像 | SQLite、Prisma、Sharp / WebP |
| 外部服务 | Trakt OAuth 与历史 API，可选 TMDB 元数据补充 |
| 部署 | Docker Compose，Caddy 负责反向代理和 HTTPS |

## Docker 部署

需要一台 Linux 主机、Docker Engine、Docker Compose v2，以及一个已指向主机的域名。以下示例使用 `scene.example.com`。

### 1. 注册 Trakt 应用

在 Trakt 的 [应用设置](https://trakt.tv/oauth/applications) 创建应用，把回调地址填为 `https://scene.example.com/api/auth/callback`，并保存 Client ID。回调地址必须和实际网站域名、HTTPS 协议一致。Scene 使用 PKCE，当前实现不需要填写 Client Secret。

### 2. 准备配置与数据目录

```sh
git clone https://github.com/shannoncheu/Scene.git
cd Scene
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
sudo install -d -m 0750 -o 1001 -g 1001 data
```

把生成的 64 位十六进制密钥填进 `TOKEN_ENCRYPTION_KEY`。其余关键配置如下：

| 配置 | 用途 |
| --- | --- |
| `APP_URL` | 生产 HTTPS 站点地址，例如 `https://scene.example.com` |
| `TRAKT_CLIENT_ID` | 上一步的 Trakt Client ID |
| `TRAKT_ALLOWED_USERNAME` | 允许登录的 Trakt 用户名 |
| `TRAKT_ALLOWED_USER_ID` | 可选，按 Trakt UUID 限制首次绑定 |
| `TOKEN_ENCRYPTION_KEY` | 令牌加密密钥，升级或恢复时保留原值 |
| `DEFAULT_TIMEZONE` | 默认 `Asia/Shanghai` |
| `TMDB_READ_ACCESS_TOKEN` | 可选，用于补齐部分作品信息 |

Compose 会把 SQLite 和附件放在宿主机的 `./data`，并仅把应用端口发布到 `127.0.0.1:4317`。

### 3. 初始化数据库并启动

```sh
docker network inspect scene_proxy >/dev/null 2>&1 || docker network create scene_proxy
docker build --target build -t scene-tools:local .
docker run --rm --user 1001:1001 \
  -e DATABASE_URL=file:/app/data/cinema.db \
  -v "$(pwd)/data:/app/data" \
  scene-tools:local npm run db:deploy

docker compose up -d --build watchlog-cinema
docker compose ps
curl -fsS -o /dev/null http://127.0.0.1:4317/login
```

工具镜像包含 Prisma CLI。应用镜像只包含运行所需文件，启动时不会自动执行迁移。Docker 构建会运行测试、类型检查和生产构建。

### 4. 配置 HTTPS

如果 Caddy 直接运行在宿主机：

```caddyfile
scene.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:4317
}
```

如果 Caddy 也在 Docker 中，将 Caddy 加入和 Scene 相同的 `scene_proxy` 网络，并使用 `reverse_proxy watchlog-cinema:3000`。已有代理网络时可在 `.env` 设置 `SCENE_PROXY_NETWORK`，并提前确认该网络已存在。然后访问 `https://scene.example.com/login`，用白名单账号授权。首次历史较多时，可在页面查看同步进度。

## 本地开发

使用 Node.js 22，复制 `.env.example` 并创建 `data` 后运行：

```sh
npm ci
npm run db:generate
npm run db:deploy
npm run dev
```

开发服务监听 `127.0.0.1:4317`。验证真实 OAuth 时仍需 HTTPS 域名和匹配的回调。运行 `npm test`、`npm run typecheck` 和 `npm run build` 检查改动。

## 更新、备份与恢复

- 更新前备份 SQLite 和用户附件，保留现用镜像。先构建新工具镜像和应用镜像，再短暂停止应用、运行 Prisma 迁移并启动。出现兼容问题时，使用匹配的旧镜像及对应的数据库备份。
- 后台会定期将备份写入 `data/backups`。备份含 SQLite 一致性快照、引用的头像和票根，以及 SHA-256 清单。海报缓存会在恢复后重新补齐。请将需要长期保留的备份和加密密钥分开保存。
- 用已构建的工具镜像执行备份命令。路径均为容器内路径。恢复命令写入新目录，验证完成后再停服务切换数据目录。

```sh
docker run --rm --user 1001:1001 --env-file .env \
  -e DATA_DIR=/app/data -v "$(pwd)/data:/app/data" \
  scene-tools:local npm run backup -- verify /app/data/backups/2026-01-01T00-00-00-000Z-example
```

将上面的命令替换为 `npm run backup -- create` 可手动备份，也可用 `npm run backup -- restore-copy /app/data/backups/2026-01-01T00-00-00-000Z-example /app/data/restored-example` 生成恢复副本。请把示例占位符替换为实际目录名。恢复会清除会话，旧 Trakt 令牌可能需要重新授权。密钥、数据库、用户图片和备份目录不应提交到仓库。

## 目录

- `src/app` · 页面和 API
- `src/components` · 档案、日期和票根组件
- `src/lib/server` · OAuth、同步、元数据和备份
- `prisma` · 数据模型和迁移
- `scripts` · 启动、备份和构建检查
