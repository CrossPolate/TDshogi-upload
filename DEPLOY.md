# TDShogi 部署说明

本平台是**单进程 Node.js 常驻服务**（Express REST + ws WebSocket 同端口），依赖：
- 常驻进程（对局状态、WebSocket 长连接、棋钟 tick）
- 可写文件系统（`data/` 目录落盘棋谱、会话、评级）
- Node.js 22+ 运行时（better-sqlite3 v13 硬性要求，npm install 会因 engines 不符直接报错）

> ⚠️ 因此它**不是纯静态站**，部署目标必须是能运行 Node.js 常驻进程的服务器（云主机 / VPS / Docker / PaaS）。

---

## 一、要传哪些文件（部署包清单）

> **不用手动挑文件**：跑 `npm run pack` 会把下面的清单自动同步到 **`github-upload/`**（目录形式，
> **不是压缩包**）——整目录拖到 GitHub、或用 scp/rsync 传到服务器即可。
> 清单只维护在 `scripts/pack.js` 一处，改完代码重新跑一次就同步：
> `npm run pack`（同步）/ `npm run pack -- --check`（只校验一致性）。
> 手抄清单最典型的事故是**漏掉新增文件**，而漏掉的多半正是服务端启动时要 `require` 的那个。

**必传（应用代码 + 依赖清单）：**

```
tdshogi/
├── package.json          # 依赖声明与 npm start 脚本
├── package-lock.json     # 锁定依赖版本（保证可复现）
├── .npmrc                # better-sqlite3 预编译包镜像（服务器免编译工具链）
├── server.js             # 服务端入口
├── src/                  # 服务端逻辑（18 个模块，全部需要）
│   ├── protocol.js  rooms.js  game.js  coords.js   # 对局核心
│   ├── auth.js  accounts.js  ratings.js  records.js
│   ├── kif.js  storage.js  tournaments.js
│   ├── announcements.js  admin.js
│   ├── net.js  audit.js  privacy.js                # 连接信息 / 审计日志 / 隐私脱敏
│   ├── ratelimit.js                                # 接口与 WS 速率限制
│   └── backup.js                                   # SQLite 自动备份（VACUUM INTO）
├── public/               # 前端（静态资源，全部需要）
│   ├── *.html            # 9 个页面
│   ├── css/              # style.css board.css review.css
│   ├── js/               # 18 个脚本（统一棋盘 freeboard.js/board.js、设置面板 settings.js、棋子映射 piece-kinds.js）
│   └── pieces/           # 棋子图片 kinki.png ryoko.png
├── DEPLOY.md             # 本文件（可选）
└── README.md             # （可选）
```

**选传：**

```
├── scripts/              # 批量导入 KIF 的工具（非运行时必需）
└── data/                 # 已有数据（如迁移旧服务器，可带上保留棋谱/用户）
```

**绝对不传：**

```
❌ node_modules/           # 服务器上 npm install 重新生成
❌ 参考文件/               # 你的本地参考项目，无部署价值
❌ 棋子素材/               # 素材原图（public/pieces 已有）
❌ .playwright-cli/       # E2E 测试缓存
❌ .codebuddy/            # 本机工具数据
❌ srv.log srv.err 等日志
```

**如何在服务器上准备（Linux 示例）：**

```bash
# 1. 上传上述文件到服务器（如 scp / rsync / 宝塔面板 / Git）
rsync -av --exclude 'node_modules' --exclude '.playwright-cli' \
      --exclude '参考文件' --exclude '棋子素材' --exclude '.codebuddy' \
      ./ user@server:/opt/tdshogi/

# 2. 服务器上安装依赖（仓库自带 .npmrc，无需任何 C++ 编译工具链）
cd /opt/tdshogi
npm ci --omit=dev

# 2.5 验证依赖健康（应输出 sqlite OK）
node -e "const db=require('better-sqlite3')(':memory:');db.exec('create table t(a)');console.log('sqlite OK')"

# 3. 配置环境变量（推荐）
export PORT=3000
export DATA_DIR=/var/lib/tdshogi        # 持久数据目录（可选，默认 ./data）
export ADMIN_PASSWORD=你的强密码        # 管理员登录密码（不设置则使用内置密码 Cplusplus123）
export ADMIN_SECRET=随机长字符串        # token 签名密钥（不设置则从管理密码派生）
export TRUST_PROXY=1                    # 走 Nginx 反代时必配（1 层），否则记录到的 IP 是 127.0.0.1
export ADMIN_ENTRY_KEY=随机长字符串     # 可选：隐藏管理后台入口（见下）
export LOG_LEVEL=info                   # 日志级别 debug|info|warn|error（默认 info，见「五、日志与排障」）
export LOG_FORMAT=text                  # 日志格式 text|json（默认 text；接入日志系统时可设 json）

# 4. 启动
npm start
```

**管理后台入口（普通用户不可见）：**

