// main/pa_net.c
// Battle-tested ESP32-C3 Wi-Fi STA/APSTA connection manager (modeled on 78/esp-wifi-connect),
// featuring safe empty-SSID init, saved-channel fast-scan, 32-byte UTF-8 SSID & WPA3-SAE H2E,
// exponential backoff reconnect, and live APSTA probe with 802.11 comeback-timer retry.
#include "pa_net.h"
#include "pa_audio.h"

#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "lwip/ip4_addr.h"
#include "nvs.h"
#include "nvs_flash.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>

static const char *TAG = "pa_net";

#define PA_HTTP_RESP_BUF_SIZE 6144
#define PA_PROBE_GOT_IP_BIT   BIT0
#define PA_PROBE_FAIL_BIT     BIT1

static volatile bool s_wifi_connected = false;
static volatile bool s_sta_autoreconnect = true;
static volatile bool s_probing = false;
static volatile int s_last_disconnect_reason = 0;
static volatile int s_probe_fail_reason = 0;
static int s_reconnect_attempt = 0;
static bool s_driver_initialized = false;

static char s_ip_str[24] = { 0 };
static char s_active_ssid[64] = { 0 };
static char s_active_pass[65] = { 0 };
static uint8_t s_active_channel = 0;

static EventGroupHandle_t s_probe_evg = NULL;
static esp_timer_handle_t s_reconnect_timer = NULL;
static char s_resp_buf[PA_HTTP_RESP_BUF_SIZE];

static bool read_nvs_str_or_default(nvs_handle_t h, const char *key,
                                    char *dst, size_t dst_size, const char *fallback)
{
    size_t len = dst_size;
    if (h != 0 && nvs_get_str(h, key, dst, &len) == ESP_OK && dst[0] != '\0') {
        return true;
    }
    snprintf(dst, dst_size, "%s", fallback ? fallback : "");
    return false;
}

static void strip_trailing_slash(char *url)
{
    size_t ulen = strlen(url);
    while (ulen > 1 && url[ulen - 1] == '/') {
        url[--ulen] = '\0';
    }
}

static void save_channel_to_nvs(uint8_t ch)
{
    if (ch < 1 || ch > 14) return;
    nvs_handle_t h = 0;
    if (nvs_open("pa_cfg", NVS_READWRITE, &h) == ESP_OK) {
        (void)nvs_set_u8(h, "wifi_ch", ch);
        (void)nvs_commit(h);
        nvs_close(h);
    }
}

static void fill_sta_wifi_config(wifi_config_t *wcfg, const char *ssid, const char *pass,
                                 uint8_t channel_hint)
{
    memset(wcfg, 0, sizeof(*wcfg));
    size_t ssid_len = ssid ? strnlen(ssid, sizeof(wcfg->sta.ssid)) : 0;
    if (ssid_len > 0) {
        memcpy(wcfg->sta.ssid, ssid, ssid_len);
    }
    size_t pass_len = pass ? strnlen(pass, sizeof(wcfg->sta.password)) : 0;
    if (pass_len > 0) {
        memcpy(wcfg->sta.password, pass, pass_len);
    }
    // Accept WPA1/WPA2/WPA3-transition & WPA3-SAE H2E routers / modern iPhone hotspots cleanly
    wcfg->sta.threshold.authmode = (pass_len > 0) ? WIFI_AUTH_WPA_PSK : WIFI_AUTH_OPEN;
    wcfg->sta.pmf_cfg.capable = true;
    wcfg->sta.pmf_cfg.required = false;
    wcfg->sta.sae_pwe_h2e = WPA3_SAE_PWE_BOTH;
    wcfg->sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
    wcfg->sta.failure_retry_cnt = 1;
    wcfg->sta.listen_interval = 10;

    if (channel_hint >= 1 && channel_hint <= 14) {
        wcfg->sta.channel = channel_hint;
        wcfg->sta.scan_method = WIFI_FAST_SCAN;
    } else {
        wcfg->sta.channel = 0;
        wcfg->sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    }
}

