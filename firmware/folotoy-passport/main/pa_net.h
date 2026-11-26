// main/pa_net.h
// Wi-Fi STA/APSTA + NVS configuration + 6-digit pair-code exchange + PocketAgents Lite HTTP client.
#pragma once

#include "pa_model.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    char wifi_ssid[64];
    char wifi_pass[64];
    char hub_url[160];
    char hub_token[96];
    int poll_interval_ms;
    bool has_saved_wifi; // true if wifi_ssid came from NVS rather than simulator fallback
    bool has_saved_hub;  // true if hub_url came from NVS rather than simulator fallback
} pa_net_config_t;

void pa_net_load_config(pa_net_config_t *cfg);
bool pa_net_save_hub_config(pa_net_config_t *cfg, const char *hub_url, const char *hub_token);
bool pa_net_save_wifi_config(pa_net_config_t *cfg, const char *ssid, const char *pass);
bool pa_net_save_portal_config(pa_net_config_t *cfg,
                               const char *ssid, const char *pass, bool keep_pass_if_empty,
                               const char *hub_url, const char *hub_token, bool keep_token_if_empty);
bool pa_net_wifi_start(const pa_net_config_t *cfg);
void pa_net_wifi_reconnect(const pa_net_config_t *cfg);
void pa_net_set_sta_autoreconnect(bool enabled);
void pa_net_wifi_pause_for_portal(void);
bool pa_net_is_wifi_connected(void);
void pa_net_get_ip_str(char *out, size_t out_size);

// Exchange a 6-digit pairing code (e.g. "482910") for a revocable dev_ token and persist it to NVS.
bool pa_net_exchange_pair_code_if_needed(pa_net_config_t *cfg);

// HTTP operations (call strictly from worker task, never from button/LVGL callbacks)
int pa_net_fetch_digest(const pa_net_config_t *cfg, const char *since_rev, pa_digest_t *out);
int pa_net_post_action(const pa_net_config_t *cfg, const pa_dispatch_t *cmd, pa_action_result_t *out);
int pa_net_post_voice_pcm(const pa_net_config_t *cfg, const uint8_t *pcm, size_t pcm_len,
                          pa_voice_result_t *out);
bool pa_net_stream_tts_pcm(const pa_net_config_t *cfg, const char *text);