- 导航栏的 🛡️ 入口**仅在本机已登录过管理员时显示**（token 存于该浏览器的 localStorage），
  普通用户任何页面都看不到入口。
- 管理员自己直接访问 `/admin.html` 即可进入登录页。
- 更隐蔽：设置 `ADMIN_ENTRY_KEY` 后，访问 `/admin.html` 必须带 `?k=<ADMIN_ENTRY_KEY>`
  （如 `https://站点/admin.html?k=你的key`），否则返回 404——连后台存在都不暴露。
  该 key 只用于"找到页面"，登录仍需管理密码（服务端 `admin.verify` 鉴权不变）。

**用 PM2 保持常驻：**

```bash
npm install -g pm2
pm2 start server.js --name tdshogi --env production
pm2 save && pm2 startup
```

**用 systemd（可选）：**

```ini
# /etc/systemd/system/tdshogi.service
[Unit]
Description=TDShogi shogi server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/tdshogi
Environment=PORT=3000
Environment=DATA_DIR=/var/lib/tdshogi
Environment=ADMIN_PASSWORD=你的强密码
ExecStart=/usr/bin/node server.js
Restart=on-failure
User=www-data

[Install]
WantedBy=multi-user.target
```

**用 Docker（可选）：**

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY server.js src/ public/ ./
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
```

```bash
docker build -t tdshogi .
docker run -d --name tdshogi -p 3000:3000 \
  -v tdshogi-data:/app/data \
  -e ADMIN_PASSWORD=你的强密码 \
  tdshogi
```

**Nginx 反代（WebSocket 必须）：**

```nginx
server {
    listen 80;
    server_name shogi.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # WebSocket 升级
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }
}
```

---

## 二、能否用 EdgeOne Pages 部署？

**结论：当前架构（单进程常驻 Node + WebSocket + 文件落盘）不能直接部署在 EdgeOne Pages 上。**

原因如下：

| 需求 | TDShogi 需要 | EdgeOne Pages 提供 |
|------|-------------|---------------------|
| 常驻进程 | 服务端维护对局状态机、棋钟 tick、WebSocket 长连接 | **Serverless/边缘函数，按请求触发，无常驻进程** |
| WebSocket | 实时对局双向推送（ws 库） | 边缘函数不支持自建 WebSocket 长连接推送（EdgeOne 的 WebSocket 是**反向代理加速**给源站，不托管运行） |
| 持久文件系统 | `data/` 落盘棋谱/会话/评级 | 函数运行环境**临时/只读**，无持久文件写入（需配合外部存储） |
| 规则引擎 | shogi.js 服务端权威判定 | 无 Node 长驻运行时 |

**能部署的部分：**
- `public/` 静态资源（HTML/CSS/JS/图片）可发布到 EdgeOne Pages 作为**静态站点**，但没有后端则无法对局、登录、存棋谱。

**如果一定要上 EdgeOne，需要重构：**
1. 把规则引擎 + 对局状态迁移到**云函数**（按走子请求触发）
2. 对局状态存**内存共享 / Redis / EdgeOne KV**
3. WebSocket 改为**长轮询 / SSE / EdgeOne 专属通道**
4. 棋谱存对象存储或数据库
> 这是一个较大改造，**建议先上传统 Node 服务器**跑通，后续如需弹性可再演进。

---

## 三、推荐的部署目标（按成本/复杂度排序）

1. **云服务器 VPS**（腾讯云轻量 / 阿里云 ECS）— 最简单，`npm install && npm start`，配合 PM2
2. **宝塔面板**（国内方便）— 上传文件 + Node 项目管理器
3. **Docker**（任一云主机 / 容器平台）— 可移植
4. **PaaS 平台**（Railway / Render / Fly.io）— 支持常驻 Node + WebSocket + 持久卷，`DATA_DIR` 指向挂载卷

---

## 四、备份与恢复

全部数据（账号 / 游客会话 / 棋谱 / 等级分 / 赛事 / 公告 / 审计日志）都在**一个 SQLite 文件**
`<DATA_DIR>/tdshogi.db` 里。**磁盘坏了就全没了**，所以备份不是可选项。

### 4.1 自动备份（已内置，无需配置）

服务启动时自动开启每日备份（`src/backup.js`）：

- **时机**：启动时补一次（当天没备过才备，**反复重启不会重复备份**）+ 之后每 6 小时检查一次
- **位置**：`<DATA_DIR>/backups/tdshogi-YYYYMMDD-HHMMSS.db`（默认 `data/backups/`）
- **保留**：最近 14 份；另有 2GB 总量上限兜底（棋谱涨大后不会撑爆磁盘）
- **每次备份都做 `PRAGMA integrity_check`**，校验不通过的**当场删除**——
  宁可没有备份，也不要留一个坏文件让人以为安全
- 失败只写日志，**绝不影响对局服务**

> 为什么用 `VACUUM INTO` 而不是复制 `.db` 文件：数据库是 WAL 模式，数据分散在
> `.db` / `.db-wal` / `.db-shm` 三个文件里，运行中直接拷贝很可能拿到**不一致的中间状态**
> （WAL 里的新数据还没并进主库）。`VACUUM INTO` 走一次读事务取**一致性快照**，
> 服务运行中也能安全备份，且不阻塞正在进行的对局。
> （实测印证：本机源库文件 80KB，备份出来 100KB——多出的正是 WAL 里未合并的数据。）

### 4.2 手动备份（升级 / 改数据结构前**务必执行**）

```bash
npm run backup                  # 备份一次
npm run backup -- --list        # 查看已有备份
npm run backup -- --keep=30     # 本次备份后保留 30 份
```

### 4.3 恢复步骤（**照顺序做，尤其第 3 步**）

```bash
# 1. 停服务（PM2 / systemd / docker stop）
pm2 stop tdshogi