static void stop_reconnect_timer(void)
{
    if (s_reconnect_timer) {
        (void)esp_timer_stop(s_reconnect_timer);
    }
}

static void on_reconnect_timer(void *arg)
{
    (void)arg;
    if (!s_sta_autoreconnect || s_probing || s_wifi_connected || !s_active_ssid[0]) {
        return;
    }
    // After 2 fast attempts on saved channel, drop channel hint to scan all 2.4GHz channels
    // (handles routers whose auto-channel changed after reboot).
    uint8_t ch_hint = (s_reconnect_attempt < 2) ? s_active_channel : 0;
    wifi_config_t wcfg;
    fill_sta_wifi_config(&wcfg, s_active_ssid, s_active_pass, ch_hint);
    (void)esp_wifi_set_config(WIFI_IF_STA, &wcfg);
    ESP_LOGI(TAG, "STA reconnect attempt #%d (ch_hint=%u)", s_reconnect_attempt + 1, (unsigned)ch_hint);
    esp_err_t err = esp_wifi_connect();
    if (err != ESP_OK && err != ESP_ERR_WIFI_CONN) {
        ESP_LOGW(TAG, "esp_wifi_connect returned %s, scheduling retry", esp_err_to_name(err));
        uint32_t delay_ms = pa_wifi_backoff_ms(s_reconnect_attempt++);
        if (s_reconnect_timer) {
            (void)esp_timer_start_once(s_reconnect_timer, (int64_t)delay_ms * 1000LL);
        }
    }
}

void pa_net_load_config(pa_net_config_t *cfg)
{
    memset(cfg, 0, sizeof(*cfg));
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        (void)nvs_flash_erase();
        err = nvs_flash_init();
    }

    nvs_handle_t h = 0;
    if (err == ESP_OK) {
        if (nvs_open("pa_cfg", NVS_READONLY, &h) != ESP_OK) {
            h = 0;
        }
    }

    cfg->has_saved_wifi = read_nvs_str_or_default(h, "wifi_ssid", cfg->wifi_ssid, sizeof(cfg->wifi_ssid),
                                                  CONFIG_PA_DEFAULT_WIFI_SSID);
    (void)read_nvs_str_or_default(h, "wifi_pass", cfg->wifi_pass, sizeof(cfg->wifi_pass),
                                  CONFIG_PA_DEFAULT_WIFI_PASS);
    uint8_t saved_ch = 0;
    if (h != 0 && cfg->has_saved_wifi && nvs_get_u8(h, "wifi_ch", &saved_ch) == ESP_OK &&
        saved_ch >= 1 && saved_ch <= 14) {
        cfg->wifi_channel = saved_ch;
    }
    cfg->has_saved_hub = read_nvs_str_or_default(h, "hub_url", cfg->hub_url, sizeof(cfg->hub_url),
                                                 CONFIG_PA_DEFAULT_HUB_URL);
    (void)read_nvs_str_or_default(h, "hub_token", cfg->hub_token, sizeof(cfg->hub_token),
                                  CONFIG_PA_DEFAULT_HUB_TOKEN);

    if (h != 0) nvs_close(h);

    strip_trailing_slash(cfg->hub_url);
    cfg->poll_interval_ms = CONFIG_PA_POLL_INTERVAL_MS;
    ESP_LOGI(TAG, "Config loaded: ssid=%s (saved=%d ch=%u) hub=%s (saved=%d) token=%s",
             cfg->wifi_ssid[0] ? cfg->wifi_ssid : "<empty>",
             cfg->has_saved_wifi ? 1 : 0, (unsigned)cfg->wifi_channel,
             cfg->hub_url, cfg->has_saved_hub ? 1 : 0,
             cfg->hub_token[0] ? "<set>" : "<empty>");
}

