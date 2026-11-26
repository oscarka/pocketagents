// main/pa_portal.c
// Temporary APSTA SoftAP Captive Portal (PocketAgents-Setup @ 192.168.4.1) for phone Wi-Fi + Hub setup.
// Strictly bounded memory, socket, and POST body limits for ESP32-C3 (no PSRAM).
#include "pa_portal.h"
#include "pa_model.h"

#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>

static const char *TAG = "pa_portal";

#define PA_PORTAL_MAX_POST_BYTES 768
#define PA_PORTAL_MAX_SCAN_APS   12

static pa_net_config_t *s_cfg = NULL;
static pa_portal_phone_cb_t s_on_phone = NULL;
static pa_portal_saved_cb_t s_on_saved = NULL;
static httpd_handle_t s_httpd = NULL;
static TaskHandle_t s_dns_task = NULL;
static volatile bool s_active = false;
static volatile bool s_phone_connected = false;
static bool s_events_registered = false;

static void log_heap(const char *stage)
{
    ESP_LOGI(TAG, "[PA-PORTAL] %s: free_heap=%lu largest_block=%lu",
             stage,
             (unsigned long)esp_get_free_heap_size(),
             (unsigned long)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
}

// Compact mobile-first Chinese phone setup page stored in Flash (.rodata)
static const char PORTAL_HTML[] =
    "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'/>"
    "<meta name='viewport' content='width=device-width,initial-scale=1'/>"
    "<title>口袋代理配网</title><style>"
    "*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;"
    "background:#08101e;color:#f1f5f9;padding:18px 14px 40px;line-height:1.5}"
    ".box{max-width:460px;margin:0 auto;display:flex;flex-direction:column;gap:14px}"
    ".card{background:#111c30;border:1px solid #243654;border-radius:14px;padding:16px}"
    "h1{font-size:20px;margin-bottom:4px}.sub{font-size:13px;color:#94a3b8}"
    "h2{font-size:15px;color:#38bdf8;margin-bottom:10px}"
    "label{display:block;font-size:13px;color:#cbd5e1;margin:10px 0 4px}"
    "input{width:100%;padding:11px;border-radius:10px;border:1px solid #2d4368;"
    "background:#091120;color:#fff;font-size:15px}"
    ".aps{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}"
    ".ap{padding:7px 11px;border-radius:8px;border:1px solid #2d4368;background:#162540;"
    "color:#e2e8f0;font-size:13px;cursor:pointer}"
    ".ap:active{background:#0ea5e9;color:#041018}"
    ".btn{width:100%;padding:13px;border:0;border-radius:12px;font-size:16px;font-weight:700;"
    "background:#10b981;color:#04130d;margin-top:14px;cursor:pointer}"
    ".btn2{padding:7px 12px;border-radius:8px;border:1px solid #38bdf8;background:transparent;"
    "color:#7dd3fc;font-size:12px;cursor:pointer}"
    ".tip{font-size:12px;color:#fcd34d;background:rgba(245,158,11,.12);"
    "border:1px solid rgba(245,158,11,.35);padding:9px 11px;border-radius:9px;margin-top:8px}"
    "</style></head><body><div class='box'>"
    "<div class='card'><h1>🪪 口袋代理 · 手机配网</h1>"
    "<div class='sub' id='st'>请为 AI Passport 选择 2.4GHz Wi-Fi</div></div>"
    "<form class='card' method='POST' action='/save'>"
    "<h2>① 连接 Wi-Fi（必填）</h2>"
    "<div style='display:flex;justify-content:space-between;align-items:center'>"
    "<span class='sub'>点选附近 2.4G 热点或直接输入</span>"
    "<button type='button' class='btn2' onclick='scan()'>刷新列表</button></div>"
    "<div class='aps' id='aps'><span class='sub'>正在扫描附近 Wi-Fi...</span></div>"
    "<label>2.4GHz Wi-Fi 名称</label>"
    "<input id='ssid' name='ssid' required placeholder='例如 MyHome_2.4G'/>"
    "<label>Wi-Fi 密码（无密码请留空）</label>"
    "<input id='pass' name='pass' type='password' placeholder='输入 Wi-Fi 密码'/>"
    "<div class='tip'>⚠️ 仅支持 2.4GHz Wi-Fi（不支持 5GHz）</div>"
    "<h2 style='margin-top:18px'>② PocketAgents 电脑地址（选填）</h2>"
    "<div class='sub'>还没开电脑可先留空，连好 Wi-Fi 后随时长按设备 ↑ 键再补填。</div>"
    "<label>服务器地址</label>"
    "<input id='hub' name='hub' placeholder='例如 http://192.168.1.25:8788'/>"
    "<label>6 位配对码 或 设备令牌</label>"
    "<input id='token' name='token' placeholder='电脑终端里的 6 位配对码，如 MF9AJP'/>"
    "<button class='btn' type='submit'>保存并连接 Wi-Fi</button>"
    "</form></div><script>"
    "async function loadSt(){try{let r=await fetch('/status');let d=await r.json();"
    "if(d.ssid)document.getElementById('ssid').value=d.ssid;"
    "if(d.hub)document.getElementById('hub').value=d.hub;"
    "if(d.hasToken)document.getElementById('token').placeholder='已保存通行证（留空保持不变）';"
    "if(d.wifiOk)document.getElementById('st').textContent='已连 Wi-Fi ('+d.ip+') · 可直接修改设置';"
    "}catch(e){}}"
    "async function scan(){let el=document.getElementById('aps');el.innerHTML='<span class=sub>扫描中...</span>';"
    "try{let r=await fetch('/scan');let d=await r.json();el.innerHTML='';"
    "if(!d.aps||!d.aps.length){el.innerHTML='<span class=sub>未扫到热点，请手动输入名称</span>';return;}"
    "d.aps.forEach(a=>{let b=document.createElement('button');b.type='button';b.className='ap';"
    "b.textContent=a.s+(a.o?' (免密)':'')+' '+a.r+'dBm';"
    "b.onclick=()=>{document.getElementById('ssid').value=a.s;document.getElementById('pass').focus();};"
    "el.appendChild(b);});}catch(e){el.innerHTML='<span class=sub>扫描失败，请手动输入</span>';}}"
    "loadSt();scan();</script></body></html>";

static const char SAVE_OK_HTML[] =
    "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'/>"
    "<meta name='viewport' content='width=device-width,initial-scale=1'/>"
    "<title>已保存</title><style>body{font-family:-apple-system,sans-serif;background:#08101e;"
    "color:#f1f5f9;padding:36px 18px;text-align:center}.card{max-width:420px;margin:0 auto;"
    "background:#111c30;border:1px solid #10b981;border-radius:16px;padding:24px}"
    "h1{color:#10b981;font-size:22px;margin-bottom:12px}p{color:#cbd5e1;font-size:15px;line-height:1.6}"
    "</style></head><body><div class='card'><h1>✅ 配置已保存</h1>"
    "<p>AI Passport 正在连接你的 Wi-Fi（约 3～5 秒）。<br/>"
    "连网成功后此临时热点会自动关闭，请看小工牌屏幕！</p>"
    "<p style='margin-top:12px;font-size:13px;color:#94a3b8'>如果密码输错没连上，长按设备 ↑ 键可随时重配。</p>"
    "</div></body></html>";

// Escape JSON string safely into dst
static size_t json_escape(const char *src, char *dst, size_t dst_size)
{
    if (!dst || dst_size == 0) return 0;
    size_t pos = 0;
    for (size_t i = 0; src && src[i] != '\0' && pos + 2 < dst_size; i++) {
        unsigned char c = (unsigned char)src[i];
        if (c == '"' || c == '\\') {
            if (pos + 3 >= dst_size) break;
            dst[pos++] = '\\';
            dst[pos++] = (char)c;
        } else if (c >= 0x20) {
            dst[pos++] = (char)c;
        }
    }
    dst[pos] = '\0';
    return pos;
}

static esp_err_t handle_root(httpd_req_t *req)
{
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, PORTAL_HTML, HTTPD_RESP_USE_STRLEN);
}

