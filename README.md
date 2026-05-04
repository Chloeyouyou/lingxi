# 灵犀 LingXi

> 一个有温度的 AI 情感陪伴 Web 应用

灵犀是一个运行在浏览器里的 AI 伴侣，像朋友一样陪你聊天。她会听你说话、感知你的情绪状态，在你需要的时候轻柔地介入，也会在你说起愿望时为你下一场流星雨。

---

## 它解决了什么问题

很多人在深夜或低谷时刻，需要的不是建议，而是一个真正在听的人。灵犀不打官腔、不给方案，她用具体的、贴近生活的方式引导你把感受说出来。

- 你不需要注册账号，打开就能聊
- 你的对话记忆跨会话保留，下次回来她还记得你
- 她不会一直追问，也不会在你沉默时让你难受
- 当情绪积累到一定程度，她会主动提出换一种方式陪你

---

## 功能概览

### 💬 对话
- 基于 DeepSeek 的流式对话，低延迟逐字输出
- 跨会话记忆：对话存入 Cloudflare D1，下次打开自动加载最近 50 条
- URL 识别：粘贴链接后自动读取页面内容并注入上下文
- 支持清空记忆，从头开始

### 🎙️ 语音
- 语音输入（Web Speech API，中文识别）
- AI 回复自动朗读（Coze TTS，声线柔和；失败时回退到浏览器 speechSynthesis）
- 可随时关闭自动朗读

### 🖼️ 情绪配图
- AI 回复中携带 `[SKETCH: 主体 | 情绪]` 标记，系统自动从本地照片库按情绪匹配图片
- 图片来源为实拍地点（关中书院、兴庆宫、兵马俑、陕历博等 23 处）
- 每 3 条回复出现一次，不打扰节奏

### 🌡️ 压力感知与主动干预
- AI 每条回复附带压力评分 `[STRESS:X]`（0–10），系统按公式累积
- 累积值达到阈值时，灵犀主动弹出干预卡片，提供两种陪伴路径
- 干预后进入"继续说说"模式，连续 3 条低压力回复后平稳退出

### 🌠 流星雨 × 愿望罐
- 用户说出愿望类语义（"好想""要是能""多希望"等）时，灵犀回复后弹出许愿卡片
- 许愿触发一场流星雨动画，诗句随流星落下
- 许完愿后，灵犀根据当前对话上下文生成一句她自己的愿望
- 愿望存入 D1 数据库，点击小狗旁的愿望罐可查看历史，实现了可以自己点亮 ✦