bool pa_net_save_hub_config(pa_net_config_t *cfg, const char *hub_url, const char *hub_token)
{
    if (!cfg || !hub_url || !hub_url[0]) return false;
    snprintf(cfg->hub_url, sizeof(cfg->hub_url), "%s", hub_url);
    strip_trailing_slash(cfg->hub_url);
    snprintf(cfg->hub_token, sizeof(cfg->hub_token), "%s", hub_token ? hub_token : "");
    cfg->has_saved_hub = true;

    nvs_handle_t h = 0;
    if (nvs_open("pa_cfg", NVS_READWRITE, &h) == ESP_OK) {
        (void)nvs_set_str(h, "hub_url", cfg->hub_url);
        (void)nvs_set_str(h, "hub_token", cfg->hub_token);
        (void)nvs_commit(h);
        nvs_close(h);
    }
    ESP_LOGI(TAG, "[PA] Hub config updated: url=%s token=%s",
             cfg->hub_url, cfg->hub_token[0] ? "<set>" : "<empty>");
    return true;
}

static void apply_sta_config_and_connect(const pa_net_config_t *cfg)
{
    if (!cfg || !cfg->wifi_ssid[0] || !s_driver_initialized) return;
    stop_reconnect_timer();
    snprintf(s_active_ssid, sizeof(s_active_ssid), "%s", cfg->wifi_ssid);
    snprintf(s_active_pass, sizeof(s_active_pass), "%s", cfg->wifi_pass);
    s_active_channel = cfg->wifi_channel;
    s_reconnect_attempt = 0;
    s_last_disconnect_reason = 0;
    s_sta_autoreconnect = true;

    wifi_config_t wcfg;
    fill_sta_wifi_config(&wcfg, s_active_ssid, s_active_pass, s_active_channel);
    (void)esp_wifi_disconnect();
    (void)esp_wifi_set_config(WIFI_IF_STA, &wcfg);
    (void)esp_wifi_connect();
}

void pa_net_set_sta_autoreconnect(bool enabled)
{
    s_sta_autoreconnect = enabled;
    if (!enabled) {
        stop_reconnect_timer();
    }
}

void pa_net_wifi_pause_for_portal(void)
{
    // Stop STA reconnect loop & backoff timer so single-radio ESP32-C3 SoftAP stays rock-solid
    s_sta_autoreconnect = false;
    stop_reconnect_timer();
    s_wifi_connected = false;
    s_ip_str[0] = '\0';
    (void)esp_wifi_disconnect();
}

void pa_net_wifi_reconnect(const pa_net_config_t *cfg)
{
    apply_sta_config_and_connect(cfg);
}

bool pa_net_save_wifi_config(pa_net_config_t *cfg, const char *ssid, const char *pass)
{
    if (!cfg || !ssid || !ssid[0]) return false;
    bool same_ssid = (strcmp(cfg->wifi_ssid, ssid) == 0);
    snprintf(cfg->wifi_ssid, sizeof(cfg->wifi_ssid), "%s", ssid);
    snprintf(cfg->wifi_pass, sizeof(cfg->wifi_pass), "%s", pass ? pass : "");
    if (!same_ssid) cfg->wifi_channel = 0;
    cfg->has_saved_wifi = true;

    nvs_handle_t h = 0;
    if (nvs_open("pa_cfg", NVS_READWRITE, &h) == ESP_OK) {
        (void)nvs_set_str(h, "wifi_ssid", cfg->wifi_ssid);
        (void)nvs_set_str(h, "wifi_pass", cfg->wifi_pass);
        (void)nvs_set_u8(h, "wifi_ch", cfg->wifi_channel);
        (void)nvs_commit(h);
        nvs_close(h);
    }
    ESP_LOGI(TAG, "[PA] Wi-Fi config updated: ssid=%s (reconnecting)", cfg->wifi_ssid);
    apply_sta_config_and_connect(cfg);
    return true;
}