static esp_err_t handle_status(httpd_req_t *req)
{
    char ssid_esc[140] = { 0 };
    char hub_esc[340] = { 0 };
    char ip[24] = { 0 };
    pa_net_get_ip_str(ip, sizeof(ip));
    if (s_cfg) {
        if (s_cfg->has_saved_wifi) json_escape(s_cfg->wifi_ssid, ssid_esc, sizeof(ssid_esc));
        if (s_cfg->has_saved_hub) json_escape(s_cfg->hub_url, hub_esc, sizeof(hub_esc));
    }
    char buf[640];
    snprintf(buf, sizeof(buf),
             "{\"ok\":true,\"ssid\":\"%s\",\"hub\":\"%s\",\"hasToken\":%s,\"wifiOk\":%s,\"ip\":\"%s\"}",
             ssid_esc, hub_esc,
             (s_cfg && s_cfg->hub_token[0]) ? "true" : "false",
             pa_net_is_wifi_connected() ? "true" : "false",
             ip);
    httpd_resp_set_type(req, "application/json; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, buf, HTTPD_RESP_USE_STRLEN);
}

static esp_err_t handle_scan(httpd_req_t *req)
{
    wifi_scan_config_t sc = { 0 };
    sc.show_hidden = false;
    sc.scan_type = WIFI_SCAN_TYPE_ACTIVE;
    sc.scan_time.active.min = 80;
    sc.scan_time.active.max = 180;

    static wifi_ap_record_t recs[PA_PORTAL_MAX_SCAN_APS];
    uint16_t count = PA_PORTAL_MAX_SCAN_APS;
    esp_err_t serr = esp_wifi_scan_start(&sc, true);
    if (serr != ESP_OK) {
        vTaskDelay(pdMS_TO_TICKS(200));
        serr = esp_wifi_scan_start(&sc, true);
    }
    if (serr != ESP_OK) {
        ESP_LOGW(TAG, "[PA-PORTAL] Wi-Fi scan failed: %s", esp_err_to_name(serr));
        count = 0;
    } else if (esp_wifi_scan_get_ap_records(&count, recs) != ESP_OK) {
        count = 0;
    }

    static char json_buf[1536];
    size_t pos = (size_t)snprintf(json_buf, sizeof(json_buf), "{\"ok\":true,\"aps\":[");
    bool first = true;
    for (uint16_t i = 0; i < count; i++) {
        const char *ssid = (const char *)recs[i].ssid;
        if (!ssid[0] || strcmp(ssid, PA_PORTAL_AP_SSID) == 0) continue;
        // Skip duplicate SSIDs
        bool dup = false;
        for (uint16_t j = 0; j < i; j++) {
            if (strcmp((const char *)recs[j].ssid, ssid) == 0) {
                dup = true;
                break;
            }
        }
        if (dup) continue;

        char esc[80];
        json_escape(ssid, esc, sizeof(esc));
        int n = snprintf(json_buf + pos, sizeof(json_buf) - pos,
                         "%s{\"s\":\"%s\",\"r\":%d,\"o\":%s}",
                         first ? "" : ",", esc, (int)recs[i].rssi,
                         recs[i].authmode == WIFI_AUTH_OPEN ? "true" : "false");
        if (n <= 0 || pos + (size_t)n + 8 >= sizeof(json_buf)) break;
        pos += (size_t)n;
        first = false;
    }
    snprintf(json_buf + pos, sizeof(json_buf) - pos, "]}");
    httpd_resp_set_type(req, "application/json; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, json_buf, HTTPD_RESP_USE_STRLEN);
}

static esp_err_t handle_save(httpd_req_t *req)
{
    if (req->content_len <= 0 || req->content_len > PA_PORTAL_MAX_POST_BYTES) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Form body invalid or too large");
        return ESP_OK;
    }

    char body[PA_PORTAL_MAX_POST_BYTES + 1];
    int received = 0;
    while (received < req->content_len) {
        int r = httpd_req_recv(req, body + received, req->content_len - received);
        if (r <= 0) {
            if (r == HTTPD_SOCK_ERR_TIMEOUT) continue;
            httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Read aborted");
            return ESP_OK;
        }
        received += r;
    }
    body[received] = '\0';

    char ssid[64] = { 0 };
    char pass[64] = { 0 };
    char hub[160] = { 0 };
    char token[96] = { 0 };
    (void)pa_parse_form_field(body, "ssid", ssid, sizeof(ssid));
    (void)pa_parse_form_field(body, "pass", pass, sizeof(pass));
    (void)pa_parse_form_field(body, "hub", hub, sizeof(hub));
    (void)pa_parse_form_field(body, "token", token, sizeof(token));

    if (!ssid[0] && (!s_cfg || !s_cfg->has_saved_wifi)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Wi-Fi SSID required");
        return ESP_OK;
    }

    if (s_cfg) {
        (void)pa_net_save_portal_config(s_cfg, ssid, pass, true, hub, token, true);
    }

    httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_send(req, SAVE_OK_HTML, HTTPD_RESP_USE_STRLEN);

    if (s_on_saved) s_on_saved();
    return ESP_OK;
}

static esp_err_t handle_captive_redirect(httpd_req_t *req, httpd_err_code_t err)
{
    (void)err;
    httpd_resp_set_status(req, "302 Found");
    httpd_resp_set_hdr(req, "Location", "http://192.168.4.1/");
    httpd_resp_set_type(req, "text/plain");
    httpd_resp_send(req, "Redirecting to PocketAgents setup...", HTTPD_RESP_USE_STRLEN);
    return ESP_OK;
}

// Wildcard DNS server on UDP/53 -> resolves every domain to 192.168.4.1 for iOS/Android Captive Portal
static void dns_captive_task(void *arg)
{
    (void)arg;
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock < 0) {
        ESP_LOGW(TAG, "DNS socket create failed");
        s_dns_task = NULL;
        vTaskDelete(NULL);
        return;
    }

    struct timeval tv = { .tv_sec = 0, .tv_usec = 500000 };
    (void)setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    struct sockaddr_in addr = { 0 };
    addr.sin_family = AF_INET;
    addr.sin_port = htons(53);
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        ESP_LOGW(TAG, "DNS bind(53) failed");
        close(sock);
        s_dns_task = NULL;
        vTaskDelete(NULL);
        return;
    }

    static uint8_t pkt[512];
    static const uint8_t ap_ip[4] = { 192, 168, 4, 1 };
    while (s_active) {
        struct sockaddr_in client = { 0 };
        socklen_t clen = sizeof(client);
        int len = recvfrom(sock, pkt, sizeof(pkt) - 16, 0, (struct sockaddr *)&client, &clen);
        if (len < 12) continue;

        size_t rlen = pa_dns_build_captive_reply(pkt, (size_t)len, sizeof(pkt), ap_ip);
        if (rlen > 0) {
            (void)sendto(sock, pkt, rlen, 0, (struct sockaddr *)&client, clen);
        }
    }

    close(sock);
    s_dns_task = NULL;
    vTaskDelete(NULL);
}

