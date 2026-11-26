// main/main.c
// PocketAgents Hardware Remote for FoloToy AI Passport (ESP32-C3 + LVGL 9.5 + ES8311).
// Includes automatic SoftAP phone provisioning (PocketAgents-Setup @ 192.168.4.1),
// 6-digit pair-code exchange, USB-Serial-JTAG setup, and built-in offline demo mode.
#include "bsp_battery.h"
#include "bsp_button.h"
#include "bsp_display.h"
#include "bsp_i2c.h"
#include "pa_audio.h"
#include "pa_model.h"
#include "pa_net.h"
#include "pa_portal.h"
#include "pa_ui.h"

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const char *TAG = "pa_main";

typedef struct {
    bsp_btn_t btn;
    bsp_btn_ev_t ev;
} raw_btn_msg_t;

typedef struct {
    pa_dispatch_t dispatch;
    uint8_t *pcm_buf;
    size_t pcm_len;
} net_job_t;

static pa_state_t s_state;
static pa_state_t s_ui_snap;      // Kept static (off FreeRTOS task stacks!)
static pa_digest_t s_net_digest;  // Kept static (off FreeRTOS task stacks!)
static pa_net_config_t s_cfg;
static SemaphoreHandle_t s_state_mux;
static SemaphoreHandle_t s_ui_snap_mux;
static QueueHandle_t s_btn_queue;
static QueueHandle_t s_net_queue;
static QueueHandle_t s_chime_queue;
static bool s_battery_ok = false;
static volatile bool s_portal_manual_hold = false;
static volatile uint32_t s_portal_saved_at_ms = 0;

static uint32_t now_ms(void)
{
    return (uint32_t)(esp_timer_get_time() / 1000LL);
}

static void enqueue_chime(pa_chime_t ch)
{
    if (ch == PA_CHIME_NONE || !s_chime_queue) return;
    (void)xQueueSend(s_chime_queue, &ch, 0);
}

static void refresh_ui_now(void)
{
    if (!s_ui_snap_mux || xSemaphoreTake(s_ui_snap_mux, pdMS_TO_TICKS(300)) != pdTRUE) return;
    if (xSemaphoreTake(s_state_mux, pdMS_TO_TICKS(100)) != pdTRUE) {
        xSemaphoreGive(s_ui_snap_mux);
        return;
    }
    s_ui_snap = s_state;
    xSemaphoreGive(s_state_mux);

    if (bsp_lvgl_lock(250)) {
        pa_ui_render(&s_ui_snap);
        bsp_lvgl_unlock();
    }
    xSemaphoreGive(s_ui_snap_mux);
}

static void on_portal_phone(bool connected)
{
    if (xSemaphoreTake(s_state_mux, pdMS_TO_TICKS(100)) == pdTRUE) {
        s_state.setup_phone_connected = connected;
        xSemaphoreGive(s_state_mux);
    }
    refresh_ui_now();
}

static void on_portal_saved(void)
{
    s_portal_manual_hold = false;
    s_portal_saved_at_ms = now_ms();
    net_job_t job;
    memset(&job, 0, sizeof(job));
    job.dispatch.cmd = PA_CMD_FORCE_REFRESH;
    (void)xQueueSend(s_net_queue, &job, 0);
}

static void start_setup_portal_now(bool manual)
{
    s_portal_manual_hold = manual;
    s_portal_saved_at_ms = 0;
    if (pa_portal_start(&s_cfg, on_portal_phone, on_portal_saved)) {
        if (xSemaphoreTake(s_state_mux, pdMS_TO_TICKS(100)) == pdTRUE) {
            pa_state_enter_setup(&s_state, PA_PORTAL_AP_SSID, now_ms());
            xSemaphoreGive(s_state_mux);
        }
        refresh_ui_now();
    }
}

static void stop_setup_portal_now(void)
{
    s_portal_manual_hold = false;
    pa_portal_stop();
    if (xSemaphoreTake(s_state_mux, pdMS_TO_TICKS(100)) == pdTRUE) {
        pa_state_exit_setup(&s_state, now_ms());
        xSemaphoreGive(s_state_mux);
    }
    refresh_ui_now();
}

// Button callback runs in shared esp_timer context -> enqueue only!
static void on_bsp_button(bsp_btn_t btn, bsp_btn_ev_t ev, void *user)
{
    (void)user;
    if (!s_btn_queue) return;
    raw_btn_msg_t msg = { .btn = btn, .ev = ev };
    (void)xQueueSend(s_btn_queue, &msg, 0);
}

