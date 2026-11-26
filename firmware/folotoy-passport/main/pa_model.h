// main/pa_model.h
// Pure C state machine, zero-malloc JSON/form parsers, and built-in interactive demo mode
// for PocketAgents on FoloToy AI Passport.
// Strictly independent of ESP-IDF and LVGL so all logic is verified by host ASan/UBSan unit tests.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PA_MAX_APPROVALS 5
#define PA_MAX_TASKS     5
#define PA_MAX_OPTIONS   4

typedef enum {
    PA_RISK_L0 = 0,
    PA_RISK_L1 = 1,
    PA_RISK_L2 = 2,
} pa_risk_t;

typedef enum {
    PA_SCREEN_DASHBOARD = 0,
    PA_SCREEN_APPROVAL  = 1,
    PA_SCREEN_VOICE     = 2,
    PA_SCREEN_SETUP     = 3,
} pa_screen_t;

typedef enum {
    PA_NET_OFFLINE = 0,
    PA_NET_CONNECTING,
    PA_NET_ONLINE,
    PA_NET_AUTH_ERROR,
    PA_NET_ERROR,
} pa_net_status_t;

typedef enum {
    PA_VOICE_IDLE = 0,
    PA_VOICE_RECORDING,
    PA_VOICE_SENDING,
    PA_VOICE_REPLY,
} pa_voice_phase_t;

typedef enum {
    PA_KEY_UP = 0,
    PA_KEY_DOWN,
    PA_KEY_OK,
} pa_key_t;

typedef enum {
    PA_KEY_EV_CLICK = 0,
    PA_KEY_EV_DOUBLE,
    PA_KEY_EV_LONG,
    PA_KEY_EV_RELEASE,
} pa_key_ev_t;

typedef enum {
    PA_CMD_NONE = 0,
    PA_CMD_APPROVE,
    PA_CMD_DENY,
    PA_CMD_ANSWER,
    PA_CMD_VOICE_START,
    PA_CMD_VOICE_STOP,
    PA_CMD_FORCE_REFRESH,
    PA_CMD_ENTER_SETUP,
    PA_CMD_EXIT_SETUP,
    PA_CMD_START_DEMO,
} pa_cmd_type_t;

typedef enum {
    PA_CHIME_NONE = 0,
    PA_CHIME_NEW_APPROVAL,
    PA_CHIME_OK,
    PA_CHIME_DENY,
    PA_CHIME_WARN_L2,
    PA_CHIME_PTT_START,
    PA_CHIME_PTT_STOP,
} pa_chime_t;

typedef struct {
    int slot;
    char host_id[36];
    char host_name[28];
    char code[36];
    char agent_id[52];
    char session[40];
    bool is_question;
    char tool[24];
    pa_risk_t risk;
    char title[72];
    char cmd[108];
    char options[PA_MAX_OPTIONS][40];
    int option_count;
} pa_approval_t;

typedef struct {
    char host_id[36];
    char host_name[24];
    char agent_id[52];
    char harness[16];
    char title[44];
    char status[16];
    bool pending;
} pa_task_t;

typedef struct {
    bool ok;
    bool unchanged;
    char rev[20];
    int hosts_online;
    int hosts_total;
    int running_count;
    int pending_count;
    pa_approval_t approvals[PA_MAX_APPROVALS];
    int approval_count;
    pa_task_t tasks[PA_MAX_TASKS];
    int task_count;
} pa_digest_t;

typedef struct {
    bool ok;
    bool requires_pin;
    char confirm_pin[8];
    char message[80];
} pa_action_result_t;

typedef struct {
    bool ok;
    bool executed;
    bool requires_pin;
    char pin[8];
    char transcript[96];
    char reply[128];
    char tts_text[112];
} pa_voice_result_t;

typedef struct {
    pa_cmd_type_t cmd;
    int slot;
    char code[36];
    int option_index; // 1-based for question answer
    pa_chime_t chime;
    bool ui_dirty;
} pa_dispatch_t;