bool pa_net_save_portal_config(pa_net_config_t *cfg,
                               const char *ssid, const char *pass, bool keep_pass_if_empty,
                               uint8_t channel,
                               const char *hub_url, const char *hub_token, bool keep_token_if_empty)
{
    if (!cfg) return false;

    if (ssid && ssid[0]) {
        bool same_ssid = (strcmp(cfg->wifi_ssid, ssid) == 0);
        snprintf(cfg->wifi_ssid, sizeof(cfg->wifi_ssid), "%s", ssid);
        if (!same_ssid || !keep_pass_if_empty || (pass && pass[0])) {
            snprintf(cfg->wifi_pass, sizeof(cfg->wifi_pass), "%s", pass ? pass : "");
        }
        if (channel >= 1 && channel <= 14) {
            cfg->wifi_channel = channel;
        } else if (!same_ssid) {
            cfg->wifi_channel = 0;
        }
        cfg->has_saved_wifi = true;
    }

    if (hub_url && hub_url[0]) {
        snprintf(cfg->hub_url, sizeof(cfg->hub_url), "%s", hub_url);
        strip_trailing_slash(cfg->hub_url);
        cfg->has_saved_hub = true;
    }
    if ((hub_token && hub_token[0]) || !keep_token_if_empty) {
        snprintf(cfg->hub_token, sizeof(cfg->hub_token), "%s", hub_token ? hub_token : "");
    }

    nvs_handle_t h = 0;
    if (nvs_open("pa_cfg", NVS_READWRITE, &h) == ESP_OK) {
        if (cfg->has_saved_wifi) {
            (void)nvs_set_str(h, "wifi_ssid", cfg->wifi_ssid);
            (void)nvs_set_str(h, "wifi_pass", cfg->wifi_pass);
            (void)nvs_set_u8(h, "wifi_ch", cfg->wifi_channel);
        }
        if (cfg->has_saved_hub) {
            (void)nvs_set_str(h, "hub_url", cfg->hub_url);
            (void)nvs_set_str(h, "hub_token", cfg->hub_token);
        }
        (void)nvs_commit(h);
        nvs_close(h);
    }

    ESP_LOGI(TAG, "[PA] Portal config saved to NVS: ssid=%s ch=%u hub=%s token=%s",
             cfg->wifi_ssid, (unsigned)cfg->wifi_channel,
             cfg->hub_url, cfg->hub_token[0] ? "<set>" : "<empty>");
    return true;
}

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        if (s_sta_autoreconnect && !s_probing && s_active_ssid[0]) {
            ESP_LOGI(TAG, "Wi-Fi STA started, connecting...");
            (void)esp_wifi_connect();
        }
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        const wifi_event_sta_disconnected_t *ev = (const wifi_event_sta_disconnected_t *)data;
        int reason = ev ? (int)ev->reason : 0;
        s_wifi_connected = false;
        s_ip_str[0] = '\0';

        if (s_probing) {
            // Live portal verification is waiting on s_probe_evg
            if (reason != WIFI_REASON_ASSOC_LEAVE) {
                s_probe_fail_reason = reason;
                if (s_probe_evg) xEventGroupSetBits(s_probe_evg, PA_PROBE_FAIL_BIT);
            }
            return;
        }

        if (reason != WIFI_REASON_ASSOC_LEAVE) {
            s_last_disconnect_reason = reason;
        }

        if (s_sta_autoreconnect && s_active_ssid[0]) {
            uint32_t delay_ms = pa_wifi_backoff_ms(s_reconnect_attempt++);
            ESP_LOGW(TAG, "Wi-Fi disconnected (reason=%d), backoff retry in %lums",
                     reason, (unsigned long)delay_ms);
            stop_reconnect_timer();
            if (s_reconnect_timer) {
                (void)esp_timer_start_once(s_reconnect_timer, (int64_t)delay_ms * 1000LL);
            }
        } else {
            ESP_LOGI(TAG, "Wi-Fi STA paused (reason=%d)", reason);
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *ev = (const ip_event_got_ip_t *)data;
        snprintf(s_ip_str, sizeof(s_ip_str), IPSTR, IP2STR(&ev->ip_info.ip));
        s_wifi_connected = true;
        s_last_disconnect_reason = 0;
        s_reconnect_attempt = 0;
        stop_reconnect_timer();
        ESP_LOGI(TAG, "[PA] Wi-Fi connected, IP=%s", s_ip_str);

        if (s_probing) {
            if (s_probe_evg) xEventGroupSetBits(s_probe_evg, PA_PROBE_GOT_IP_BIT);
            return;
        }

        wifi_ap_record_t ap_info;
        if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK &&
            ap_info.primary >= 1 && ap_info.primary <= 14 &&
            ap_info.primary != s_active_channel) {
            s_active_channel = ap_info.primary;
            save_channel_to_nvs(s_active_channel);
        }
    }
}