### 🐕 小狗伙伴
- 场景中有一只会走动的小白狗，随机游荡、坐下、追着鼠标跑
- 双击任意位置可暂停/恢复它的运动
- 点击小狗可触发愿望罐或随机显示一句陪伴话语

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | 纯 HTML/CSS/JS，无框架，单文件 |
| AI 对话 | [DeepSeek](https://platform.deepseek.com/) `deepseek-chat`，SSE 流式 |
| 语音合成 | [Coze TTS](https://www.coze.cn/) API + Web Speech API 兜底 |
| 网页阅读 | [Jina AI Reader](https://jina.ai/) `r.jina.ai` |
| 图片生成 | 本地照片库（情绪匹配），备用接口 Stability AI |
| 代理层 | [Cloudflare Workers](https://workers.cloudflare.com/)（隐藏所有 API Key） |
| 数据库 | [Cloudflare D1](https://developers.cloudflare.com/d1/)（SQLite，对话记忆 + 愿望罐） |
| 部署 | GitHub Pages（前端）× Cloudflare Workers（后端） |

---

## 快速开始

### 前置条件

- [Node.js](https://nodejs.org/) ≥ 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)：`npm install -g wrangler`
- Cloudflare 账号（免费套餐即可）
- DeepSeek API Key、Coze Personal Access Token、Jina API Key

### 1. 克隆仓库

```bash
git clone https://github.com/YOUR_USERNAME/lingxi-website.git
cd lingxi-website
```

### 2. 登录 Cloudflare

```bash
wrangler login
```

### 3. 创建 D1 数据库

```bash
wrangler d1 create lingxi-db
```

将输出的 `database_id` 填入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "lingxi-db"
database_id = "YOUR_D1_DATABASE_ID"
```

### 4. 配置 API 密钥（不进入代码，安全）

```bash
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put COZE_TTS_TOKEN
wrangler secret put JINA_KEY
wrangler secret put STABILITY_KEY   # 可选
```

### 5. 配置允许的前端域名

打开 `worker.js`，在 `ALLOWED_ORIGINS` 数组中加入你的 GitHub Pages 地址：

```js
const ALLOWED_ORIGINS = [
    'https://YOUR_GITHUB_USERNAME.github.io',
    'http://localhost:5500',
    // ...
];
```

### 6. 部署 Worker

```bash
wrangler deploy
```

记录输出的 Worker URL，例如 `https://lingxi-proxy.YOUR_SUBDOMAIN.workers.dev`。

### 7. 配置前端

打开 `index.html`，将第 609 行的 `API_URL` 替换为你的 Worker URL：

```js
const API_URL = 'https://lingxi-proxy.YOUR_SUBDOMAIN.workers.dev';
```

### 8. 部署前端

推送到 GitHub，在仓库 Settings → Pages 中选择 `main` 分支部署即可。

```bash
git add index.html worker.js wrangler.toml
git commit -m "deploy: configure for production"
git push origin main
```

### 本地预览

用 VS Code Live Server（端口 5500）或任意静态服务器打开 `index.html` 即可，Worker 已将 `http://localhost:5500` 列入白名单。

---

## D1 数据库结构

```sql
-- 对话记忆
CREATE TABLE messages (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT    NOT NULL,
    role    TEXT    NOT NULL,  -- 'user' | 'assistant'
    content TEXT    NOT NULL,
    ts      INTEGER NOT NULL
);

-- 愿望罐
CREATE TABLE wishes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT    NOT NULL,
    wish_text  TEXT    NOT NULL,
    lit        INTEGER NOT NULL DEFAULT 0,  -- 0=未实现 1=已点亮
    created_at INTEGER NOT NULL
);
```

表在首次请求时自动创建（`CREATE TABLE IF NOT EXISTS`），无需手动初始化。

---

## Worker API 路由

| 路由 | 说明 |
|------|------|
| `POST /` 或 `/chat` | DeepSeek 流式对话代理 |
| `POST /tts` | Coze TTS 语音合成代理 |
| `POST /jina` | Jina AI 网页阅读代理 |
| `POST /image` | Stability AI 图片生成代理 |
| `POST /db/save` | 保存一条消息到 D1 |
| `POST /db/history` | 读取最近 50 条消息 |
| `POST /db/clear` | 清空该用户全部消息 |
| `POST /db/wish/save` | 保存一条愿望 |
| `POST /db/wish/list` | 读取该用户全部愿望 |
| `POST /db/wish/toggle` | 切换愿望点亮状态 |

所有路由均通过 `ALLOWED_ORIGINS` 白名单做来源校验，API Key 不暴露给前端。

---

## AI 生成说明

本项目在开发过程中使用了 AI 辅助：

- 部分代码逻辑（流式 SSE 解析、Canvas 粒子动画、压力感知算法）由 Claude（Anthropic）协助编写和调试
- 系统 Prompt（`SYSTEM_PROMPT`）由人工撰写，结合了心理陪伴、非暴力沟通等理念，Claude 参与了迭代优化
- 项目整体架构、产品设计、交互细节、文案均由人工主导
- 本地照片素材为作者实地拍摄

---

## 目录结构

```
lingxi-website/
├── index.html          # 完整前端（UI + 所有功能逻辑）
├── worker.js           # Cloudflare Worker（API 代理 + D1 操作）
├── wrangler.toml       # Worker 配置
├── xg.png              # 小狗吉祥物图片
├── images/             # 本地情绪配图（l{位置}_{编号}.jpg）
└── submission/         # 去除敏感信息的参赛提交版本
```

---

## License

MIT
