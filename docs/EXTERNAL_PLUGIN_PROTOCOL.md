# PocketAgents 外部对话插件对接协议（v1）

这份文档面向**独立运行的外部辅助插件服务**（例如你的目标副驾、代码复核器、规则检查器等）。

## 一句话理解分工（两边彻底干净）

```
┌─────────────────────────────────────────┐        HTTP / SSE        ┌─────────────────────────────────────────┐
│         PocketAgents 主项目              │ ───────────────────────► │           你的外部插件服务               │
│  · 设置页：开关 + 插件地址 + 可选独立模型  │ ◄─────────────────────── │  · 核心大脑、提示词、审核策略、私有记忆   │
│  · 对话页：在 AI 回复正下方展示一个栏目   │   返回文字 + 快捷选项     │  · 决定展示什么内容 & 给出哪几个选项按钮  │
│  · 点选项：一键填入输入框 / 复制 / 回调   │                          │  · 随便高频改，永远不用改 PocketAgents！ │
└─────────────────────────────────────────┘                          └─────────────────────────────────────────┘
```

- **PocketAgents 不关心你的任何业务逻辑**（不知道什么是策略、记忆、规则或模式），只提供一个通用展示栏。
- **插件默认关闭**，关闭时零界面、零请求；开启后只需实现 **2 个必选接口**（另加 2 个可选增强接口）即可接入。

---

## 接口清单（最少只需实现前 2 个！）

> 如果用户在 PocketAgents 设置页填写了「访问密钥」，所有请求都会自动带上请求头：
> `Authorization: Bearer <你的密钥>`

### 1. 健康检查（必选）：`GET /health`

用于设置页点击「测试连通性」及展示插件名称。

**响应 JSON**：
```json
{
  "ok": true,
  "name": "目标副驾",
  "shortLabel": "🎯 副驾",
  "version": "1.0.0",
  "statusText": "在线 · 已就绪"
}
```
- `name`：显示在设置页的状态栏；
- `shortLabel`：显示在聊天输入框旁边的迷你触发按钮上（留空则默认 `🎯 副驾`）；
- `statusText`：任何你想展示给用户的简短状态说明。

---

### 2. 生成对话下方展示栏（必选）：`POST /api/panel`

每当 **AI 回合完成**（`event: "task_completed"`）或 **用户手动点击对话按钮**（`event: "manual_trigger"`）时，PocketAgents 会把当前会话上下文发给你的插件。

#### 请求体（PocketAgents 发给你）
```json
{
  "event": "task_completed",
  "hostId": "macbook-air",
  "hostName": "MacBook Air",
  "agentId": "conv-abc123",
  "sessionTitle": "修复登录超时",
  "harness": "antigravity",
  "project": "pocketagents",
  "cwd": "/Users/dev/pocketagents",
  "lastOutput": "AI 最新一条回复正文（最多 6000 字）...",
  "recentTurns": [
    { "role": "user", "text": "帮我排查登录偶发超时" },
    { "role": "assistant", "text": "已定位到连接池..." }
  ],
  "pendingApprovals": [
    { "code": "A1B2", "title": "npm test", "riskLevel": "L1" }
  ],
  "llmConfig": {
    "provider": "openai_compat",
    "model": "deepseek-v4-1-flash",
    "baseUrl": "https://...",
    "apiKey": "仅当用户在设置中主动勾选复用模型池且插件在 127.0.0.1 本机时才会附带"
  }
}
```
> **关于 `llmConfig`**：默认不传（推荐插件自己管理模型与密钥）；只有用户在设置页主动选中了某个全局模型池供应商 **且** 插件地址为 `127.0.0.1 / localhost / ::1` 本机回环时，才会安全附带。

#### 响应体（你返回给 PocketAgents）
如果本轮不需要展示任何内容，直接返回 `{ "ok": true, "panel": null }` 即可（界面不打扰）。