bool pa_net_wifi_start(const pa_net_config_t *cfg)
{
    if (!cfg) return false;
    if (s_driver_initialized) return true;

    esp_err_t err = esp_netif_init();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return false;
    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return false;

    esp_netif_t *sta = esp_netif_create_default_wifi_sta();
    if (!sta) return false;
    (void)esp_netif_set_hostname(sta, "pocketagents-passport");

    // Create default AP netif once & explicitly lock gateway/DHCP to 192.168.4.1/24 (78/esp-wifi-connect)
    esp_netif_t *ap = esp_netif_create_default_wifi_ap();
    if (ap) {
        esp_netif_ip_info_t ip_info;
        memset(&ip_info, 0, sizeof(ip_info));
        IP4_ADDR(&ip_info.ip, 192, 168, 4, 1);
        IP4_ADDR(&ip_info.gw, 192, 168, 4, 1);
        IP4_ADDR(&ip_info.netmask, 255, 255, 255, 0);
        (void)esp_netif_dhcps_stop(ap);
        (void)esp_netif_set_ip_info(ap, &ip_info);
        (void)esp_netif_dhcps_start(ap);
    }

    s_probe_evg = xEventGroupCreate();
    if (!s_probe_evg) return false;

    const esp_timer_create_args_t targs = {
        .callback = on_reconnect_timer,
        .arg = NULL,
        .dispatch_method = ESP_TIMER_TASK,
        .name = "pa_wifi_retry",
        .skip_unhandled_events = false, // Allow light-sleep wakeup per 78/esp-wifi-connect
    };
    if (esp_timer_create(&targs, &s_reconnect_timer) != ESP_OK) return false;

    wifi_init_config_t init_cfg = WIFI_INIT_CONFIG_DEFAULT();
    if (esp_wifi_init(&init_cfg) != ESP_OK) return false;

    if (esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi_event, NULL) != ESP_OK) {
        return false;
    }
    if (esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_wifi_event, NULL) != ESP_OK) {
        return false;
    }

    if (esp_wifi_set_storage(WIFI_STORAGE_RAM) != ESP_OK) return false;
    if (esp_wifi_set_mode(WIFI_MODE_STA) != ESP_OK) return false;

    if (cfg->wifi_ssid[0] != '\0') {
        snprintf(s_active_ssid, sizeof(s_active_ssid), "%s", cfg->wifi_ssid);
        snprintf(s_active_pass, sizeof(s_active_pass), "%s", cfg->wifi_pass);
        s_active_channel = cfg->wifi_channel;
        s_sta_autoreconnect = true;
        wifi_config_t wcfg;
        fill_sta_wifi_config(&wcfg, s_active_ssid, s_active_pass, s_active_channel);
        if (esp_wifi_set_config(WIFI_IF_STA, &wcfg) != ESP_OK) return false;
    } else {
        s_active_ssid[0] = '\0';
        s_active_pass[0] = '\0';
        s_active_channel = 0;
        s_sta_autoreconnect = false;
    }

    if (esp_wifi_start() != ESP_OK) return false;
    (void)esp_wifi_set_band_mode(WIFI_BAND_MODE_2G_ONLY);
    (void)esp_wifi_set_ps(WIFI_PS_MIN_MODEM);

    s_driver_initialized = true;
    return true;
}

