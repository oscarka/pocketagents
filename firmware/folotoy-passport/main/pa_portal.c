// main/pa_portal.c
// Battle-tested APSTA SoftAP Captive Portal (modeled on 78/esp-wifi-connect WifiConfigurationAp):
// - Non-blocking background AP scanner with mutex-protected RSSI-sorted cache (0ms /scan response!)
// - Explicit OS captive-portal probes (iOS/Android/Windows) + EDNS0 wildcard DNS + Connection: close
// - Live Wi-Fi connection verification in /save with exact Chinese error feedback before closing SoftAP
// - Strictly bounded memory & sockets for ESP32-C3 (no PSRAM)
#include "pa_portal.h"
#include "pa_model.h"

#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lwip/sockets.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>

static const char *TAG = "pa_portal";

#define PA_PORTAL_MAX_POST_BYTES 768
#define PA_PORTAL_MAX_SCAN_APS   16

typedef struct {
    char ssid[33];
    int8_t rssi;
    bool open;
} cached_ap_t;

static pa_net_config_t *s_cfg = NULL;
static pa_portal_phone_cb_t s_on_phone = NULL;
static pa_portal_saved_cb_t s_on_saved = NULL;
static httpd_handle_t s_httpd = NULL;
static TaskHandle_t s_dns_task = NULL;
static esp_timer_handle_t s_scan_timer = NULL;
static SemaphoreHandle_t s_scan_mux = NULL;
static esp_event_handler_instance_t s_wifi_ev_inst = NULL;
static esp_event_handler_instance_t s_ip_ev_inst = NULL;

static volatile bool s_active = false;
static volatile bool s_phone_connected = false;
static volatile bool s_is_connecting = false;
static char s_ap_ssid[32] = "PocketAgents-Setup";

static cached_ap_t s_scan_cache[PA_PORTAL_MAX_SCAN_APS];
static int s_scan_count = 0;
static bool s_scan_done_once = false;