static void chime_worker_task(void *arg)
{
    (void)arg;
    pa_chime_t ch;
    while (xQueueReceive(s_chime_queue, &ch, portMAX_DELAY) == pdTRUE) {
        pa_audio_play_chime(ch);
    }
}

static void console_worker_task(void *arg)
{
    (void)arg;
    char line[280];
    size_t pos = 0;
    while (true) {
        unsigned char byte = 0;
        ssize_t r = read(STDIN_FILENO, &byte, 1);
        if (r <= 0) {
            vTaskDelay(pdMS_TO_TICKS(40));
            continue;
        }
        int ch = (int)byte;
        if (ch == '\r' || ch == '\n') {
            if (pos > 0) {
                line[pos] = '\0';
                char a1[160], a2[96];
                int kind = pa_parse_console_cmd(line, a1, sizeof(a1), a2, sizeof(a2));
                if (kind == 1) {
                    pa_net_save_hub_config(&s_cfg, a1, a2);
                    if (xSemaphoreTake(s_state_mux, pdMS_TO_TICKS(100)) == pdTRUE) {
                        s_state.demo_mode = false;
                        xSemaphoreGive(s_state_mux);
                    }
                    net_job_t job;
                    memset(&job, 0, sizeof(job));
                    job.dispatch.cmd = PA_CMD_EXIT_SETUP;
                    (void)xQueueSend(s_net_queue, &job, pdMS_TO_TICKS(100));
                } else if (kind == 2) {
                    pa_net_save_wifi_config(&s_cfg, a1, a2);
                    if (xSemaphoreTake(s_state_mux, pdMS_TO_TICKS(100)) == pdTRUE) {
                        s_state.demo_mode = false;
                        xSemaphoreGive(s_state_mux);
                    }
                    net_job_t job;
                    memset(&job, 0, sizeof(job));
                    job.dispatch.cmd = PA_CMD_EXIT_SETUP;
                    (void)xQueueSend(s_net_queue, &job, pdMS_TO_TICKS(100));
                }
                pos = 0;
            }
            continue;
        }
        if (pos + 1 < sizeof(line) && ch >= 0x20 && ch < 0x7F) {
            line[pos++] = (char)ch;
        }
    }
}

static void input_worker_task(void *arg)
{
    (void)arg;
    raw_btn_msg_t msg;
    while (true) {
        if (xQueueReceive(s_btn_queue, &msg, pdMS_TO_TICKS(250)) == pdTRUE) {
            pa_key_t key = (msg.btn == BSP_BTN_UP) ? PA_KEY_UP
                         : (msg.btn == BSP_BTN_DOWN) ? PA_KEY_DOWN : PA_KEY_OK;
            pa_key_ev_t kev;
            if (msg.ev == BSP_BTN_CLICK) kev = PA_KEY_EV_CLICK;
            else if (msg.ev == BSP_BTN_DOUBLE) kev = PA_KEY_EV_DOUBLE;
            else if (msg.ev == BSP_BTN_LONG) kev = PA_KEY_EV_LONG;
            else if (msg.ev == BSP_BTN_RELEASE) kev = PA_KEY_EV_RELEASE;
            else continue;

            pa_dispatch_t disp;
            bool in_demo = false;
            if (xSemaphoreTake(s_state_mux, pdMS_TO_TICKS(100)) == pdTRUE) {
                disp = pa_state_on_key(&s_state, key, kev, now_ms());
                in_demo = s_state.demo_mode;
                xSemaphoreGive(s_state_mux);
            } else {
                continue;
            }

            if (disp.chime != PA_CHIME_NONE) {
                enqueue_chime(disp.chime);
            }

            // Handle local Demo Mode actions with 0ms latency!
            if (disp.cmd == PA_CMD_START_DEMO) {
                net_job_t stop_job;
                memset(&stop_job, 0, sizeof(stop_job));
                stop_job.dispatch.cmd = PA_CMD_START_DEMO;
                (void)xQueueSend(s_net_queue, &stop_job, pdMS_TO_TICKS(100));
                pa_chime_t dch = PA_CHIME_NONE;
                if (xSemaphoreTake(s_state_mux, pdMS_TO_TICKS(100)) == pdTRUE) {
                    dch = pa_demo_start(&s_state, now_ms());
                    xSemaphoreGive(s_state_mux);
                }
                enqueue_chime(dch);
                refresh_ui_now();
                continue;
            }
            if (in_demo && (disp.cmd == PA_CMD_APPROVE || disp.cmd == PA_CMD_DENY ||
                            disp.cmd == PA_CMD_ANSWER || disp.cmd == PA_CMD_VOICE_STOP)) {
                if (disp.cmd == PA_CMD_VOICE_STOP) {
                    size_t pcm_len = 0;
                    uint8_t *pcm = pa_audio_record_stop(&pcm_len);
                    if (pcm) free(pcm);
                }
                pa_chime_t dch = PA_CHIME_NONE;
                if (xSemaphoreTake(s_state_mux, pdMS_TO_TICKS(100)) == pdTRUE) {
                    dch = pa_demo_handle_cmd(&s_state, &disp, now_ms());
                    xSemaphoreGive(s_state_mux);
                }
                enqueue_chime(dch);
                refresh_ui_now();
                continue;
            }

            if (disp.cmd == PA_CMD_VOICE_START) {
                (void)pa_audio_record_start();
            } else if (disp.cmd == PA_CMD_VOICE_STOP) {
                size_t pcm_len = 0;
                uint8_t *pcm = pa_audio_record_stop(&pcm_len);
                net_job_t job = { .dispatch = disp, .pcm_buf = pcm, .pcm_len = pcm_len };
                if (xQueueSend(s_net_queue, &job, pdMS_TO_TICKS(100)) != pdTRUE && pcm) {
                    free(pcm);
                }
            } else if (disp.cmd != PA_CMD_NONE) {
                net_job_t job = { .dispatch = disp, .pcm_buf = NULL, .pcm_len = 0 };
                (void)xQueueSend(s_net_queue, &job, pdMS_TO_TICKS(100));
            }
            if (disp.ui_dirty) {
                refresh_ui_now();
            }
        } else {
            bool dirty = false;
            if (xSemaphoreTake(s_state_mux, pdMS_TO_TICKS(50)) == pdTRUE) {
                dirty = pa_state_tick(&s_state, now_ms());
                xSemaphoreGive(s_state_mux);
            }
            if (dirty) refresh_ui_now();
        }
    }
}