# 2. 把当前库再留一份（万一是误操作，还能回来）
mv /var/lib/tdshogi/tdshogi.db /var/lib/tdshogi/tdshogi.db.broken

# 3. ⚠️ 必须同时删掉 -wal / -shm —— 它们属于"上一条"数据库，
#    留着会让新库读到不一致的旧事务日志
rm -f /var/lib/tdshogi/tdshogi.db-wal /var/lib/tdshogi/tdshogi.db-shm

# 4. 用备份覆盖（备份是"紧凑单文件"，不需要 -wal/-shm）
cp /var/lib/tdshogi/backups/tdshogi-20260910-212104.db /var/lib/tdshogi/tdshogi.db

# 5. 启动
pm2 start tdshogi
```

**恢复后自检**：首页「最新战报」有数据 → 随便进一局复盘 → 管理员后台用户列表正常。
若用 `sqlite3` 命令行，可先 `PRAGMA integrity_check;`（应返回 `ok`）。

### 4.4 两个容易漏的点

- **`DATA_DIR` 自定义时备份目录跟着走**（`<DATA_DIR>/backups`）。别只在 `/app/data` 挂了卷、
  却把 `DATA_DIR` 指向容器内的非持久目录——那样**库和备份都会随容器销毁一起消失**。
- **备份与库在同一块磁盘上，防不了整盘损坏**。重要数据请定期把 `backups/` 里最新那份
  同步到异地（对象存储 / 另一台机器）。

---

## 五、日志与排障

服务端日志自 2026-09-12 起统一走 `src/logger.js`，不再散落 `console.*`（PLAN §P4）。

**默认格式**（text，带时间戳与级别）：

```
20:41:42.123 INFO  [rooms] 房间 abc123 (XYZ789) 销毁 (leave) roomId=abc123 reason=leave
20:41:45.900 ERROR [storage] 写入 kv 失败 err="磁盘满了"
    at Storage.write (/opt/tdshogi/src/storage.js:191:9)
```

**两个环境变量**：

| 变量 | 取值 | 用途 |
|---|---|---|
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error`（默认 `info`） | 排障时临时调 `debug` 看细节 |
| `LOG_FORMAT` | `text`（默认）/ `json` | `json` 时每行一个 JSON 对象，便于交给日志系统或结构化检索 |

**告警分流**：`warn` / `error` 写 **stderr**，`debug` / `info` 写 **stdout**。所以推荐这样收集：

```bash
npm start > srv.log 2> srv.err      # srv.err 里只有告警与异常，一眼可见
```

**requestId 排障法**：每个 HTTP 请求都会分配一个 8 位短 id，随响应头 `X-Request-Id` 返回
（管理写接口报 500 时，响应体里也会带 `requestId`）。让用户报障时把该 id 给你，
直接定位到那一次请求的日志：

```bash
grep 'a1b2c3d4' srv.log srv.err
```

不必再靠"大概几点几分出错"去反推。前端在浏览器开发者工具的 Network 面板里即可看到
`X-Request-Id` 响应头。

### 前端调试日志（`window.debugLog`）

浏览器端也有对应的调试日志（定义在 `js/util.js`，9 个页面全部已加载），**默认关闭**：

| 开启方式 | 场景 |
|---|---|
| 访问带 `?debug=1` 的地址 | 排障时直接发这个链接给用户，最快 |
| 控制台执行 `debugLog.enable()` | 已在页面上时随时打开（会记住，刷新仍生效；`debugLog.disable()` 关闭） |
| `window.TDSHOGI_DEBUG = true` | 自动化测试预置 |

开启后输出形如 `12:34:56.789 DEBUG [play] state 到达 {...}`，**与服务端 text 日志同格式**，两端可对照着看。

**让用户报障时多跑一句 `copy(debugLog.dump())`**，把最近 200 条日志整段贴给你——
比"截图 + 描述现象"精确得多。