static void log_heap(const char *stage)
{
    ESP_LOGI(TAG, "[PA-PORTAL] %s: free_heap=%lu largest_block=%lu",
             stage,
             (unsigned long)esp_get_free_heap_size(),
             (unsigned long)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
}

void pa_portal_get_ap_ssid(char *out, size_t out_size)
{
    if (!out || out_size == 0) return;
    uint8_t mac[6] = { 0 };
    if (esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP) == ESP_OK) {
        snprintf(out, out_size, "%s-%02X%02X", PA_PORTAL_AP_PREFIX, mac[4], mac[5]);
    } else {
        snprintf(out, out_size, "%s-Setup", PA_PORTAL_AP_PREFIX);
    }
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
    ".btn:disabled{opacity:.55;cursor:not-allowed}"
    ".btn2{padding:7px 12px;border-radius:8px;border:1px solid #38bdf8;background:transparent;"
    "color:#7dd3fc;font-size:12px;cursor:pointer}"
    ".btn-ghost{width:100%;padding:10px;border-radius:10px;border:1px solid #334155;"
    "background:transparent;color:#94a3b8;font-size:13px;margin-top:8px;cursor:pointer}"
    ".tip{font-size:12px;color:#fcd34d;background:rgba(245,158,11,.12);"
    "border:1px solid rgba(245,158,11,.35);padding:9px 11px;border-radius:9px;margin-top:8px}"
    ".msg{display:none;margin-top:12px;padding:11px 12px;border-radius:10px;font-size:13.5px;line-height:1.5}"
    ".msg.err{display:block;background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.45);color:#fecaca}"
    ".msg.ok{display:block;background:rgba(16,185,129,.15);border:1px solid rgba(16,185,129,.45);color:#a7f3d0}"
    ".msg.wait{display:block;background:rgba(56,189,248,.14);border:1px solid rgba(56,189,248,.4);color:#bae6fd}"
    "</style></head><body><div class='box'>"
    "<div class='card'><h1>🪪 口袋代理 · 手机配网</h1>"
    "<div class='sub' id='st'>请为 AI Passport 选择 2.4GHz Wi-Fi（提交时将实时验证密码）</div></div>"
    "<form class='card' id='frm' method='POST' action='/save'>"
    "<h2>① 连接 Wi-Fi（必填）</h2>"
    "<div style='display:flex;justify-content:space-between;align-items:center'>"
    "<span class='sub'>点选附近 2.4G 热点或直接输入</span>"
    "<button type='button' class='btn2' onclick='scan(true)'>刷新列表</button></div>"
    "<div class='aps' id='aps'><span class='sub'>正在读取附近 Wi-Fi...</span></div>"
    "<label>2.4GHz Wi-Fi 名称</label>"
    "<input id='ssid' name='ssid' required maxlength='32' placeholder='例如 MyHome_2.4G'/>"
    "<label>Wi-Fi 密码（无密码请留空）</label>"
    "<input id='pass' name='pass' type='password' maxlength='64' placeholder='输入 Wi-Fi 密码'/>"
    "<input type='hidden' id='open_wifi' name='open_wifi' value='0'/>"
    "<div class='tip'>⚠️ 仅支持 2.4GHz Wi-Fi（不支持 5GHz）；提交后会实时验证是否连上。</div>"
    "<h2 style='margin-top:18px'>② PocketAgents 电脑/云端地址（选填）</h2>"
    "<div class='sub'>还没开电脑可先留空，连好 Wi-Fi 后随时长按设备 ↑ 键再补填。</div>"
    "<label>服务器地址</label>"
    "<input id='hub' name='hub' placeholder='例如 http://192.168.1.25:8788 或你的云端 Hub 地址'/>"
    "<label>6 位配对码 或 设备令牌</label>"
    "<input id='token' name='token' placeholder='电脑终端里的 6 位配对码，如 MF9AJP'/>"
    "<div id='msg' class='msg'></div>"
    "<button class='btn' id='subBtn' type='submit'>验证并连接 Wi-Fi</button>"
    "<button class='btn-ghost' id='forceBtn' type='button' style='display:none' onclick='doSave(true)'>跳过验证，强制保存此配置</button>"
    "</form></div><script>"
    "function setMsg(cls,txt){var m=document.getElementById('msg');m.className='msg '+cls;m.textContent=txt;}"
    "async function loadSt(){try{let r=await fetch('/status');let d=await r.json();"
    "if(d.ssid)document.getElementById('ssid').value=d.ssid;"
    "if(d.hub)document.getElementById('hub').value=d.hub;"
    "if(d.hasToken)document.getElementById('token').placeholder='已保存通行证（留空保持不变）';"
    "if(d.wifiOk)document.getElementById('st').textContent='已连 Wi-Fi ('+d.ip+') · 可直接修改设置';"
    "}catch(e){}}"
    "async function scan(refresh){let el=document.getElementById('aps');"
    "if(refresh)el.innerHTML='<span class=sub>正在刷新扫描...</span>';"
    "try{let r=await fetch(refresh?'/scan?refresh=1':'/scan');let d=await r.json();el.innerHTML='';"
    "if(!d.aps||!d.aps.length){el.innerHTML='<span class=sub>'+(d.scanning?'后台扫描中，请稍等 2 秒...':'未扫到热点，请手动输入名称')+'</span>';"
    "if(d.scanning||refresh)setTimeout(()=>scan(false),2200);return;}"
    "d.aps.forEach(a=>{let b=document.createElement('button');b.type='button';b.className='ap';"
    "b.textContent=a.s+(a.o?' (免密)':'')+' '+a.r+'dBm';"
    "b.onclick=()=>{document.getElementById('ssid').value=a.s;document.getElementById('open_wifi').value=a.o?'1':'0';"
    "if(a.o){document.getElementById('pass').value='';}else{document.getElementById('pass').focus();}};"
    "el.appendChild(b);});}catch(e){el.innerHTML='<span class=sub>读取失败，请手动输入名称</span>';}}"
    "async function doSave(force){var btn=document.getElementById('subBtn');var fbtn=document.getElementById('forceBtn');"
    "var ssid=document.getElementById('ssid').value.trim();if(!ssid){setMsg('err','请先填写 Wi-Fi 名称');return;}"
    "btn.disabled=true;fbtn.style.display='none';"
    "setMsg('wait',force?'正在保存配置...':'⏳ 正在实测连接 '+ssid+'（最多 15 秒，请勿关闭页面）...');"
    "var body=new URLSearchParams({ssid:ssid,pass:document.getElementById('pass').value,"
    "open_wifi:document.getElementById('open_wifi').value,hub:document.getElementById('hub').value.trim(),"
    "token:document.getElementById('token').value.trim(),force:force?'1':'0'});"
    "try{let r=await fetch('/save',{method:'POST',headers:{'Accept':'application/json','Content-Type':'application/x-www-form-urlencoded'},body:body.toString()});"
    "let d=await r.json();if(d.ok){setMsg('ok','✅ '+(d.ip?'已连上 Wi-Fi ('+d.ip+')！':'配置已保存！')+'临时热点即将自动关闭，请看小工牌屏幕！');"
    "}else{setMsg('err','❌ '+(d.error||'连接失败，请检查密码或是否选了 5GHz'));fbtn.style.display='block';btn.disabled=false;}"
    "}catch(e){setMsg('ok','✅ 配置已提交！设备正在切回主 Wi-Fi，请看小工牌屏幕状态。');}}"
    "document.getElementById('frm').addEventListener('submit',function(e){e.preventDefault();doSave(false);});"
    "document.getElementById('pass').addEventListener('input',function(){document.getElementById('open_wifi').value='0';});"
    "loadSt();scan(false);</script></body></html>";

static const char SAVE_OK_HTML[] =
    "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'/>"
    "<meta name='viewport' content='width=device-width,initial-scale=1'/>"
    "<title>已保存</title><style>body{font-family:-apple-system,sans-serif;background:#08101e;"
    "color:#f1f5f9;padding:36px 18px;text-align:center}.card{max-width:420px;margin:0 auto;"
    "background:#111c30;border:1px solid #10b981;border-radius:16px;padding:24px}"
    "h1{color:#10b981;font-size:22px;margin-bottom:12px}p{color:#cbd5e1;font-size:15px;line-height:1.6}"
    "</style></head><body><div class='card'><h1>✅ 配置已保存</h1>"
    "<p>AI Passport 正在连接你的 Wi-Fi（约 2～4 秒）。<br/>"
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

static void trigger_async_scan(void)
{
    if (!s_active || s_is_connecting) return;
    wifi_scan_config_t sc;
    memset(&sc, 0, sizeof(sc));
    sc.show_hidden = false;
    sc.scan_type = WIFI_SCAN_TYPE_ACTIVE;
    sc.scan_time.active.min = 60;
    sc.scan_time.active.max = 120;
    esp_err_t err = esp_wifi_scan_start(&sc, false);
    if (err != ESP_OK && err != ESP_ERR_WIFI_STATE) {
        ESP_LOGW(TAG, "[PA-PORTAL] Async scan start returned %s", esp_err_to_name(err));
    }
}

static void on_scan_timer(void *arg)
{
    (void)arg;
    trigger_async_scan();
}

static void refresh_scan_cache_from_driver(void)
{
    uint16_t ap_num = 0;
    if (esp_wifi_scan_get_ap_num(&ap_num) != ESP_OK || ap_num == 0) {
        s_scan_done_once = true;
        return;
    }
    uint16_t fetch_n = ap_num > 24 ? 24 : ap_num;
    wifi_ap_record_t *recs = (wifi_ap_record_t *)malloc(fetch_n * sizeof(wifi_ap_record_t));
    if (!recs) return;

    if (esp_wifi_scan_get_ap_records(&fetch_n, recs) != ESP_OK) {
        free(recs);
        return;
    }

    // Insertion-sort by RSSI descending so strongest 2.4GHz networks appear first
    for (uint16_t i = 1; i < fetch_n; i++) {
        wifi_ap_record_t key = recs[i];
        int j = (int)i - 1;
        while (j >= 0 && recs[j].rssi < key.rssi) {
            recs[j + 1] = recs[j];
            j--;
        }
        recs[j + 1] = key;
    }

    if (s_scan_mux && xSemaphoreTake(s_scan_mux, pdMS_TO_TICKS(150)) == pdTRUE) {
        int out_n = 0;
        for (uint16_t i = 0; i < fetch_n && out_n < PA_PORTAL_MAX_SCAN_APS; i++) {
            char ssid_tmp[33];
            memcpy(ssid_tmp, recs[i].ssid, 32);
            ssid_tmp[32] = '\0';
            if (!ssid_tmp[0] || strcmp(ssid_tmp, s_ap_ssid) == 0) continue;

            bool dup = false;
            for (int k = 0; k < out_n; k++) {
                if (strcmp(s_scan_cache[k].ssid, ssid_tmp) == 0) {
                    dup = true;
                    break;
                }
            }
            if (dup) continue;

            memcpy(s_scan_cache[out_n].ssid, ssid_tmp, sizeof(s_scan_cache[out_n].ssid));
            s_scan_cache[out_n].rssi = recs[i].rssi;
            s_scan_cache[out_n].open = (recs[i].authmode == WIFI_AUTH_OPEN);
            out_n++;
        }
        s_scan_count = out_n;
        s_scan_done_once = true;
        xSemaphoreGive(s_scan_mux);
    }

    free(recs);
}

static esp_err_t handle_root(httpd_req_t *req)
{
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_set_hdr(req, "Connection", "close");
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
    httpd_resp_set_hdr(req, "Connection", "close");
    return httpd_resp_send(req, buf, HTTPD_RESP_USE_STRLEN);
}

static esp_err_t handle_scan(httpd_req_t *req)
{
    if (strstr(req->uri, "refresh=1") != NULL) {
        trigger_async_scan();
    }

    httpd_resp_set_type(req, "application/json; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_set_hdr(req, "Connection", "close");

    // Stream cached scan results via chunked response (78/esp-wifi-connect pattern: ~160B stack vs 1.6KB)
    httpd_resp_sendstr_chunk(req, s_scan_done_once ? "{\"ok\":true,\"scanning\":false,\"aps\":["
                                                   : "{\"ok\":true,\"scanning\":true,\"aps\":[");
    if (s_scan_mux && xSemaphoreTake(s_scan_mux, pdMS_TO_TICKS(150)) == pdTRUE) {
        for (int i = 0; i < s_scan_count; i++) {
            char esc[80];
            char item[144];
            json_escape(s_scan_cache[i].ssid, esc, sizeof(esc));
            snprintf(item, sizeof(item), "%s{\"s\":\"%s\",\"r\":%d,\"o\":%s}",
                     i == 0 ? "" : ",", esc, (int)s_scan_cache[i].rssi,
                     s_scan_cache[i].open ? "true" : "false");
            httpd_resp_sendstr_chunk(req, item);
        }
        xSemaphoreGive(s_scan_mux);
    }
    httpd_resp_sendstr_chunk(req, "]}");
    return httpd_resp_sendstr_chunk(req, NULL);
}

static bool request_wants_json(httpd_req_t *req)
{
    char accept[64] = { 0 };
    if (httpd_req_get_hdr_value_str(req, "Accept", accept, sizeof(accept)) == ESP_OK) {
        return strstr(accept, "application/json") != NULL;
    }
    return false;
}

static esp_err_t handle_save(httpd_req_t *req)
{
    bool wants_json = request_wants_json(req);
    if (req->content_len <= 0 || req->content_len > PA_PORTAL_MAX_POST_BYTES) {
        httpd_resp_set_hdr(req, "Connection", "close");
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Form body invalid or too large");
        return ESP_OK;
    }

    char body[PA_PORTAL_MAX_POST_BYTES + 1];
    int received = 0;
    while (received < req->content_len) {
        int r = httpd_req_recv(req, body + received, req->content_len - received);
        if (r <= 0) {
            if (r == HTTPD_SOCK_ERR_TIMEOUT) continue;
            httpd_resp_set_hdr(req, "Connection", "close");
            httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Read aborted");
            return ESP_OK;
        }
        received += r;
    }
    body[received] = '\0';

    char ssid[64] = { 0 };
    char pass[65] = { 0 };
    char hub[160] = { 0 };
    char token[96] = { 0 };
    char force_str[8] = { 0 };
    char open_str[8] = { 0 };
    (void)pa_parse_form_field(body, "ssid", ssid, sizeof(ssid));
    (void)pa_parse_form_field(body, "pass", pass, sizeof(pass));
    (void)pa_parse_form_field(body, "hub", hub, sizeof(hub));
    (void)pa_parse_form_field(body, "token", token, sizeof(token));
    (void)pa_parse_form_field(body, "force", force_str, sizeof(force_str));
    (void)pa_parse_form_field(body, "open_wifi", open_str, sizeof(open_str));

    bool force_save = (strcmp(force_str, "1") == 0);
    bool explicit_open = (strcmp(open_str, "1") == 0);
    bool keep_pass_if_empty = !explicit_open;

    if (!ssid[0] && (!s_cfg || !s_cfg->has_saved_wifi)) {
        httpd_resp_set_hdr(req, "Connection", "close");
        if (wants_json) {
            httpd_resp_set_type(req, "application/json; charset=utf-8");
            httpd_resp_send(req, "{\"ok\":false,\"error\":\"请填写 Wi-Fi 名称\"}", HTTPD_RESP_USE_STRLEN);
        } else {
            httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Wi-Fi SSID required");
        }
        return ESP_OK;
    }

    // Resolve effective SSID/password for live verification
    const char *eff_ssid = ssid[0] ? ssid : (s_cfg ? s_cfg->wifi_ssid : "");
    const char *eff_pass = pass;
    if (!pass[0] && keep_pass_if_empty && s_cfg && strcmp(eff_ssid, s_cfg->wifi_ssid) == 0) {
        eff_pass = s_cfg->wifi_pass;
    }

    uint8_t probed_ch = 0;
    char probed_ip[24] = { 0 };
    if (!force_save && eff_ssid[0]) {
        s_is_connecting = true;
        if (s_scan_timer) (void)esp_timer_stop(s_scan_timer);
        int fail_reason = 0;
        bool ok = pa_net_probe_connect(eff_ssid, eff_pass, &probed_ch, &fail_reason,
                                       probed_ip, sizeof(probed_ip));
        s_is_connecting = false;

        if (!ok) {
            if (s_scan_timer && s_active) {
                (void)esp_timer_start_once(s_scan_timer, 5LL * 1000000LL);
            }
            char reason_zh[64];
            pa_wifi_reason_zh(fail_reason, reason_zh, sizeof(reason_zh));
            char reason_esc[128];
            json_escape(reason_zh, reason_esc, sizeof(reason_esc));
            char resp[256];
            snprintf(resp, sizeof(resp),
                     "{\"ok\":false,\"reason\":%d,\"error\":\"%s，请核对后重试\"}",
                     fail_reason, reason_esc);
            httpd_resp_set_type(req, "application/json; charset=utf-8");
            httpd_resp_set_hdr(req, "Cache-Control", "no-store");
            httpd_resp_set_hdr(req, "Connection", "close");
            httpd_resp_send(req, resp, HTTPD_RESP_USE_STRLEN);
            return ESP_OK;
        }
    }

    if (s_cfg) {
        (void)pa_net_save_portal_config(s_cfg, ssid, pass, keep_pass_if_empty,
                                        probed_ch, hub, token, true);
    }

    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_set_hdr(req, "Connection", "close");
    if (wants_json) {
        char resp[160];
        snprintf(resp, sizeof(resp), "{\"ok\":true,\"ip\":\"%s\",\"ch\":%u}",
                 probed_ip, (unsigned)probed_ch);
        httpd_resp_set_type(req, "application/json; charset=utf-8");
        httpd_resp_send(req, resp, HTTPD_RESP_USE_STRLEN);
    } else {
        httpd_resp_set_type(req, "text/html; charset=utf-8");
        httpd_resp_send(req, SAVE_OK_HTML, HTTPD_RESP_USE_STRLEN);
    }

    if (s_on_saved) s_on_saved();
    return ESP_OK;
}

static esp_err_t send_captive_redirect(httpd_req_t *req)
{
    char loc[64];
    snprintf(loc, sizeof(loc), "http://192.168.4.1/?_=%lu",
             (unsigned long)(esp_timer_get_time() / 1000LL));
    httpd_resp_set_status(req, "302 Found");
    httpd_resp_set_type(req, "text/html");
    httpd_resp_set_hdr(req, "Location", loc);
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_set_hdr(req, "Connection", "close");
    httpd_resp_send(req, NULL, 0);
    return ESP_OK;
}

static esp_err_t handle_captive_probe(httpd_req_t *req)
{
    return send_captive_redirect(req);
}

static esp_err_t handle_captive_404(httpd_req_t *req, httpd_err_code_t err)
{
    (void)err;
    return send_captive_redirect(req);
}

// Wildcard EDNS0-aware DNS server on UDP/53 -> resolves A/ANY to 192.168.4.1, AAAA to empty NOERROR
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

static void on_portal_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)data;
    if (!s_active) return;

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
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_SCAN_DONE) {
        refresh_scan_cache_from_driver();
        if (s_active && !s_is_connecting && s_scan_timer) {
            (void)esp_timer_start_once(s_scan_timer, 10LL * 1000000LL);
        }
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
    s_is_connecting = false;
    s_scan_count = 0;
    s_scan_done_once = false;

    if (!s_scan_mux) {
        s_scan_mux = xSemaphoreCreateMutex();
    }
    if (!s_scan_timer) {
        const esp_timer_create_args_t stargs = {
            .callback = on_scan_timer,
            .arg = NULL,
            .dispatch_method = ESP_TIMER_TASK,
            .name = "pa_ap_scan",
            .skip_unhandled_events = false,
        };
        (void)esp_timer_create(&stargs, &s_scan_timer);
    }

    log_heap("before_portal_start");

    // Pause STA reconnect loop BEFORE entering APSTA so single-radio ESP32-C3 stays stable
    pa_net_wifi_pause_for_portal();

    pa_portal_get_ap_ssid(s_ap_ssid, sizeof(s_ap_ssid));
    wifi_config_t ap_cfg;
    memset(&ap_cfg, 0, sizeof(ap_cfg));
    size_t slen = strnlen(s_ap_ssid, sizeof(ap_cfg.ap.ssid));
    memcpy(ap_cfg.ap.ssid, s_ap_ssid, slen);
    ap_cfg.ap.ssid_len = (uint8_t)slen;
    ap_cfg.ap.channel = 1;
    ap_cfg.ap.max_connection = 4;
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
    // Disable modem power-save during SoftAP portal for snappy iPhone/Android webpage loads
    (void)esp_wifi_set_ps(WIFI_PS_NONE);
    (void)esp_wifi_set_band_mode(WIFI_BAND_MODE_2G_ONLY);

    (void)esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_portal_event, NULL, &s_wifi_ev_inst);
    (void)esp_event_handler_instance_register(IP_EVENT, IP_EVENT_AP_STAIPASSIGNED, on_portal_event, NULL, &s_ip_ev_inst);

    httpd_config_t hcfg = HTTPD_DEFAULT_CONFIG();
    hcfg.max_open_sockets = 5;
    hcfg.lru_purge_enable = true;
    hcfg.stack_size = 6144;
    hcfg.max_uri_handlers = 20;
    hcfg.recv_wait_timeout = 12;
    hcfg.send_wait_timeout = 12;
    hcfg.uri_match_fn = httpd_uri_match_wildcard;

    if (httpd_start(&s_httpd, &hcfg) != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed");
        if (s_wifi_ev_inst) {
            (void)esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, s_wifi_ev_inst);
            s_wifi_ev_inst = NULL;
        }
        if (s_ip_ev_inst) {
            (void)esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_AP_STAIPASSIGNED, s_ip_ev_inst);
            s_ip_ev_inst = NULL;
        }
        (void)esp_wifi_set_mode(WIFI_MODE_STA);
        (void)esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
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

    // Explicit OS captive-portal probes (exact list from 78/esp-wifi-connect)
    static const char *const captive_urls[] = {
        "/hotspot-detect.html",
        "/generate_204*",
        "/mobile/status.php",
        "/check_network_status.txt",
        "/ncsi.txt",
        "/fwlink/",
        "/connectivity-check.html",
        "/success.txt",
        "/portal.html",
        "/library/test/success.html",
    };
    for (size_t i = 0; i < sizeof(captive_urls) / sizeof(captive_urls[0]); i++) {
        httpd_uri_t cap = {
            .uri = captive_urls[i],
            .method = HTTP_GET,
            .handler = handle_captive_probe,
        };
        (void)httpd_register_uri_handler(s_httpd, &cap);
    }
    (void)httpd_register_err_handler(s_httpd, HTTPD_404_NOT_FOUND, handle_captive_404);

    s_active = true;
    xTaskCreate(dns_captive_task, "pa_dns", 2560, NULL, 2, &s_dns_task);

    // Kick off first non-blocking background scan immediately so /scan is ready when phone joins
    trigger_async_scan();

    ESP_LOGI(TAG, "[PA-PORTAL] SoftAP started: SSID=%s URL=http://192.168.4.1/", s_ap_ssid);
    log_heap("after_portal_start");
    return true;
}

void pa_portal_stop(void)
{
    if (!s_active && !s_httpd) return;
    s_active = false;
    s_phone_connected = false;
    s_is_connecting = false;

    if (s_scan_timer) {
        (void)esp_timer_stop(s_scan_timer);
    }
    (void)esp_wifi_scan_stop();

    if (s_wifi_ev_inst) {
        (void)esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, s_wifi_ev_inst);
        s_wifi_ev_inst = NULL;
    }
    if (s_ip_ev_inst) {
        (void)esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_AP_STAIPASSIGNED, s_ip_ev_inst);
        s_ip_ev_inst = NULL;
    }

    if (s_httpd) {
        (void)httpd_stop(s_httpd);
        s_httpd = NULL;
    }
    // Wait up to 800ms for DNS task to exit its 500ms recv timeout cleanly
    for (int i = 0; i < 16 && s_dns_task != NULL; i++) {
        vTaskDelay(pdMS_TO_TICKS(50));
    }
    (void)esp_wifi_set_mode(WIFI_MODE_STA);
    (void)esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
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