static void net_worker_task(void *arg)
{
    (void)arg;
    char last_rev[20] = { 0 };
    uint32_t last_poll_ms = 0;
    uint32_t last_bat_ms = 0;
    uint32_t boot_ms = now_ms();
    bool auto_portal_triggered = false;

    while (true) {
        // 1. Handle high-priority queued actions / portal / PTT uploads first
        net_job_t job;
        while (xQueueReceive(s_net_queue, &job, pdMS_TO_TICKS(80)) == pdTRUE) {
            if (job.dispatch.cmd == PA_CMD_ENTER_SETUP) {
                start_setup_portal_now(true);
                continue;
            }
            if (job.dispatch.cmd == PA_CMD_EXIT_SETUP) {
                stop_setup_portal_now();
                pa_net_wifi_reconnect(&s_cfg);
                boot_ms = now_ms();
                auto_portal_triggered = false;
                last_rev[0] = '\0';
                last_poll_ms = 0;
                continue;
            }
            if (job.dispatch.cmd == PA_CMD_START_DEMO) {
                if (pa_portal_is_active()) {
                    pa_portal_stop();
                }
                continue;
            }
            if (job.dispatch.cmd == PA_CMD_FORCE_REFRESH) {
                last_rev[0] = '\0';
                last_poll_ms = 0;
                continue;
            }
            if (job.dispatch.cmd == PA_CMD_APPROVE ||
                job.dispatch.cmd == PA_CMD_DENY ||
                job.dispatch.cmd == PA_CMD_ANSWER) {
                pa_action_result_t ares;
                memset(&ares, 0, sizeof(ares));
                int status = pa_net_post_action(&s_cfg, &job.dispatch, &ares);
                ESP_LOGI(TAG, "[PA] action cmd=%d slot=%d http=%d ok=%d pin=%s",
                         (int)job.dispatch.cmd, job.dispatch.slot, status,
                         ares.ok ? 1 : 0, ares.confirm_pin);
                if (status <= 0 && ares.message[0] == '\0') {
                    snprintf(ares.message, sizeof(ares.message), "网络异常");
                }
                pa_chime_t ch = PA_CHIME_NONE;
                if (xSemaphoreTake(s_state_mux, pdMS_TO_TICKS(100)) == pdTRUE) {
                    ch = pa_state_apply_action_result(&s_state, &ares,
                                                      job.dispatch.cmd == PA_CMD_DENY, now_ms());
                    xSemaphoreGive(s_state_mux);
                }
                enqueue_chime(ch);
                refresh_ui_now();
                last_rev[0] = '\0';
                last_poll_ms = 0;
                continue;
            }
            if (job.dispatch.cmd == PA_CMD_VOICE_STOP) {
                pa_voice_result_t vres;
                memset(&vres, 0, sizeof(vres));
                int status = -1;
                if (job.pcm_buf && job.pcm_len > 0) {
                    status = pa_net_post_voice_pcm(&s_cfg, job.pcm_buf, job.pcm_len, &vres);
                    free(job.pcm_buf);
                    job.pcm_buf = NULL;
                } else {
                    snprintf(vres.reply, sizeof(vres.reply), "未录到语音");
                }
                ESP_LOGI(TAG, "[PA] voice-turn http=%d ok=%d exec=%d",
                         status, vres.ok ? 1 : 0, vres.executed ? 1 : 0);
                pa_chime_t ch = PA_CHIME_NONE;
                if (xSemaphoreTake(s_state_mux, pdMS_TO_TICKS(100)) == pdTRUE) {
                    ch = pa_state_apply_voice_result(&s_state, &vres, now_ms());
                    xSemaphoreGive(s_state_mux);
                }
                enqueue_chime(ch);
                refresh_ui_now();
                if (vres.ok && vres.tts_text[0]) {
                    (void)pa_net_stream_tts_pcm(&s_cfg, vres.tts_text);
                }
                last_rev[0] = '\0';
                last_poll_ms = 0;
                continue;
            }
        }

        // 2. Periodic battery poll (every 15s when fuel gauge present)
        uint32_t t = now_ms();
        if (s_battery_ok && (t - last_bat_ms >= 15000 || last_bat_ms == 0)) {
            int soc = bsp_battery_soc();
            if (soc >= 0 && xSemaphoreTake(s_state_mux, pdMS_TO_TICKS(50)) == pdTRUE) {
                s_state.battery_soc = soc;
                xSemaphoreGive(s_state_mux);
            }
            last_bat_ms = t;
        }

        // 3. Auto-teardown SoftAP once Wi-Fi connects (wait 2s after /save so phone gets HTML reply)
        bool wifi_ok = pa_net_is_wifi_connected();
        if (wifi_ok && pa_portal_is_active() && !s_portal_manual_hold) {
            if (s_portal_saved_at_ms == 0 || (t - s_portal_saved_at_ms) >= 2000) {
                stop_setup_portal_now();
                last_rev[0] = '\0';
                last_poll_ms = 0;
            }
        }

        // Skip Hub polling while in Offline Demo Mode or holding SoftAP open
        bool skip_poll = false;
        if (xSemaphoreTake(s_state_mux, pdMS_TO_TICKS(50)) == pdTRUE) {
            skip_poll = s_state.demo_mode || s_state.screen == PA_SCREEN_SETUP;
            xSemaphoreGive(s_state_mux);
        }
        if (skip_poll) continue;

        // 4. Auto-open SoftAP Captive Portal if Wi-Fi fails to connect on real hardware!
        //    Fresh flash (no saved Wi-Fi): 4.5s (Web Simulator connects in ~1.5s!).
        //    Saved Wi-Fi unreachable: 14s.
        if (!wifi_ok) {
            uint32_t grace_ms = s_cfg.has_saved_wifi ? 14000u : 4500u;
            if (!auto_portal_triggered && (t - boot_ms) >= grace_ms) {
                auto_portal_triggered = true;
                ESP_LOGI(TAG, "[PA] Wi-Fi not connected after %lums -> auto-starting SoftAP portal",
                         (unsigned long)grace_ms);
                start_setup_portal_now(false);
                continue;
            }
            if (last_poll_ms != 0 && (t - last_poll_ms) < 1200u) continue;
            last_poll_ms = t;
            if (xSemaphoreTake(s_state_mux, pdMS_TO_TICKS(50)) == pdTRUE) {
                s_state.net_status = PA_NET_CONNECTING;
                s_state.wifi_ip[0] = '\0';
                snprintf(s_state.net_detail, sizeof(s_state.net_detail), "正在连 Wi-Fi...");
                xSemaphoreGive(s_state_mux);
            }
            refresh_ui_now();
            continue;
        }

        // 5. Wi-Fi is connected -> record IP & auto-exchange 6-digit pair code if user entered one!
        if (last_poll_ms != 0 && (t - last_poll_ms) < (uint32_t)s_cfg.poll_interval_ms) {
            continue;
        }
        last_poll_ms = t;

        char cur_ip[20] = { 0 };
        pa_net_get_ip_str(cur_ip, sizeof(cur_ip));
        if (xSemaphoreTake(s_state_mux, pdMS_TO_TICKS(50)) == pdTRUE) {
            snprintf(s_state.wifi_ip, sizeof(s_state.wifi_ip), "%s", cur_ip);
            xSemaphoreGive(s_state_mux);
        }

        if (pa_is_pair_code(s_cfg.hub_token)) {
            (void)pa_net_exchange_pair_code_if_needed(&s_cfg);
        }

        int status = pa_net_fetch_digest(&s_cfg, last_rev, &s_net_digest);
        if (status == 200 && s_net_digest.ok) {
            if (!s_net_digest.unchanged) {
                ESP_LOGI(TAG, "[PA] digest rev=%s hosts=%d run=%d pending=%d",
                         s_net_digest.rev, s_net_digest.hosts_online,
                         s_net_digest.running_count, s_net_digest.pending_count);
            }
            snprintf(last_rev, sizeof(last_rev), "%s", s_net_digest.rev);
            pa_chime_t ch = PA_CHIME_NONE;
            if (xSemaphoreTake(s_state_mux, pdMS_TO_TICKS(100)) == pdTRUE) {
                ch = pa_state_apply_digest(&s_state, &s_net_digest, now_ms());
                xSemaphoreGive(s_state_mux);
            }
            if (ch != PA_CHIME_NONE) enqueue_chime(ch);
            if (!s_net_digest.unchanged) refresh_ui_now();
        } else {
            last_rev[0] = '\0';
            if (xSemaphoreTake(s_state_mux, pdMS_TO_TICKS(100)) == pdTRUE) {
                if (status == 401 || status == 403) {
                    s_state.net_status = PA_NET_AUTH_ERROR;
                    snprintf(s_state.net_detail, sizeof(s_state.net_detail), "认证失败 (%d)", status);
                } else {
                    s_state.net_status = PA_NET_ERROR;
                    snprintf(s_state.net_detail, sizeof(s_state.net_detail), "控制台离线 (%d)", status);
                }
                xSemaphoreGive(s_state_mux);
            }
            refresh_ui_now();
        }
    }
}