需要展示时返回：
```json
{
  "ok": true,
  "panel": {
    "id": "pnl_001",
    "title": "🎯 副驾建议",
    "badge": "建议补测",
    "tone": "info",
    "subtitle": "耗时 1.1s",
    "thinking": "（可选）思考过程或核对细节，展示在可折叠代码块中",
    "thinkingCollapsed": false,
    "body": "主文结论：核心改动清晰，但缺少异常超时分支的单元测试，建议让 AI 顺手补全。",
    "tags": ["边界检查", "缺少单测"],
    "options": [
      {
        "id": "opt_test",
        "label": "补全超时单测",
        "style": "primary",
        "kind": "fill",
        "text": "请针对连接超时的异常分支补全单元测试，并跑一遍确认全部通过。"
      },
      {
        "id": "opt_ship",
        "label": "直接部署",
        "style": "default",
        "kind": "fill",
        "text": "改动没问题，直接构建部署吧。"
      },
      {
        "id": "opt_note",
        "label": "给副驾纠偏",
        "style": "ghost",
        "kind": "callback",
        "actionId": "feedback",
        "inputPlaceholder": "输入你希望副驾记住的规则或意见…",
        "payload": { "round": 1 }
      }
    ]
  },
  "notify": {
    "title": "🎯 副驾提醒 · 修复登录超时",
    "body": "缺少异常超时单测，点开一键填入建议回复"
  }
}
```

#### `panel` 字段说明（全部可选，传什么画什么）
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `title` | `string` | 展示栏左上角标题 |
| `badge` | `string` | 状态小胶囊文字 |
| `tone` | `string` | 胶囊配色：`neutral` / `info`（蓝）/ `success`（绿）/ `warning`（琥珀）/ `danger`（红） |
| `subtitle` | `string` | 右侧灰字补充信息（如耗时、模型名） |
| `thinking` | `string` | 可选：详细思考/分析正文，支持一键「展开/收起详情」 |
| `thinkingCollapsed` | `boolean` | 默认是否收起 `thinking`（默认 `false` 展开） |
| `body` | `string` | 展示栏主正文（支持多行换行） |
| `tags` | `string[]` | 可选：底部小标签胶囊数组（最多 8 个） |
| `options` | `Option[]` | **核心：快捷选项按钮数组（最多 8 个）**，见下表 |
| `notify` | `{ title, body }` | 可选：仅在后台 `task_completed` 触发时生效，PocketAgents 会同时通过 Safari Web Push 与 iOS 原生 APNs 推到手机锁屏 |

#### `options` 按钮支持 4 种动作（`kind`）
| `kind` | 用户点击后发生什么 | 必填字段 |
| :--- | :--- | :--- |
| **`fill`** *(默认)* | **一键填入 PocketAgents 聊天输入框**并聚焦（用户可改字再发） | `label`, `text` |
| **`copy`** | 一键复制到手机剪贴板 | `label`, `text` |
| **`send`** | 不经修改，直接把 `text` 发给当前 AI 会话 | `label`, `text` |
| **`callback`** | 回传给你的插件 `POST /api/action`；如果配了 `inputPlaceholder`，会先在展示栏内弹出单行输入框让用户填一句再发给你 | `label`, `actionId`（可选 `payload`, `inputPlaceholder`） |

按钮外观 `style` 支持：`primary`（蓝色主按钮）、`default`（白底描边）、`ghost`（轻量文字）、`danger`（红色警示）。

---

### 3. 流式打印思考过程（可选增强）：`POST /api/panel/stream`

如果你希望用户在手机上**实时看到副驾逐字流式思考**，可以实现这个 SSE 接口；如果没实现（返回 `404`），PocketAgents 会**自动无感降级**去调 `POST /api/panel`！

- 请求体与 `POST /api/panel` 完全一致；
- 响应头：`Content-Type: text/event-stream; charset=utf-8`；
- 按顺序输出以下 SSE 事件即可：

```text
event: status
data: {"text":"正在复核 AI 回复…"}

event: thinking
data: {"delta":"1. 先核对修改范围..."}

event: thinking
data: {"delta":"\n2. 发现缺少单测..."}

event: result
data: {"panel":{"title":"🎯 副驾建议","badge":"建议补测","tone":"info","body":"...","options":[...]}}
```
出错时发：
```text
event: error
data: {"error":"模型请求超时"}
```

---

### 4. 自定义按钮回调（可选）：`POST /api/action`

只有当你的 `options` 中包含 `kind: "callback"` 按钮时才需要实现。

- **请求体**：
  ```json
  {
    "hostId": "macbook-air",
    "agentId": "conv-abc123",
    "actionId": "feedback",
    "payload": { "round": 1 },
    "inputText": "用户在展示栏输入框里填的内容",
    "lastOutput": "当前 AI 最新回复...",
    "sessionTitle": "修复登录超时"
  }
  ```