bool pa_net_probe_connect(const char *ssid, const char *pass,
                          uint8_t *out_channel, int *out_reason,
                          char *out_ip, size_t out_ip_size)
{
    if (out_channel) *out_channel = 0;
    if (out_reason) *out_reason = 0;
    if (out_ip && out_ip_size > 0) out_ip[0] = '\0';

    if (!s_driver_initialized || !s_probe_evg || !ssid || !ssid[0]) {
        if (out_reason) *out_reason = WIFI_REASON_NO_AP_FOUND;
        return false;
    }
    size_t slen = strlen(ssid);
    size_t plen = pass ? strlen(pass) : 0;
    if (slen > 32 || plen > 64) {
        if (out_reason) *out_reason = WIFI_REASON_AUTH_FAIL;
        return false;
    }

    // Modeled directly on 78/esp-wifi-connect WifiConfigurationAp::ConnectToWifi:
    // In APSTA mode, Channel Switch Announcement to the home AP channel frequently causes
    // a transient "Association Refused Temporarily (status=30)" comeback timer (~1.1s).
    // Waiting 3000ms and retrying once turns that failure into a reliable single-submit success!
    s_sta_autoreconnect = false;
    stop_reconnect_timer();
    s_probing = true;
    s_probe_fail_reason = 0;

    bool connected = false;
    uint8_t found_channel = 0;

    for (int attempt = 1; attempt <= 2 && !connected; attempt++) {
        if (attempt > 1) {
            ESP_LOGI(TAG, "[PA-PROBE] Retry attempt 2/2 after 3000ms comeback settle delay");
            vTaskDelay(pdMS_TO_TICKS(3000));
        }
        xEventGroupClearBits(s_probe_evg, PA_PROBE_GOT_IP_BIT | PA_PROBE_FAIL_BIT);
        s_probe_fail_reason = 0;
        (void)esp_wifi_scan_stop();
        (void)esp_wifi_disconnect();

        wifi_config_t wcfg;
        fill_sta_wifi_config(&wcfg, ssid, pass ? pass : "", 0);
        if (esp_wifi_set_config(WIFI_IF_STA, &wcfg) != ESP_OK) {
            s_probe_fail_reason = WIFI_REASON_ASSOC_FAIL;
            continue;
        }
        esp_err_t ret = esp_wifi_connect();
        if (ret != ESP_OK) {
            ESP_LOGW(TAG, "[PA-PROBE] esp_wifi_connect failed: %s (attempt %d/2)",
                     esp_err_to_name(ret), attempt);
            s_probe_fail_reason = WIFI_REASON_ASSOC_FAIL;
            continue;
        }

        EventBits_t bits = xEventGroupWaitBits(
            s_probe_evg,
            PA_PROBE_GOT_IP_BIT | PA_PROBE_FAIL_BIT,
            pdTRUE,
            pdFALSE,
            pdMS_TO_TICKS(10000));

        if (bits & PA_PROBE_GOT_IP_BIT) {
            connected = true;
            wifi_ap_record_t ap_info;
            if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
                found_channel = ap_info.primary;
            }
            if (out_ip && out_ip_size > 0) {
                snprintf(out_ip, out_ip_size, "%s", s_ip_str);
            }
        } else {
            if (bits == 0) {
                // Cancel in-flight connecting state so retry never hits ESP_ERR_WIFI_STATE
                (void)esp_wifi_disconnect();
                if (s_probe_fail_reason == 0) {
                    s_probe_fail_reason = WIFI_REASON_HANDSHAKE_TIMEOUT;
                }
            }
            ESP_LOGW(TAG, "[PA-PROBE] Attempt %d/2 failed (bits=0x%lx reason=%d)",
                     attempt, (unsigned long)bits, s_probe_fail_reason);
        }
    }

    // Disconnect STA cleanly while SoftAP returns HTTP response; pure STA reconnects on saved channel in <1s.
    (void)esp_wifi_disconnect();
    s_wifi_connected = false;
    s_probing = false;

    if (out_channel) *out_channel = found_channel;
    if (out_reason) *out_reason = connected ? 0 : s_probe_fail_reason;
    return connected;
}

bool pa_net_is_wifi_connected(void)
{
    return s_wifi_connected;
}

int pa_net_get_last_disconnect_reason(void)
{
    return s_last_disconnect_reason;
}