typedef struct {
    pa_net_status_t net_status;
    char net_detail[64];
    char wifi_ip[20];
    bool setup_ap_active;
    bool setup_phone_connected;
    char setup_ap_ssid[32];
    bool demo_mode;
    int battery_soc; // -1 when unavailable (e.g. simulator)
    pa_screen_t screen;
    pa_digest_t digest;
    int selected_approval; // 0-based index into digest.approvals
    int selected_option;   // 0-based index into current question options
    int selected_task;     // 0-based index into digest.tasks
    bool l2_pin_active;
    char l2_pin_code[8];
    char l2_target_code[36];
    pa_voice_phase_t voice_phase;
    char voice_transcript[96];
    char voice_reply[128];
    char toast[80];
    bool toast_is_error;
    uint32_t toast_until_ms;
    bool busy;
    char last_alerted_top_code[36];
    int last_alerted_pending;
} pa_state_t;

void pa_state_init(pa_state_t *st);

// Zero-heap JSON parsers for /api/device/* and /api/pairing/exchange
bool pa_parse_digest_json(const char *json, pa_digest_t *out);
bool pa_parse_action_result_json(const char *json, pa_action_result_t *out);
bool pa_parse_voice_result_json(const char *json, pa_voice_result_t *out);
bool pa_parse_pair_exchange_json(const char *json, char *out_token, size_t out_size);

// SoftAP HTML form URL decoding, 6-char pairing code detection & RFC-safe DNS captive responder
size_t pa_url_decode(const char *src, size_t src_len, char *dst, size_t dst_size);
bool pa_parse_form_field(const char *body, const char *key, char *out, size_t out_size);
bool pa_is_pair_code(const char *token_or_code);
// Build in-place captive-portal DNS reply (strips EDNS0 OPT records cleanly; answers A/ANY with ip4,
// and returns NOERROR empty answer for AAAA/HTTPS so iOS/Android fall back to IPv4 immediately).
// Returns reply byte length, or 0 if query is malformed.
size_t pa_dns_build_captive_reply(uint8_t *pkt, size_t req_len, size_t buf_size, const uint8_t ip4[4]);

// Apply freshly fetched digest to state. Returns PA_CHIME_NEW_APPROVAL if a new approval arrived.
pa_chime_t pa_state_apply_digest(pa_state_t *st, const pa_digest_t *d, uint32_t now_ms);

// Apply action result from /api/device/action.
pa_chime_t pa_state_apply_action_result(pa_state_t *st, const pa_action_result_t *res,
                                        bool was_deny, uint32_t now_ms);

// Apply voice turn result from /api/device/voice-turn.
pa_chime_t pa_state_apply_voice_result(pa_state_t *st, const pa_voice_result_t *res, uint32_t now_ms);

// Built-in offline interactive demo mode (so reviewers & new users can try all cards immediately)
pa_chime_t pa_demo_start(pa_state_t *st, uint32_t now_ms);
pa_chime_t pa_demo_handle_cmd(pa_state_t *st, const pa_dispatch_t *cmd, uint32_t now_ms);

// SoftAP setup screen state transitions
void pa_state_enter_setup(pa_state_t *st, const char *ap_ssid, uint32_t now_ms);
void pa_state_exit_setup(pa_state_t *st, uint32_t now_ms);

// Pure button state machine (UP / DOWN / OK, single-button events only).
pa_dispatch_t pa_state_on_key(pa_state_t *st, pa_key_t key, pa_key_ev_t ev, uint32_t now_ms);

// Expire transient toast banners cleanly.
bool pa_state_tick(pa_state_t *st, uint32_t now_ms);

// Format safe compact JSON body for POST /api/device/action.
int pa_build_action_json(const pa_dispatch_t *cmd, char *out, size_t out_size);

// Parse serial provisioning command:
//   "pa set <hub_url> [token]" -> returns 1
//   "pa wifi <ssid> [pass]"    -> returns 2
//   unrecognized               -> returns 0
int pa_parse_console_cmd(const char *line, char *arg1, size_t arg1_size,
                         char *arg2, size_t arg2_size);
