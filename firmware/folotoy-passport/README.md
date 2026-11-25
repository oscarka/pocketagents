# PocketAgents Hardware Remote — FoloToy AI Passport Firmware

Official reference hardware client for **PocketAgents**, built on top of the open-source [`FoloToy/ai-passport`](https://github.com/FoloToy/ai-passport) BSP (ESP32-C3, 8 MB Flash, no PSRAM, 240×320 ST7789P3 TFT, ES8311 full-duplex audio, 3 physical ADC buttons) and consuming PocketAgents's generic **Edge / Lite Device API (`/api/device/*`)**.

## Features

- **Desk Status Monitor**: Live `HOSTS / RUN / WAIT` counters and active session list (Claude Code, Codex, Antigravity IDE, DSH, WorkBuddy).
- **Auto-Popup Approval & Multi-Choice Triage**: Audible chime + color-coded risk badge (`L0 SAFE` / `L1 EXEC` / `L2 DANGER`).
- **3-Button Blind Control** (single-key gestures only, matching AI Passport's shared-ADC resistor ladder):
  - `UP` / `DOWN` click: Cycle pending approvals or select multi-choice options
  - `OK` click: Approve `L0`/`L1` or submit chosen option (`L2` high-risk commands stay locked and surface a 3-digit PIN)
  - `OK` double-click: Deny command approval
  - `UP` double-click: Return to Dashboard
  - `OK` long-press (Push-To-Talk): Record 16 kHz PCM voice clip -> `POST /api/device/voice-turn` -> stream 16 kHz PCM reply via ES8311 speaker
- **Zero-Trust Pairing**: Uses a revocable `dev_` token minted via `POST /api/pairing/exchange` (or `HUB_TOKEN` on local dev).

## Host Unit Tests (No ESP-IDF Required)

```bash
clang -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  firmware/folotoy-passport/main/pa_model.c \
  firmware/folotoy-passport/tests/test_pa_model.c \
  -o /tmp/test_pa_model && /tmp/test_pa_model
```

## Build Merged 8 MB ESP32-C3 Firmware (ESP-IDF v5.5.3 / Docker)

```bash
docker run --rm \
  -v "${PWD}/firmware/folotoy-passport:/project" \
  -w /project \
  espressif/idf:v5.5.3 \
  bash -c "idf.py set-target esp32c3 && idf.py build && idf.py merge-bin -o build/pocketagents-passport-merged.bin --fill-flash-size 8MB"
```

## Test in the Browser Hardware Simulator (Zero Physical Hardware Required)

1. Start PocketAgents Hub listening on your host LAN IP (e.g. `0.0.0.0:8787`).
2. Start [`VOID001/FoloToy-Passport-Simulator`](https://github.com/VOID001/FoloToy-Passport-Simulator) with private network bridging enabled:
   ```bash
   EMULATOR_NETWORK_ALLOW_PRIVATE=1 npm start
   ```
3. Open `http://127.0.0.1:4190`, click **上传固件**, and upload `build/pocketagents-passport-merged.bin`.