static void on_ap_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)data;
    if (base == WIFI_EVENT && id == WIFI_EVENT_AP_STACONNECTED) {
        ESP_LOGI(TAG, "[PA-PORTAL] Phone associated with SoftAP (waiting for DHCP)");
    } else if (base == IP_EVENT && id == IP_EVENT_AP_STAIPASSIGNED) {
        s_phone_connected = true;
        ESP_LOGI(TAG, "[PA-PORTAL] Phone received DHCP lease (ready for 192.168.4.1)");
        log_heap("phone_dhcp_assigned");
        if (s_on_phone) s_on_phone(true);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_AP_STADISCONNECTED) {
        s_phone_connected = false;
        if (s_on_phone) s_on_phone(false);
    }
}

bool pa_portal_start(pa_net_config_t *cfg,
                     pa_portal_phone_cb_t on_phone,
                     pa_portal_saved_cb_t on_saved)
{
    if (s_active) return true;
    s_cfg = cfg;
    s_on_phone = on_phone;
    s_on_saved = on_saved;
    s_phone_connected = false;

    log_heap("before_portal_start");

    if (!s_events_registered) {
        (void)esp_event_handler_register(WIFI_EVENT, WIFI_EVENT_AP_STACONNECTED, on_ap_event, NULL);
        (void)esp_event_handler_register(WIFI_EVENT, WIFI_EVENT_AP_STADISCONNECTED, on_ap_event, NULL);
        (void)esp_event_handler_register(IP_EVENT, IP_EVENT_AP_STAIPASSIGNED, on_ap_event, NULL);
        s_events_registered = true;
    }

    // Pause STA reconnect loop BEFORE entering APSTA so single-radio ESP32-C3 holds channel 1 steadily
    // (prevents phone disconnects and ESP_ERR_WIFI_STATE failures during /scan!)
    pa_net_wifi_pause_for_portal();

    wifi_config_t ap_cfg = { 0 };
    size_t slen = strlen(PA_PORTAL_AP_SSID);
    memcpy(ap_cfg.ap.ssid, PA_PORTAL_AP_SSID, slen);
    ap_cfg.ap.ssid_len = (uint8_t)slen;
    ap_cfg.ap.channel = 1;
    ap_cfg.ap.max_connection = 2;
    ap_cfg.ap.authmode = WIFI_AUTH_OPEN;

    if (esp_wifi_set_mode(WIFI_MODE_APSTA) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to switch to APSTA mode");
        pa_net_set_sta_autoreconnect(true);
        return false;
    }
    if (esp_wifi_set_config(WIFI_IF_AP, &ap_cfg) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to apply SoftAP config");
        (void)esp_wifi_set_mode(WIFI_MODE_STA);
        pa_net_set_sta_autoreconnect(true);
        return false;
    }

    httpd_config_t hcfg = HTTPD_DEFAULT_CONFIG();
    hcfg.max_open_sockets = 5;
    hcfg.lru_purge_enable = true;
    hcfg.stack_size = 5120;
    hcfg.max_uri_handlers = 8;
    hcfg.recv_wait_timeout = 5;
    hcfg.send_wait_timeout = 5;
    hcfg.uri_match_fn = httpd_uri_match_wildcard;

    if (httpd_start(&s_httpd, &hcfg) != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed");
        (void)esp_wifi_set_mode(WIFI_MODE_STA);
        return false;
    }

    const httpd_uri_t u_root = { .uri = "/", .method = HTTP_GET, .handler = handle_root };
    const httpd_uri_t u_status = { .uri = "/status", .method = HTTP_GET, .handler = handle_status };
    const httpd_uri_t u_scan = { .uri = "/scan", .method = HTTP_GET, .handler = handle_scan };
    const httpd_uri_t u_save = { .uri = "/save", .method = HTTP_POST, .handler = handle_save };
    (void)httpd_register_uri_handler(s_httpd, &u_root);
    (void)httpd_register_uri_handler(s_httpd, &u_status);
    (void)httpd_register_uri_handler(s_httpd, &u_scan);
    (void)httpd_register_uri_handler(s_httpd, &u_save);
    (void)httpd_register_err_handler(s_httpd, HTTPD_404_NOT_FOUND, handle_captive_redirect);

    s_active = true;
    xTaskCreate(dns_captive_task, "pa_dns", 2560, NULL, 2, &s_dns_task);

    ESP_LOGI(TAG, "[PA-PORTAL] SoftAP started: SSID=%s URL=http://192.168.4.1/", PA_PORTAL_AP_SSID);
    log_heap("after_portal_start");
    return true;
}

void pa_portal_stop(void)
{
    if (!s_active && !s_httpd) return;
    s_active = false;
    s_phone_connected = false;

    if (s_httpd) {
        (void)httpd_stop(s_httpd);
        s_httpd = NULL;
    }
    // Wait up to 800ms for DNS task to exit its 500ms recv timeout cleanly
    for (int i = 0; i < 16 && s_dns_task != NULL; i++) {
        vTaskDelay(pdMS_TO_TICKS(50));
    }
    (void)esp_wifi_set_mode(WIFI_MODE_STA);
    pa_net_set_sta_autoreconnect(true);
    ESP_LOGI(TAG, "[PA-PORTAL] SoftAP stopped, back to pure STA mode");
    log_heap("after_portal_stop");
}

bool pa_portal_is_active(void)
{
    return s_active;
}

bool pa_portal_is_phone_connected(void)
{
    return s_phone_connected;
}