- **响应体**：
  ```json
  {
    "ok": true,
    "toast": "已记住这条偏好",
    "fillText": "（可选）顺便填入聊天输入框的文字",
    "panel": { "...可选：更新后的展示栏对象；传 null 则收起展示栏..." }
  }
  ```

### 5. 用户插话通知（可选）：`POST /api/events/user-spoke`

用户在手机手动发送了一条消息时，PocketAgents 会静默发送 `{ hostId, agentId }`（超时 1.2s、不阻塞主流程），如果你的插件有内部状态可按需监听，不需要直接忽略即可。

---

## 最简 60 行可运行参考服务端（零依赖 Node.js）

```javascript
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT || 8789)

createServer(async (req, res) => {
  const sendJson = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(200, {
      ok: true,
      name: '我的复核副驾',
      shortLabel: '🎯 副驾',
      version: '1.0.0',
      statusText: '就绪',
    })
  }

  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = raw ? JSON.parse(raw) : {}

  if (req.method === 'POST' && req.url === '/api/panel') {
    // 在这里跑你自己的核心大脑、记忆、策略、规则……
    return sendJson(200, {
      ok: true,
      panel: {
        title: '🎯 我的复核副驾',
        badge: '有 2 个建议',
        tone: 'info',
        body: `已收到《${body.sessionTitle || '当前会话'}》的最新回复（${(body.lastOutput || '').length} 字），建议先跑回归测试再收尾。`,
        options: [
          {
            id: 'opt_1',
            label: '让 AI 补单测',
            style: 'primary',
            kind: 'fill',
            text: '请针对刚才的改动补充单元测试并验证通过。',
          },
          {
            id: 'opt_2',
            label: '直接总结提交',
            style: 'default',
            kind: 'fill',
            text: '改动符合预期，整理变更摘要并提交吧。',
          },
        ],
      },
    })
  }

  if (req.method === 'POST' && req.url === '/api/action') {
    return sendJson(200, {
      ok: true,
      toast: `已收到动作 ${body.actionId}：${body.inputText || 'OK'}`,
    })
  }

  sendJson(404, { ok: false, error: 'Not Found' })
}).listen(PORT, '127.0.0.1', () => {
  console.log(`External plugin listening on http://127.0.0.1:${PORT}`)
})
```

---

## 从旧版副驾原型迁移对照表（给已有插件服务端改代码用）

| 旧版接口 / 字段 | 新版通用协议对应改法 |
| :--- | :--- |
| `GET /health` 返回自定义计数字段 | 改成统一返回 `{ ok: true, name, shortLabel, version, statusText }`（想展示的统计信息直接拼进 `statusText`，如 `"在线 · 已就绪"`） |
| `POST /api/review` | 改路径为 `POST /api/panel`，返回值包成 `{ ok: true, panel: { title, badge, tone, thinking, body, tags, options }, notify? }` |
| `POST /api/review/stream` | 改路径为 `POST /api/panel/stream`，事件名：`status` / `thinking` / `result`（`data: {"panel": ...}`）/ `error` |
| 单条 `suggestedPrompt` 建议回复 | 改成 `options` 数组（可放 1～8 个选项，每个选项用 `kind: "fill"` 即可实现**一键填入输入框**！） |
| 各类自定义纠偏 / 深度检查 / 切换模式接口 | 全收拢进 `options` 的 `kind: "callback"` + `POST /api/action`（PocketAgents 不再硬编码任何业务按钮） |
| 独立的会话目标增删改查接口 | 会话状态与记忆由插件服务端自行管理，可通过 `options` 的 `callback` 按钮（带 `inputPlaceholder`）随时设置或修改 |

---

## 部署连通路提醒（重要！）

发起插件 HTTP 请求的是 **PocketAgents Hub 服务端**，不是手机浏览器：
1. **如果你的 Hub 在本机（`npx pocketagents`）**：插件跑在同机 `http://127.0.0.1:8789`，直接连通且支持复用本机模型池密钥；
2. **如果你的 Hub 在云端（GCE / Railway / VPS）**：
   - 把插件服务部署在**同一台云主机**上（填 `http://127.0.0.1:8789` 最快最安全，免公网暴露）；
   - 或者给插件套上 **HTTPS 公网地址**（如 Cloudflare Tunnel）并在 PocketAgents 设置页填入该地址 + **访问密钥（Bearer Token）**。
   - 出于安全原因，云元数据地址（如 `169.254.169.254`）会被 Hub SSRF 策略拦截，且非本机回环地址**永远不会透传** PocketAgents 的模型 API Key。
