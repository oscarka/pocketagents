// main/pa_net.c
#include "pa_net.h"
#include "pa_audio.h"

#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
#include "nvs_flash.h"

#include <stdio.h>
#include <string.h>

static const char *TAG = "pa_net";

#define PA_HTTP_RESP_BUF_SIZE 4096

static volatile bool s_wifi_connected = false;
static char s_ip_str[24] = { 0 };
static char s_resp_buf[PA_HTTP_RESP_BUF_SIZE];

static void read_nvs_str_or_default(nvs_handle_t h, const char *key,
                                    char *dst, size_t dst_size, const char *fallback)
{
    size_t len = dst_size;
    if (h != 0 && nvs_get_str(h, key, dst, &len) == ESP_OK && dst[0] != '\0') {
        return;
    }
    snprintf(dst, dst_size, "%s", fallback ? fallback : "");
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

    read_nvs_str_or_default(h, "wifi_ssid", cfg->wifi_ssid, sizeof(cfg->wifi_ssid),
                            CONFIG_PA_DEFAULT_WIFI_SSID);
    read_nvs_str_or_default(h, "wifi_pass", cfg->wifi_pass, sizeof(cfg->wifi_pass),
                            CONFIG_PA_DEFAULT_WIFI_PASS);
    read_nvs_str_or_default(h, "hub_url", cfg->hub_url, sizeof(cfg->hub_url),
                            CONFIG_PA_DEFAULT_HUB_URL);
    read_nvs_str_or_default(h, "hub_token", cfg->hub_token, sizeof(cfg->hub_token),
                            CONFIG_PA_DEFAULT_HUB_TOKEN);

    if (h != 0) nvs_close(h);

    // Strip trailing slash on hub_url
    size_t ulen = strlen(cfg->hub_url);
    while (ulen > 1 && cfg->hub_url[ulen - 1] == '/') {
        cfg->hub_url[--ulen] = '\0';
    }
    cfg->poll_interval_ms = CONFIG_PA_POLL_INTERVAL_MS;
    ESP_LOGI(TAG, "Config loaded: ssid=%s hub=%s token=%s",
             cfg->wifi_ssid, cfg->hub_url, cfg->hub_token[0] ? "<set>" : "<empty>");
}

bool pa_net_save_hub_config(pa_net_config_t *cfg, const char *hub_url, const char *hub_token)
{
    if (!cfg || !hub_url || !hub_url[0]) return false;
    snprintf(cfg->hub_url, sizeof(cfg->hub_url), "%s", hub_url);
    size_t ulen = strlen(cfg->hub_url);
    while (ulen > 1 && cfg->hub_url[ulen - 1] == '/') {
        cfg->hub_url[--ulen] = '\0';
    }
    snprintf(cfg->hub_token, sizeof(cfg->hub_token), "%s", hub_token ? hub_token : "");

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

bool pa_net_save_wifi_config(pa_net_config_t *cfg, const char *ssid, const char *pass)
{
    if (!cfg || !ssid || !ssid[0]) return false;
    snprintf(cfg->wifi_ssid, sizeof(cfg->wifi_ssid), "%s", ssid);
    snprintf(cfg->wifi_pass, sizeof(cfg->wifi_pass), "%s", pass ? pass : "");

    nvs_handle_t h = 0;
    if (nvs_open("pa_cfg", NVS_READWRITE, &h) == ESP_OK) {
        (void)nvs_set_str(h, "wifi_ssid", cfg->wifi_ssid);
        (void)nvs_set_str(h, "wifi_pass", cfg->wifi_pass);
        (void)nvs_commit(h);
        nvs_close(h);
    }
    ESP_LOGI(TAG, "[PA] Wi-Fi config updated: ssid=%s (reconnecting)", cfg->wifi_ssid);
    wifi_config_t wcfg;
    memset(&wcfg, 0, sizeof(wcfg));
    size_t ssid_len = strnlen(cfg->wifi_ssid, sizeof(wcfg.sta.ssid) - 1);
    memcpy(wcfg.sta.ssid, cfg->wifi_ssid, ssid_len);
    size_t pass_len = strnlen(cfg->wifi_pass, sizeof(wcfg.sta.password) - 1);
    memcpy(wcfg.sta.password, cfg->wifi_pass, pass_len);
    wcfg.sta.threshold.authmode = cfg->wifi_pass[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    (void)esp_wifi_disconnect();
    (void)esp_wifi_set_config(WIFI_IF_STA, &wcfg);
    (void)esp_wifi_connect();
    return true;
}

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        ESP_LOGI(TAG, "Wi-Fi STA started, connecting...");
        (void)esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        s_wifi_connected = false;
        s_ip_str[0] = '\0';
        ESP_LOGW(TAG, "Wi-Fi disconnected, retrying...");
        (void)esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *ev = (const ip_event_got_ip_t *)data;
        snprintf(s_ip_str, sizeof(s_ip_str), IPSTR, IP2STR(&ev->ip_info.ip));
        s_wifi_connected = true;
        ESP_LOGI(TAG, "[PA] Wi-Fi connected, IP=%s", s_ip_str);
    }
}

bool pa_net_wifi_start(const pa_net_config_t *cfg)
{
    if (!cfg || cfg->wifi_ssid[0] == '\0') {
        ESP_LOGE(TAG, "Empty Wi-Fi SSID");
        return false;
    }

    esp_err_t err = esp_netif_init();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return false;
    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return false;

    esp_netif_t *sta = esp_netif_create_default_wifi_sta();
    if (!sta) return false;

    wifi_init_config_t init_cfg = WIFI_INIT_CONFIG_DEFAULT();
    if (esp_wifi_init(&init_cfg) != ESP_OK) return false;

    if (esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi_event, NULL) != ESP_OK) {
        return false;
    }
    if (esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_wifi_event, NULL) != ESP_OK) {
        return false;
    }

    wifi_config_t wcfg;
    memset(&wcfg, 0, sizeof(wcfg));
    size_t ssid_len = strnlen(cfg->wifi_ssid, sizeof(wcfg.sta.ssid) - 1);
    memcpy(wcfg.sta.ssid, cfg->wifi_ssid, ssid_len);
    size_t pass_len = strnlen(cfg->wifi_pass, sizeof(wcfg.sta.password) - 1);
    memcpy(wcfg.sta.password, cfg->wifi_pass, pass_len);
    wcfg.sta.threshold.authmode = cfg->wifi_pass[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;

    if (esp_wifi_set_storage(WIFI_STORAGE_RAM) != ESP_OK) return false;
    if (esp_wifi_set_mode(WIFI_MODE_STA) != ESP_OK) return false;
    if (esp_wifi_set_config(WIFI_IF_STA, &wcfg) != ESP_OK) return false;
    if (esp_wifi_start() != ESP_OK) return false;
    return true;
}

bool pa_net_is_wifi_connected(void)
{
    return s_wifi_connected;
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

int pa_net_fetch_digest(const pa_net_config_t *cfg, const char *since_rev, pa_digest_t *out)
{
    char url[240];
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
    char url[460];
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
