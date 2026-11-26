<p align="right">
  <strong>简体中文（新手保姆级教程）</strong> · <a href="README.md">English</a>
</p>

# 口袋代理（PocketAgents）× FoloToy AI Passport 新手上手教程

把你的 **FoloToy AI Passport** 变成电脑上 Claude Code、Codex、Antigravity IDE、DeepSeek Harness 等 AI 编程助手的**随身中文遥控器**：离开工位倒水、开短会时，不用反复掏手机，抬手按一下就能审批放行、选多选题、拦下高危命令，还能长按说话查进度。

---

## 一、30 秒看懂它是怎么连起来的

```text
┌─────────────────────────┐      2.4GHz Wi-Fi      ┌────────────────────────────────┐
│  🪪 FoloToy AI Passport │  ◄──────────────────►  │  💻 你电脑上的 PocketAgents     │
│  看进度 · 审批 · 语音对讲  │                        │  自动接管 Claude / Codex / Agy  │
└─────────────────────────┘                        └────────────────────────────────┘
```

- **不需要任何第三方中转服务器**：小工牌只连你自己电脑（或自己部署的云端）上的 PocketAgents。
- **不需要在硬件上填任何大模型 API Key**：常见命令秒出中文；复杂英文多选题会自动借用你在 PocketAgents 电脑端配好的小模型翻译。

---

## 二、新手 30 秒配网（方式 A 最推荐：手机直接配 Wi-Fi，免插电脑！）

### 第 1 步：开机自动放出免密配网热点
1. 刷好固件开机后，若尚未配过 Wi-Fi（约 4.5 秒后）——或**在任意界面长按 `↑` 键 1 秒**——设备会自动放出免密临时热点 **`PocketAgents-Setup`**，屏幕上会直接显示配网步骤。
2. 此时如果还没开电脑控制台，也可以**直接按一下 `↓` 键进入「内置离线演示」**，立刻在真机上完整体验中文审批、多选题、L2 高危拦截出 3 位确认码与长按 `↓` 拒绝！

### 第 2 步：手机连热点，一页配好 Wi-Fi + PocketAgents
1. 手机 Wi-Fi 搜索并连接免密热点 **`PocketAgents-Setup`**（提示“无互联网连接”请选保留连接）。
2. 手机通常会自动弹出中文配网页；没自动弹就在手机浏览器打开 **`http://192.168.4.1`**。
3. 在网页上点选你的 **2.4GHz Wi-Fi**（不支持 5GHz）并输入密码；如果电脑已跑起 PocketAgents，顺手填入 **电脑局域网地址**（如 `http://192.168.1.25:8788`）和终端里显示的 **6 位数字配对码**（如 `482910`，无需抄长密码，设备连网后会自动换成专属 `dev_` 通行证！）。
4. 点 **`保存并连接 Wi-Fi`**，3～5 秒后小工牌自动连上网并关闭临时热点。以后想换 Wi-Fi 或补填电脑地址，**随时长按 `↑` 键**重开热点修改即可。

---

## 二（备选）、电脑端启动 PocketAgents 与 USB 一键写入（方式 B）

### 第 1 步：把「口袋代理」固件刷进 AI Passport

