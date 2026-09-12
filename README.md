# TDShogi 在线将棋对战平台

轻量级在线将棋对战平台，参考 [81Dojo](https://81dojo.com) 与 [lishogi](https://lishogi.org) 的功能形态设计。
**Node.js + Express + ws 单进程**，数据落在单一 SQLite 库，棋子使用自定义木棋子图片素材（`public/pieces/`）。

## 特性

**对局**
- 游客免注册即可开局（`localStorage` 持久化），可在个人页注册账号保留数据（游客升级自动迁移对局/评级/棋谱）
- 账号系统：用户名 + 密码（scrypt 加盐哈希 + HMAC 会话令牌）
- 在线人人对战（**服务端权威规则判定**）+ 实时观战 + 随机观战
- 好友房间（6 位房间码）+ 快速匹配 + 房间聊天
- 四种时制：`10:00`（10 分包干）/ `15+60` / `10+30` / `10sec`（0+10 每手读秒）
- 终局自动进入**感想战**：按规则推演、分支变化、待った、演示权交接、自由摆棋
- 断线 60 秒重连宽限；中途退出/掉线判负并标记 `接続切断`

**棋谱**
- 自动保存，支持**日本标准 KIF / CSA** 导出（含每手耗时；KIF 带手数评论）、KIF 批量导入
- 复盘器：日式/USI 切换、书签、评论、变着、自由摆放
- **棋谱广场**：管理员可将棋谱设为公开（赛事名局等），访客免登录浏览与复盘

**社区与运营**
- ELO 评级（起始 1500，K=32）+ 排行榜
- **等级系统**：每日登录 +2 经验、完成一局 +1；`L→L+1` 需 `2^(L+1)` 经验（0→1:2、1→2:4…），封顶 64 级
- 单败淘汰赛事（4/8/16 人）+ 创建审核流
- 选手信息悬停小窗、用户称号
- **管理后台**：用户管理（登录 IP/UA、封禁、改名、重置 ELO/密码、编辑资料、删除账号）、
  赛事审核、棋谱导入、对局信息与评论编辑、操作审计
- 移动端适配（棋盘竖排、触控拖拽、尺寸自适应）

## 目录结构

```
shogiwebapp/
├── package.json / package-lock.json
├── server.js                  # 入口：Express(REST) + ws 同端口
├── src/                       # 服务端 16 模块（CommonJS）
│   ├── storage.js             # SQLite 存储层（kv/records/sessions/gamesnapshots）
│   ├── rooms.js               # ★ 对局状态机：房间/匹配/棋钟/观战/聊天/快照/感想战
│   ├── protocol.js            # WS 消息路由 + REST 数据聚合
│   ├── game.js                # 规则引擎封装（shogi.js + 王手过滤/升变/判定）
│   ├── coords.js              # USI 坐标 ↔ shogi.js (x,y)
│   ├── records.js             # 棋谱读写 + KIF/CSA 导出 + 复盘标注 + 公开广场
│   ├── kif.js                 # KIF 解析（导入）
│   ├── ratings.js             # ELO 评级 + 等级（exp/level）
│   ├── tournaments.js         # 单败淘汰赛事
│   ├── accounts.js            # 账号（注册/登录/令牌/升级迁移）
│   ├── auth.js                # 游客会话（kv sessions/<id>.json）
│   ├── admin.js               # 管理员鉴权（HMAC 令牌）
│   ├── announcements.js       # 系统公告
│   ├── net.js                 # 客户端 IP/UA 解析（反代信任）
│   ├── audit.js               # 登录与管理员操作事件日志
│   ├── privacy.js             # 隐私字段出口白名单（stripPrivate）
│   └── ratelimit.js           # 内存限流：登录防爆破 / REST 防刷 / WS 防洪泛（§Q7）
├── public/                    # 前端（静态，无构建步骤）
│   ├── index/lobby/play/history/gallery/review/tournaments/profile/admin .html
│   ├── css/                   # style.css（主题+响应式）/ board.css / review.css
│   ├── pieces/                # 木棋子图片素材（kinki.png / ryoko.png）
│   └── js/                    # 18 个脚本
│       ├── settings.js        # ★ 用户设置中心（单一 tdshogi_settings 键 + ⚙️ 面板，须先于 nav.js 加载）
│       ├── api.js nav.js board.js pieces.js piece-kinds.js
│       ├── freeboard.js       # ★ 统一棋盘组件（play/demo-rules/free/review 四模式）
│       ├── home lobby play history gallery review tournaments profile admin .js
│       ├── hovercard.js sound.js
├── tests/                     # 单元测试（node --test，纯函数、不起服）
├── scripts/                   # e2e 回归套件与工具脚本（需起服）
└── data/                      # 运行时生成（gitignore）：tdshogi.db
```

## 快速开始

```bash
npm install
npm start          # 默认 http://localhost:3000
npm run dev        # --watch 自动重启
npm test           # 单元测试（纯函数，无需起服）
npm run lint       # eslint 静态检查
```

环境要求：**Node.js 22+**（better-sqlite3 v13 硬性要求）。无需 C++ 编译工具链——
仓库根 `.npmrc` 的 `ignore-scripts=true` 阻止 npm 对自带预编译二进制的包做无谓的 `node-gyp rebuild`。

若 `npm install` 报 node-gyp / gyp ERR，检查 `.npmrc` 是否被改坏；验证依赖健康：

```bash
node -e "const db=require('better-sqlite3')(':memory:');db.exec('create table t(a)');console.log('sqlite OK')"
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | 监听端口 |
| `DATA_DIR` | `./data` | 数据目录（部署请指向持久目录） |
| `ADMIN_PASSWORD` | `Cplusplus123` | 管理密码（**务必修改**） |
| `ADMIN_SECRET` | 由密码派生 | 管理员令牌签名密钥 |
| `SESSION_SECRET` | 内置 | 账号会话令牌签名密钥 |
| `SNAPSHOT_INTERVAL_MS` | 30000 | 对局快照间隔 |
| `TRUST_PROXY` | `0` | 反代层数（`1`=一层 Nginx，`true`=全信任）。**走反代必须配，否则 IP 全是 127.0.0.1** |
| `ADMIN_ENTRY_KEY` | 空 | 设置后 `/admin.html` 需带 `?k=<key>`，否则 404（隐藏后台入口） |
| `AUDIT_MAX_EVENTS` | 5000 | 事件日志容量上限 |
| `AUDIT_RETENTION_DAYS` | 90 | 事件日志保留天数 |

## 部署

支持 PM2 / systemd / Docker / Nginx 反代，详见 `DEPLOY.md`。要点：

- **单文件备份**：复制 `data/tdshogi.db` 即可还原全部数据
- **WebSocket 需反代放行**：Nginx 要带 `Upgrade` / `Connection` 头
- **走反代必配 `TRUST_PROXY=1`**，并加 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
- **服务端任何改动都必须重启进程**，前端静态资源已设 `no-cache` 协商缓存
- **部署上传区**：`npm run pack` 把要传的文件同步到 **`github-upload/`**（目录，不是压缩包）——
  整目录拖到 GitHub 或 scp 到服务器即可，改完代码重新跑一次就同步：
  ```bash
  npm run pack            # 同步上传区（先清空再复制）
  npm run pack -- --check # 只校验：对比源码与上传区是否一致，不写入
  ```
  内容严格按部署清单（`package.json` / `package-lock.json` / `.npmrc` / `server.js` /
  `DEPLOY.md` / `README.md` / `src/` / `public/`），清单**只维护在 `scripts/pack.js` 一处**。
  手抄清单的典型事故是漏掉新增文件，而漏掉的多半正是服务端启动时 `require` 的那个。

## REST API（主要）

| 路径 | 方法 | 说明 |
|---|---|---|
| `/api/home` `/api/lobby` | GET | 首页 / 大厅数据（含 version，排障可查进程版本） |
| `/api/history?player=` | GET | 自己的棋谱 + 广场公开棋谱 |
| `/api/gallery?q=&tag=&page=` | GET | 棋谱广场（公开棋谱列表） |
| `/api/records/:id/playback` `/review` | GET | 回放 / 完整复盘数据（公开谱免登录） |
| `/api/records/:id/export?fmt=kif\|csa` | GET | 导出（KIF 含手数评论） |
| `/api/records/:id/{bookmark,comment,variation}` | POST | 写标注（评论支持编辑/删除，公开谱仅管理员） |
| `/api/records/search` | GET | 棋谱检索（按选手/手数/结果/开局） |
| `/api/tournaments` | GET | 赛事列表（已过滤未审核/已拒/已取消） |
| `/api/profile?player=` | GET | 个人战绩与等级 |
| `/api/register` `/api/login` `/api/me` | POST/GET | 账号体系 |
| `/api/account/profile` | GET/POST | 本人资料（手机号私密/棋风） |
| `/api/player-card?id=` | GET | 选手信息卡（公开，不含手机号/IP） |
| `/api/admin/users[/:id]` | GET | 用户列表 / 详情（含登录 IP、封禁状态、登录记录） |
| `/api/admin/users/:id/{ban,unban,rename,reset-rating,reset-password,profile,elo}` | POST | 用户管理（全部写审计） |
| `/api/admin/users/:id` | DELETE | 删除账号（需确认） |
| `/api/admin/records/:id/{visibility,meta}` | POST | 棋谱公开设置与对局信息编辑 |
| `/api/admin/{tournaments,audit}` | GET | 赛事全量 / 操作审计 |
| `/api/admin/records/import` | POST | 导入 KIF |

## WebSocket 协议

连接：`ws://<host>/ws?guest=<guestId|accountToken>`

客户端消息：`create_room` `join_room {code}` `quick_match` `cancel_match` `move {usi}` `resign`
`rematch` `leave` `chat {text}` `rename {name}` `spectate {roomId}` `random_spectate`
`join_tournament_match` `create_tournament` `join_tournament` `admin_login {password}`
`request_state {roomId?}`；终局后 `demo_move {usi,index}` `demo_undo` `demo_claim` `demo_transfer`
`demo_reset` `demo_legal {index}` `demo_enter`。

服务端消息：`hello` `matched` `room_created` `room_joined` `game_start` `state` `clock` `move_invalid`
`game_over` `elo_updated` `spectator_update` `chat` `tournament_update` `renamed` `spectating`
`demo_state` `demo_init` `admin_logged_in` `error`。

## 棋谱格式

严格遵循日本标准（KIF 2.0 / CSA V2.2），每手记录耗时，KIF 额外导出手数评论（`*` 注释行）：

```
#KIF version=2.0 encoding=UTF-8
開始日時：2026/09/07 19:20
場所：天锻将棋道场
持ち時間：10分
手合割：平手
先手：Sente
後手：Gote
手数----指手---------消費時間--
1   ７六歩(77)   (0:3/0:0:3)
*opening note
2   ３四歩(33)   (0:5/0:0:8)
まで2手でSenteの勝ち
```

## 数据存储

单一 SQLite 库 `data/tdshogi.db`（WAL 模式，`storage.js` 提供 kv 兼容层）：

- `kv`：评级 / 账号 / 赛事 / 公告 / 会话（`sessions/<id>.json`）/ 管理配置 / 事件日志（`events/<ts>-<rand>`）
- `records`：每局棋谱。`data` 列存完整 JSON（局面、走法、耗时、书签/评论/变着、可见性与展示 meta），
  另有**标量摘要列**（playerB/playerW/nameB/nameW/result/moveCount/opening/pub/…）+ 索引——
  列表与检索只读摘要列、不解析整谱（老库首次启动自动补列与回填）
- `gamesnapshots`：进行中对局快照，重启自动恢复未完成对局

首次启动会把旧版 JSON 迁移入库并改名 `.bak`。

## 开发与测试

- **单元测试**：`npm test`（`tests/*.test.js`，Node 内置 `node --test`，纯函数不需起服）。
  当前 **34 项**：棋种映射（含"吃馬得角"回归）、FreeBoard 模型变换与视角切换、坐标换算、初始盘面，
  以及 `game.js` 规则引擎 14 项（开局合法着法 30、王手放置禁止、升变区、吃子进驹台…）
- **静态检查**：`npm run lint`（eslint；`no-undef` 正是"路由层漏 require 导致接口 500"那类事故的克星）
- **CI**：`.github/workflows/ci.yml`（语法检查 + lint + 单测 + e2e 冒烟）
- **e2e 回归**：`scripts/e2e-*.js`（10 套件），需先起服再跑；由维护者手工执行
- **文档**：`docs/PLAN.md`（路线图）/ `docs/ARCHITECTURE.md`（架构）/ `docs/UI-PAGES.md`（页面地图）

## 限制与扩展方向

限制：仅平手（无駒落ち让子）、无 AI 对战、赛事仅单败淘汰、游客 id 无密码保护。

方向：接入 USI 引擎（人机对战）、锦标赛（多轮/循环）、駒落ち、i18n、
内容运营（棋谱广场栏目化）、赛事前台与自动化、PWA。
（棋谱越权治理与接口速率限制已于 2026-09 完成，见 `docs/PLAN.md` §Q7）

## License

MIT