void pa_net_get_ip_str(char *out, size_t out_size)
{
    if (!out || out_size == 0) return;
    snprintf(out, out_size, "%s", s_ip_str);
}

static int perform_http_json(const pa_net_config_t *cfg, const char *url,
                             esp_http_client_method_t method,
                             const char *content_type,
                             const uint8_t *req_body, size_t req_len,
                             char *resp_out, size_t resp_size)
{
    if (!s_wifi_connected || !cfg || !url) return -1;

    esp_http_client_config_t hcfg = {
        .url = url,
        .method = method,
        .timeout_ms = 6000,
        .buffer_size = 1024,
        .buffer_size_tx = 1024,
        .crt_bundle_attach = esp_crt_bundle_attach,
    };
    esp_http_client_handle_t client = esp_http_client_init(&hcfg);
    if (!client) return -1;

    if (cfg->hub_token[0]) {
        esp_http_client_set_header(client, "x-hub-token", cfg->hub_token);
    }
    if (content_type && content_type[0]) {
        esp_http_client_set_header(client, "Content-Type", content_type);
    }
    esp_http_client_set_header(client, "Accept-Encoding", "identity");

    esp_err_t err = esp_http_client_open(client, (int)req_len);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "HTTP open failed (%s): %s", url, esp_err_to_name(err));
        esp_http_client_cleanup(client);
        return -1;
    }

    if (req_body && req_len > 0) {
        size_t sent = 0;
        while (sent < req_len) {
            int w = esp_http_client_write(client, (const char *)(req_body + sent), (int)(req_len - sent));
            if (w <= 0) {
                esp_http_client_close(client);
                esp_http_client_cleanup(client);
                return -1;
            }
            sent += (size_t)w;
        }
    }

    (void)esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);

    size_t total = 0;
    if (resp_out && resp_size > 1) {
        while (total + 1 < resp_size) {
            int r = esp_http_client_read(client, resp_out + total, (int)(resp_size - 1 - total));
            if (r <= 0) break;
            total += (size_t)r;
        }
        resp_out[total] = '\0';
    }

    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    return status;
}

bool pa_net_exchange_pair_code_if_needed(pa_net_config_t *cfg)
{
    if (!s_wifi_connected || !cfg || !cfg->hub_url[0] || !pa_is_pair_code(cfg->hub_token)) {
        return false;
    }
    char url[224];
    snprintf(url, sizeof(url), "%s/api/pairing/exchange", cfg->hub_url);

    char code_up[8];
    for (int i = 0; i < 6; i++) {
        code_up[i] = (char)toupper((unsigned char)cfg->hub_token[i]);
    }
    code_up[6] = '\0';

    char payload[220];
    int plen = snprintf(payload, sizeof(payload),
                        "{\"code\":\"%s\",\"deviceId\":\"folotoy-passport\",\"deviceName\":\"FoloToy AI Passport\"}",
                        code_up);
    if (plen <= 0) return false;

    int status = perform_http_json(cfg, url, HTTP_METHOD_POST, "application/json",
                                   (const uint8_t *)payload, (size_t)plen,
                                   s_resp_buf, sizeof(s_resp_buf));
    if (status == 200) {
        char exchanged[96];
        if (pa_parse_pair_exchange_json(s_resp_buf, exchanged, sizeof(exchanged))) {
            ESP_LOGI(TAG, "[PA] 6-char pair code exchanged for revocable device token!");
            return pa_net_save_hub_config(cfg, cfg->hub_url, exchanged);
        }
    }
    ESP_LOGW(TAG, "[PA] Pair code exchange returned HTTP %d", status);
    return false;
}