1. 用**支持数据传输的 USB-C 数据线**把开机的 AI Passport 插到电脑上。
2. 打开 FoloToy 社区的「口袋代理」作品页点击一键刷机，或者打开 [FoloToy 网页刷机工具](https://ai-passport.folotoy.cn/tools/web-flasher/)，选择串口（通常显示 `USB JTAG/serial debug unit`），从 `0x0` 刷入合并固件 `pocketagents-passport-merged.bin`。
3. 刷完重启后，小屏顶部显示 **`口袋代理`**，中间提示 **`正在连接 Wi-Fi...`**。

---

### 第 2 步：在电脑上启动 PocketAgents（1 条命令）

> **前提**：电脑已安装 Node.js 20+（没装可去 [nodejs.org](https://nodejs.org/) 下载安装）。

打开电脑终端（Mac 的「终端」或 Windows 的「PowerShell」）：

- **方式 A（推荐，正式版发布后一行即起）**：
  ```bash
  npx pocketagents
  ```
- **方式 B（当前体验最新 `feat/folotoy-passport` 硬件预览分支）**：
  ```bash
  git clone -b feat/folotoy-passport https://github.com/oscarka/pocketagents.git
  cd pocketagents
  node scripts/cli.mjs
  ```

启动成功后，终端会打印类似下面这样的画面（**注意看最后那一行 `🪪 AI Passport` 链接**）：

```text
🚀 PocketAgents v0.9.19 — Ready on port 8788
   💻 Host: MacBook Pro (macbook-pro)
   🔌 Synced: Claude Code (2) · Codex (1)

  📱 Phone (LAN):    http://192.168.1.25:8788/?pair=482910
  💻 This computer:  http://127.0.0.1:8788/?pair=482910
  🪪 AI Passport:    http://127.0.0.1:8788/device-setup?pair=482910
  🔑 Pair code:      482910  (valid 24h)
```

---

### 第 3 步：点开硬件配对页，填 Wi-Fi 一键写入

1. 用 **Chrome 或 Edge 浏览器**打开终端里打印的 **`🪪 AI Passport`** 链接（例如 `http://127.0.0.1:8788/device-setup?pair=482910`）。
2. 页面会**自动帮你完成两件最麻烦的事**：
   - 自动识别并填好你电脑的局域网地址（例如 `http://192.168.1.25:8788`，不会误填 `localhost`）；
   - 自动点「✨ 一键生成专属令牌」，生成一个专属 `dev_...` 设备令牌（随时可在手机端吊销）。
3. 你只需要填入你家的 **2.4GHz Wi-Fi 名称和密码**（⚠️ 不支持 5GHz Wi-Fi），然后点击绿色按钮 **`🔌 连接 USB 一键写入设备`**，在弹窗里选中 AI Passport。
4. 等待 **3～5 秒**：
   - AI Passport 屏幕顶部圆点变成 **绿色**，显示 **`已连接 · 全部就绪`**（或自动弹出待审批卡片）；
   - 网页底部第 3 步也会自动变绿提示：**`🎉 已检测到你的 AI Passport 上线！`**。
5. 现在就可以拔掉数据线，打开 Claude Code / Codex / Antigravity 跑个任务，随身体验了！

---

## 三、手动串口配网完整示例（如果你用的是 Safari 或习惯用 `tool.folotoy.cn`）

如果不用 Chrome 一键写入，也可以保持插线打开 [https://tool.folotoy.cn/](https://tool.folotoy.cn/) 连接串口，在发送框依次发送下面两行命令（按回车即永久保存，断电不丢）：

```text
pa wifi MyHome_2.4G 12345678
pa set http://192.168.1.25:8788 dev_9f8e7d6c5b4a3210
```

**怎么替换上面示例里的 4 个值？**

| 示例内容 | 替换成你的实际值 | 怎么查？ |
| :--- | :--- | :--- |
| `MyHome_2.4G` | 你家的 **2.4GHz** Wi-Fi 名称 | 路由器/手机 Wi-Fi 列表（不要选带 `5G` 的） |
| `12345678` | Wi-Fi 密码（无密码则不写） | 例如开放热点直接写 `pa wifi CoffeeFree` |
| `http://192.168.1.25:8788` | 你电脑的局域网地址 + 端口 | 直接看启动终端里的 `📱 Phone (LAN)` 前半段；Mac 也可运行 `ipconfig getifaddr en0`，Windows 运行 `ipconfig` 看 IPv4 |
| `dev_9f8e7d6c5b4a3210` | 专属设备令牌 | 打开 `http://127.0.0.1:8788/device-setup` 点一下「✨ 一键生成专属令牌」复制；或用本地 `~/.dsh/local-hub.token` 里的密码 |

> 以后换了 Wi-Fi 或电脑换了 IP，不用重新刷固件——插上线再发一次 `pa wifi` 或 `pa set` 就会直接覆盖更新。

---

## 四、3 个物理按键速查表

| 你在哪个页面 | ↑ / ↓ 短按 | OK 短按 | ↓ 长按（或双击 OK） | OK 长按 |
| :--- | :--- | :--- | :--- | :--- |
| **总览页**（已连接 · 全部就绪） | 翻看电脑上的任务列表 | 手动立即同步 / 进入待批 | — | **按住说话**（语音查进度） |
| **普通审批卡**（绿/橙框） | 切换上一条 / 下一条待批 | **放行当前操作** | **直接拒绝** | **按住说话** |
| **多选题卡**（顶部绿标「多选题」） | 上下移动高亮选项 | **确认提交选中项** | 双击 ↑ 或 OK 返回总览 | **按住说话** |
| **高危命令卡**（顶部红标「L2 高危」） | 切换卡片 | **安全拦截并显示 3 位高危码**（不会直接放行） | **直接拒绝** | **按住报出 3 位高危码**放行 |
| **语音回复页** | 短按任意键返回 | 短按返回 | — | 继续长按追问 |

---

## 五、常见问题直接对照排查

| 屏幕上看到什么 | 原因 | 怎么解决 |
| :--- | :--- | :--- |
| 一直停在 **`正在连 Wi-Fi...`** | 连到了 5GHz Wi-Fi，或 Wi-Fi 名字/密码大小写写错 | 换 2.4GHz Wi-Fi，重新在 `/device-setup` 写入或重发 `pa wifi` |
| 提示 **`控制台离线 (-1)`** | 电脑地址填了 `127.0.0.1`、电脑和设备不在同一 Wi-Fi、或 PocketAgents 没运行 | 改成 `192.168.x.x` 真实局域网 IP；确认电脑防火墙允许 Node 接收局域网连接 |
| 提示 **`认证失败 (401/403)`** | 设备令牌输错或已被吊销 | 打开 `/device-setup` 重新点「一键生成专属令牌」再写入一次 |
| 英文多选题没自动翻成中文 | 电脑端 PocketAgents 还没配 BYOK 小模型 Key | 在 PocketAgents 网页语音设置里配一个你自己的轻量模型 Key 即可（免费本地规则仍会秒翻常见命令） |
| 没买实体硬件，想先免费体验？ | 可以用开源网页硬件模拟器零硬件跑全流程 | 见下方第 6 节 |

---

## 六、没有实体设备也能玩：网页硬件模拟器一键体验

```bash
# 1. 启动自带 4 个中英文示例场景的模拟控制台
node scripts/passport-sim-hub.mjs

# 2. 启动开源网页模拟器（允许连本机局域网）
git clone https://github.com/VOID001/FoloToy-Passport-Simulator.git
cd FoloToy-Passport-Simulator
EMULATOR_NETWORK_ALLOW_PRIVATE=1 node server.mjs --port 4190 --allow-local-firmware-upload
```

浏览器打开 `http://127.0.0.1:4190` → 上传 `pocketagents-passport-merged.bin` → 在右侧「UART」输入框发送：
```text
pa set http://<你电脑局域网IP>:8787 passport-sim-demo
```
立刻就能在网页模拟器里完整体验中文审批、英文多选题自动翻译、L2 高危拦截、长按 ↓ 拒绝与语音对讲！
