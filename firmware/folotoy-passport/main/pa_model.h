// main/pa_model.h
// Pure C state machine & zero-malloc JSON parser for PocketAgents Lite Device API.
// Strictly independent of ESP-IDF and LVGL so all logic is verified by host unit tests.
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

// Zero-heap JSON parsers for /api/device/digest, /api/device/action, /api/device/voice-turn.
bool pa_parse_digest_json(const char *json, pa_digest_t *out);
bool pa_parse_action_result_json(const char *json, pa_action_result_t *out);
bool pa_parse_voice_result_json(const char *json, pa_voice_result_t *out);

// Apply freshly fetched digest to state. Returns PA_CHIME_NEW_APPROVAL if a new approval arrived.
pa_chime_t pa_state_apply_digest(pa_state_t *st, const pa_digest_t *d, uint32_t now_ms);

// Apply action result from /api/device/action.
pa_chime_t pa_state_apply_action_result(pa_state_t *st, const pa_action_result_t *res,
                                        bool was_deny, uint32_t now_ms);

// Apply voice turn result from /api/device/voice-turn.
pa_chime_t pa_state_apply_voice_result(pa_state_t *st, const pa_voice_result_t *res, uint32_t now_ms);

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