int pa_net_fetch_digest(const pa_net_config_t *cfg, const char *since_rev, pa_digest_t *out)
{
    char url[256];
    if (since_rev && since_rev[0]) {
        snprintf(url, sizeof(url), "%s/api/device/digest?since=%s&maxApprovals=5&maxTasks=4",
                 cfg->hub_url, since_rev);
    } else {
        snprintf(url, sizeof(url), "%s/api/device/digest?maxApprovals=5&maxTasks=4",
                 cfg->hub_url);
    }

    int status = perform_http_json(cfg, url, HTTP_METHOD_GET, NULL, NULL, 0,
                                   s_resp_buf, sizeof(s_resp_buf));
    if (status == 200) {
        if (!pa_parse_digest_json(s_resp_buf, out)) {
            ESP_LOGW(TAG, "Digest JSON parse failed");
            return -2;
        }
    }
    return status;
}

int pa_net_post_action(const pa_net_config_t *cfg, const pa_dispatch_t *cmd, pa_action_result_t *out)
{
    char url[220];
    snprintf(url, sizeof(url), "%s/api/device/action", cfg->hub_url);

    char payload[160];
    int plen = pa_build_action_json(cmd, payload, sizeof(payload));
    if (plen <= 0) return -1;

    int status = perform_http_json(cfg, url, HTTP_METHOD_POST, "application/json",
                                   (const uint8_t *)payload, (size_t)plen,
                                   s_resp_buf, sizeof(s_resp_buf));
    if (status > 0 && out) {
        (void)pa_parse_action_result_json(s_resp_buf, out);
    }
    return status;
}

int pa_net_post_voice_pcm(const pa_net_config_t *cfg, const uint8_t *pcm, size_t pcm_len,
                          pa_voice_result_t *out)
{
    char url[220];
    snprintf(url, sizeof(url), "%s/api/device/voice-turn?rate=%d", cfg->hub_url, PA_AUDIO_SAMPLE_RATE);

    int status = perform_http_json(cfg, url, HTTP_METHOD_POST, "audio/pcm; rate=16000",
                                   pcm, pcm_len, s_resp_buf, sizeof(s_resp_buf));
    if (status > 0 && out) {
        (void)pa_parse_voice_result_json(s_resp_buf, out);
    }
    return status;
}

static size_t url_encode_query(const char *src, char *dst, size_t dst_size)
{
    static const char HEX[] = "0123456789ABCDEF";
    size_t pos = 0;
    for (size_t i = 0; src && src[i] != '\0'; i++) {
        unsigned char c = (unsigned char)src[i];
        bool unreserved = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                          (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.';
        if (unreserved) {
            if (pos + 2 > dst_size) break;
            dst[pos++] = (char)c;
        } else {
            if (pos + 4 > dst_size) break;
            dst[pos++] = '%';
            dst[pos++] = HEX[(c >> 4) & 0x0Fu];
            dst[pos++] = HEX[c & 0x0Fu];
        }
    }
    if (dst_size > 0) dst[pos] = '\0';
    return pos;
}

bool pa_net_stream_tts_pcm(const pa_net_config_t *cfg, const char *text)
{
    if (!s_wifi_connected || !cfg || !text || !text[0] || !pa_audio_is_ready()) return false;

    char encoded[256];
    url_encode_query(text, encoded, sizeof(encoded));
    char url[480];
    snprintf(url, sizeof(url), "%s/api/device/tts-pcm?rate=%d&text=%s",
             cfg->hub_url, PA_AUDIO_SAMPLE_RATE, encoded);

    esp_http_client_config_t hcfg = {
        .url = url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = 10000,
        .buffer_size = 1024,
        .crt_bundle_attach = esp_crt_bundle_attach,
    };
    esp_http_client_handle_t client = esp_http_client_init(&hcfg);
    if (!client) return false;
    if (cfg->hub_token[0]) {
        esp_http_client_set_header(client, "x-hub-token", cfg->hub_token);
    }

    if (esp_http_client_open(client, 0) != ESP_OK) {
        esp_http_client_cleanup(client);
        return false;
    }
    (void)esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);
    bool ok = false;
    if (status == 200) {
        uint8_t chunk[1024];
        while (true) {
            int r = esp_http_client_read(client, (char *)chunk, sizeof(chunk));
            if (r <= 0) break;
            pa_audio_play_pcm_chunk(chunk, (size_t)r);
            ok = true;
        }
    }
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    return ok;
}
