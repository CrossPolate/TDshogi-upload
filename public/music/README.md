# public/music/ — 对局 BGM 素材（可选）

**本目录默认不带任何音频文件。** 这样做是为了把仓库体积从 ~27MB 压回几百 KB：
BGM 属于「锦上添花」的素材，不该成为 clone / 打包 / 部署的门槛。

## 缺失时的行为（重要）

`public/js/sound.js` 对 BGM 做了**合成兜底**：

1. 设置里选了某首 BGM（如 `file:loop`）→ 先尝试播放 `music/loop.mp3`；
2. 文件缺失（404）、解码失败或自动播放被拦 → **自动降级为 Web Audio 实时合成的
   ambient pad**（按曲名取和声，见 `sound.js` 的 `padPalette`），对局照常有背景音；
3. 连 `AudioContext` 都没有（老浏览器 / 测试环境）→ 静默跳过，**绝不报错**。

也就是说：**没有 mp3 = 没有 404 报错、没有功能残缺，只是音色从素材换成合成**。

## 想换回真实音频？

把 mp3 放进来即可，文件名与 `public/js/settings.js` 里 `bgm` 的选项值一致：

| 设置值 | 期望文件 |
| --- | --- |
| `file:loop` | `public/music/loop.mp3` |
| `file:制勝` | `public/music/制勝.mp3` |
| `file:深层沉浸` | `public/music/深层沉浸.mp3` |
| `file:空弦` | `public/music/空弦.mp3` |
| `file:静弈` | `public/music/静弈.mp3` |

放入后**无需改代码**：`sound.js` 优先用素材，失败才走合成兜底。
