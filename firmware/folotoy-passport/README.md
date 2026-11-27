<p align="right">
  <a href="README.zh_CN.md">简体中文（新手保姆级教程）</a> · <strong>English</strong>
</p>

# PocketAgents × FoloToy AI Passport — Beginner Setup Guide

Turn your **FoloToy AI Passport** into a pocket remote control for Claude Code, OpenAI Codex, Antigravity IDE, DeepSeek Harness (DSH), and WorkBuddy running on your computer. Glance at your desk status, approve routine commands, answer multiple-choice prompts, block destructive actions behind a 3-digit confirmation code, or hold OK to talk—all in a clean full-Chinese UI with 3-tier automatic translation.

## Phone Hotspot Wi-Fi Setup (Recommended — No Computer Needed to Connect Wi-Fi)

1. Boot the flashed device: if no Wi-Fi is saved (or saved Wi-Fi fails after retries), or anytime you **long-press `UP`**, AI Passport opens an open temporary hotspot **`PocketAgents-XXXX`** (e.g. `PocketAgents-A1B2`, exact name shown on screen) and displays setup steps.
2. Connect your phone to **`PocketAgents-XXXX`** and open **`http://192.168.4.1`** (usually auto-pops as a captive portal).
3. Tap your **2.4 GHz Wi-Fi** from the live scan list, enter its password, and optionally enter your PocketAgents hub URL (e.g. `http://192.168.1.25:8788`) plus the **6-character pairing code** (e.g. `MF9AJP`) shown in your terminal (automatically exchanged for a revocable `dev_` token!).
4. Tap **Verify & Connect Wi-Fi** — the device tests the Wi-Fi credentials live (up to 15s) and shows the exact reason inline if the password is wrong or a 5 GHz SSID was chosen; once connected, the temporary hotspot closes automatically.
5. Don't have PocketAgents running on a computer yet? Press **`DOWN`** on the setup screen to try the **built-in interactive offline demo** immediately!

## Alternative: 3-Step Quick Start via Computer USB (`/device-setup`)

### Step 1: Flash the Firmware
1. Connect your powered-on AI Passport to your computer with a data-capable USB-C cable.
2. Flash `pocketagents-passport-merged.bin` from `0x0` via the [FoloToy Web Flasher](https://ai-passport.folotoy.cn/tools/web-flasher/) or the FoloToy community play page.

### Step 2: Start PocketAgents on Your Computer
```bash
# Recommended (Node.js 20+):
npx pocketagents

# Or run directly from source:
git clone https://github.com/oscarka/pocketagents.git
cd pocketagents
node scripts/cli.mjs
```
The terminal automatically prints a 1-click hardware pairing URL:
```text
  🪪 AI Passport:    http://127.0.0.1:8788/device-setup?pair=482910
```

### Step 3: 1-Click USB Wi-Fi & Token Setup
1. Open the printed `/device-setup` link in **Chrome or Edge**.
2. The wizard automatically fills your computer's **LAN IP URL** (e.g., `http://192.168.1.25:8788`) and mints a revocable **`dev_...` device token**.
3. Enter your **2.4 GHz Wi-Fi name & password** (5 GHz is unsupported) and click **`🔌 连接 USB 一键写入设备`**.
4. Within 3–5 seconds, the top dot on AI Passport turns green and the wizard confirms your device is live!

## Manual Serial Example (Safari / `tool.folotoy.cn`)

If you prefer sending commands manually in [https://tool.folotoy.cn/](https://tool.folotoy.cn/):
```text
pa wifi MyHome_2.4G 12345678
pa set http://192.168.1.25:8788 dev_9f8e7d6c5b4a3210
```

## 3-Button Controls

- **`UP` / `DOWN` click**: Cycle approvals, move multi-choice highlight, or scroll tasks on the dashboard
- **`OK` click**: Approve L0/L1, submit selected option, or trigger L2 3-digit PIN guard
- **`DOWN` long-press (or `OK` double-click)**: Deny the current approval cleanly
- **`OK` long-press (Push-To-Talk)**: Record voice query / speak L2 confirmation PIN, release to send
- **`UP` double-click**: Return to Dashboard

## Host Unit Tests & Web Simulator

```bash
# Pure-C state machine & UTF-8 JSON parser tests (ASan/UBSan)
clang -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  firmware/folotoy-passport/main/pa_model.c \
  firmware/folotoy-passport/tests/test_pa_model.c \
  -o /tmp/test_pa_model && /tmp/test_pa_model

# Hub Edge Device API + 3-tier Chinese localization + setup wizard tests
node --test dsh-feishu/test/device-lite-api.test.js

# Live seeded simulator Hub (4 mixed ZH/EN scenarios)
node scripts/passport-sim-hub.mjs
```