void app_main(void)
{
    ESP_LOGI(TAG, "[PA] PocketAgents FoloToy AI Passport firmware booting...");

    bsp_i2c_init();
    if (bsp_display_init() != ESP_OK || !bsp_lvgl_init()) {
        ESP_LOGE(TAG, "Display/LVGL init failed");
        return;
    }
    bsp_display_backlight(100);

    s_state_mux = xSemaphoreCreateMutex();
    s_ui_snap_mux = xSemaphoreCreateMutex();
    s_btn_queue = xQueueCreate(12, sizeof(raw_btn_msg_t));
    s_net_queue = xQueueCreate(6, sizeof(net_job_t));
    s_chime_queue = xQueueCreate(6, sizeof(pa_chime_t));

    pa_state_init(&s_state);
    pa_net_load_config(&s_cfg);

    (void)pa_audio_init();
    s_battery_ok = (bsp_battery_init() == ESP_OK);
    if (s_battery_ok) {
        s_state.battery_soc = bsp_battery_soc();
    }

    if (bsp_lvgl_lock(1000)) {
        pa_ui_init();
        pa_ui_render(&s_state);
        bsp_lvgl_unlock();
    }

    if (bsp_button_init(on_bsp_button, NULL) != ESP_OK) {
        ESP_LOGW(TAG, "Button init failed");
    }

    if (!pa_net_wifi_start(&s_cfg)) {
        ESP_LOGE(TAG, "Wi-Fi start failed");
    }

    xTaskCreate(chime_worker_task, "pa_chime", 3072, NULL, 3, NULL);
    xTaskCreate(console_worker_task, "pa_cli", 3072, NULL, 2, NULL);
    xTaskCreate(input_worker_task, "pa_input", 4096, NULL, 5, NULL);
    xTaskCreate(net_worker_task, "pa_net", 6144, NULL, 4, NULL);

    ESP_LOGI(TAG, "[PA] Ready (audio=%d battery=%d)", pa_audio_is_ready() ? 1 : 0, s_battery_ok ? 1 : 0);
}
