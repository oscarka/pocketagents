// main/pa_model.c
// Zero-heap JSON parser & pure state machine for PocketAgents Lite Device API.
#include "pa_model.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// ---------------------------------------------------------------------------
// UTF-8 safe string helpers (never split multibyte codepoints)
// ---------------------------------------------------------------------------
static void copy_utf8_trunc(char *dst, size_t dst_size, const char *src)
{
    if (!dst || dst_size == 0) return;
    if (!src) {
        dst[0] = '\0';
        return;
    }
    size_t max_len = dst_size - 1;
    size_t i = 0;
    while (src[i] != '\0' && i < max_len) {
        unsigned char c = (unsigned char)src[i];
        size_t char_len = 1;
        if ((c & 0x80u) == 0x00u) char_len = 1;
        else if ((c & 0xE0u) == 0xC0u) char_len = 2;
        else if ((c & 0xF0u) == 0xE0u) char_len = 3;
        else if ((c & 0xF8u) == 0xF0u) char_len = 4;
        else {
            i++;
            continue;
        }
        if (i + char_len > max_len) break;
        bool complete = true;
        for (size_t k = 1; k < char_len; k++) {
            if (((unsigned char)src[i + k] & 0xC0u) != 0x80u) {
                complete = false;
                break;
            }
        }
        if (!complete) break;
        memcpy(dst + i, src + i, char_len);
        i += char_len;
    }
    dst[i] = '\0';
}

static size_t encode_utf8(uint32_t cp, char *out, size_t avail)
{
    if (cp <= 0x7Fu) {
        if (avail < 1) return 0;
        out[0] = (char)cp;
        return 1;
    }
    if (cp <= 0x7FFu) {
        if (avail < 2) return 0;
        out[0] = (char)(0xC0u | (cp >> 6));
        out[1] = (char)(0x80u | (cp & 0x3Fu));
        return 2;
    }
    if (cp <= 0xFFFFu) {
        if (avail < 3) return 0;
        out[0] = (char)(0xE0u | (cp >> 12));
        out[1] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
        out[2] = (char)(0x80u | (cp & 0x3Fu));
        return 3;
    }
    if (cp <= 0x10FFFFu) {
        if (avail < 4) return 0;
        out[0] = (char)(0xF0u | (cp >> 18));
        out[1] = (char)(0x80u | ((cp >> 12) & 0x3Fu));
        out[2] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
        out[3] = (char)(0x80u | (cp & 0x3Fu));
        return 4;
    }
    return 0;
}

static int hex_val(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return 10 + (c - 'a');
    if (c >= 'A' && c <= 'F') return 10 + (c - 'A');
    return -1;
}

static bool parse_hex4(const char *p, uint32_t *out)
{
    uint32_t v = 0;
    for (int i = 0; i < 4; i++) {
        int h = hex_val(p[i]);
        if (h < 0) return false;
        v = (v << 4) | (uint32_t)h;
    }
    *out = v;
    return true;
}

// ---------------------------------------------------------------------------
// Minimal, zero-heap, boundary-checked JSON cursor parser
// ---------------------------------------------------------------------------
typedef struct {
    const char *p;
    const char *end;
} jcur_t;

static void j_ws(jcur_t *c)
{
    while (c->p < c->end && (*c->p == ' ' || *c->p == '\t' || *c->p == '\r' || *c->p == '\n')) {
        c->p++;
    }
}

static bool j_consume(jcur_t *c, char ch)
{
    j_ws(c);
    if (c->p < c->end && *c->p == ch) {
        c->p++;
        return true;
    }
    return false;
}

static bool j_parse_string(jcur_t *c, char *out, size_t out_size)
{
    j_ws(c);
    if (c->p >= c->end || *c->p != '"') return false;
    c->p++;

    size_t pos = 0;
    size_t max_len = (out && out_size > 0) ? (out_size - 1) : 0;

    while (c->p < c->end) {
        char ch = *c->p++;
        if (ch == '"') {
            if (out && out_size > 0) out[pos] = '\0';
            return true;
        }
        if (ch == '\\') {
            if (c->p >= c->end) return false;
            char esc = *c->p++;
            char decoded = 0;
            if (esc == '"' || esc == '\\' || esc == '/') decoded = esc;
            else if (esc == 'n') decoded = '\n';
            else if (esc == 'r') decoded = '\r';
            else if (esc == 't') decoded = '\t';
            else if (esc == 'b') decoded = '\b';
            else if (esc == 'f') decoded = '\f';
            else if (esc == 'u') {
                if (c->end - c->p < 4) return false;
                uint32_t cp = 0;
                if (!parse_hex4(c->p, &cp)) return false;
                c->p += 4;
                // Handle surrogate pair
                if (cp >= 0xD800u && cp <= 0xDBFFu && c->end - c->p >= 6 && c->p[0] == '\\' && c->p[1] == 'u') {
                    uint32_t lo = 0;
                    if (parse_hex4(c->p + 2, &lo) && lo >= 0xDC00u && lo <= 0xDFFFu) {
                        c->p += 6;
                        cp = 0x10000u + (((cp - 0xD800u) << 10) | (lo - 0xDC00u));
                    }
                }
                if (out && pos < max_len) {
                    pos += encode_utf8(cp, out + pos, max_len - pos);
                }
                continue;
            } else {
                decoded = esc;
            }
            if (out && pos < max_len) out[pos++] = decoded;
            continue;
        }
        // Preserve complete UTF-8 sequences when copying raw bytes
        unsigned char uc = (unsigned char)ch;
        size_t seq_len = 1;
        if ((uc & 0x80u) == 0x00u) seq_len = 1;
        else if ((uc & 0xE0u) == 0xC0u) seq_len = 2;
        else if ((uc & 0xF0u) == 0xE0u) seq_len = 3;
        else if ((uc & 0xF8u) == 0xF0u) seq_len = 4;

        if (seq_len == 1) {
            if (out && pos < max_len) out[pos++] = ch;
        } else {
            if (c->p + (seq_len - 1) > c->end) return false;
            if (out && pos + seq_len <= max_len) {
                out[pos++] = ch;
                for (size_t k = 1; k < seq_len; k++) {
                    out[pos++] = *c->p++;
                }
            } else {
                c->p += (seq_len - 1);
            }
        }
    }
    return false;
}

static bool j_parse_bool(jcur_t *c, bool *out)
{
    j_ws(c);
    if (c->end - c->p >= 4 && memcmp(c->p, "true", 4) == 0) {
        c->p += 4;
        if (out) *out = true;
        return true;
    }
    if (c->end - c->p >= 5 && memcmp(c->p, "false", 5) == 0) {
        c->p += 5;
        if (out) *out = false;
        return true;
    }
    return false;
}

static bool j_parse_int(jcur_t *c, int *out)
{
    j_ws(c);
    if (c->p >= c->end) return false;
    const char *start = c->p;
    if (*c->p == '-') c->p++;
    if (c->p >= c->end || !isdigit((unsigned char)*c->p)) {
        c->p = start;
        return false;
    }
    long long v = 0;
    bool neg = (*start == '-');
    const char *d = neg ? start + 1 : start;
    while (d < c->end && isdigit((unsigned char)*d)) {
        v = v * 10 + (*d - '0');
        d++;
    }
    c->p = d;
    // Consume optional fractional/exponent part
    if (c->p < c->end && *c->p == '.') {
        c->p++;
        while (c->p < c->end && isdigit((unsigned char)*c->p)) c->p++;
    }
    if (c->p < c->end && (*c->p == 'e' || *c->p == 'E')) {
        c->p++;
        if (c->p < c->end && (*c->p == '+' || *c->p == '-')) c->p++;
        while (c->p < c->end && isdigit((unsigned char)*c->p)) c->p++;
    }
    if (out) *out = (int)(neg ? -v : v);
    return true;
}

static bool j_skip_value(jcur_t *c, int depth);

static bool j_skip_value(jcur_t *c, int depth)
{
    if (depth > 16) return false;
    j_ws(c);
    if (c->p >= c->end) return false;
    char ch = *c->p;
    if (ch == '"') return j_parse_string(c, NULL, 0);
    if (ch == '{') {
        c->p++;
        if (j_consume(c, '}')) return true;
        while (c->p < c->end) {
            if (!j_parse_string(c, NULL, 0)) return false;
            if (!j_consume(c, ':')) return false;
            if (!j_skip_value(c, depth + 1)) return false;
            if (j_consume(c, ',')) continue;
            return j_consume(c, '}');
        }
        return false;
    }
    if (ch == '[') {
        c->p++;
        if (j_consume(c, ']')) return true;
        while (c->p < c->end) {
            if (!j_skip_value(c, depth + 1)) return false;
            if (j_consume(c, ',')) continue;
            return j_consume(c, ']');
        }
        return false;
    }
    if (ch == 't' && c->end - c->p >= 4 && memcmp(c->p, "true", 4) == 0) {
        c->p += 4;
        return true;
    }
    if (ch == 'f' && c->end - c->p >= 5 && memcmp(c->p, "false", 5) == 0) {
        c->p += 5;
        return true;
    }
    if (ch == 'n' && c->end - c->p >= 4 && memcmp(c->p, "null", 4) == 0) {
        c->p += 4;
        return true;
    }
    return j_parse_int(c, NULL);
}

static bool j_parse_summary_obj(jcur_t *c, pa_digest_t *out)
{
    if (!j_consume(c, '{')) return false;
    if (j_consume(c, '}')) return true;
    char key[32];
    while (c->p < c->end) {
        if (!j_parse_string(c, key, sizeof(key))) return false;
        if (!j_consume(c, ':')) return false;
        if (strcmp(key, "hostsOnline") == 0) {
            if (!j_parse_int(c, &out->hosts_online)) return false;
        } else if (strcmp(key, "hostsTotal") == 0) {
            if (!j_parse_int(c, &out->hosts_total)) return false;
        } else if (strcmp(key, "running") == 0) {
            if (!j_parse_int(c, &out->running_count)) return false;
        } else if (strcmp(key, "pending") == 0) {
            if (!j_parse_int(c, &out->pending_count)) return false;
        } else {
            if (!j_skip_value(c, 1)) return false;
        }
        if (j_consume(c, ',')) continue;
        return j_consume(c, '}');
    }
    return false;
}

static bool j_parse_approval_obj(jcur_t *c, pa_approval_t *a)
{
    memset(a, 0, sizeof(*a));
    a->risk = PA_RISK_L1;
    if (!j_consume(c, '{')) return false;
    if (j_consume(c, '}')) return true;
    char key[24];
    char tmp[32];
    while (c->p < c->end) {
        if (!j_parse_string(c, key, sizeof(key))) return false;
        if (!j_consume(c, ':')) return false;
        if (strcmp(key, "slot") == 0) {
            if (!j_parse_int(c, &a->slot)) return false;
        } else if (strcmp(key, "hostId") == 0) {
            if (!j_parse_string(c, a->host_id, sizeof(a->host_id))) return false;
        } else if (strcmp(key, "hostName") == 0) {
            if (!j_parse_string(c, a->host_name, sizeof(a->host_name))) return false;
        } else if (strcmp(key, "code") == 0) {
            if (!j_parse_string(c, a->code, sizeof(a->code))) return false;
        } else if (strcmp(key, "agentId") == 0) {
            if (!j_parse_string(c, a->agent_id, sizeof(a->agent_id))) return false;
        } else if (strcmp(key, "session") == 0) {
            if (!j_parse_string(c, a->session, sizeof(a->session))) return false;
        } else if (strcmp(key, "kind") == 0) {
            if (!j_parse_string(c, tmp, sizeof(tmp))) return false;
            a->is_question = (strcmp(tmp, "question") == 0);
        } else if (strcmp(key, "tool") == 0) {
            if (!j_parse_string(c, a->tool, sizeof(a->tool))) return false;
        } else if (strcmp(key, "risk") == 0) {
            if (!j_parse_string(c, tmp, sizeof(tmp))) return false;
            if (strcmp(tmp, "L0") == 0) a->risk = PA_RISK_L0;
            else if (strcmp(tmp, "L2") == 0) a->risk = PA_RISK_L2;
            else a->risk = PA_RISK_L1;
        } else if (strcmp(key, "title") == 0) {
            if (!j_parse_string(c, a->title, sizeof(a->title))) return false;
        } else if (strcmp(key, "cmd") == 0) {
            if (!j_parse_string(c, a->cmd, sizeof(a->cmd))) return false;
        } else if (strcmp(key, "options") == 0) {
            if (!j_consume(c, '[')) return false;
            if (!j_consume(c, ']')) {
                while (c->p < c->end) {
                    if (a->option_count < PA_MAX_OPTIONS) {
                        if (!j_parse_string(c, a->options[a->option_count], sizeof(a->options[0]))) return false;
                        a->option_count++;
                    } else {
                        if (!j_skip_value(c, 2)) return false;
                    }
                    if (j_consume(c, ',')) continue;
                    if (!j_consume(c, ']')) return false;
                    break;
                }
            }
        } else {
            if (!j_skip_value(c, 2)) return false;
        }
        if (j_consume(c, ',')) continue;
        return j_consume(c, '}');
    }
    return false;
}

static bool j_parse_task_obj(jcur_t *c, pa_task_t *t)
{
    memset(t, 0, sizeof(*t));
    if (!j_consume(c, '{')) return false;
    if (j_consume(c, '}')) return true;
    char key[24];
    while (c->p < c->end) {
        if (!j_parse_string(c, key, sizeof(key))) return false;
        if (!j_consume(c, ':')) return false;
        if (strcmp(key, "hostId") == 0) {
            if (!j_parse_string(c, t->host_id, sizeof(t->host_id))) return false;
        } else if (strcmp(key, "hostName") == 0) {
            if (!j_parse_string(c, t->host_name, sizeof(t->host_name))) return false;
        } else if (strcmp(key, "agentId") == 0) {
            if (!j_parse_string(c, t->agent_id, sizeof(t->agent_id))) return false;
        } else if (strcmp(key, "harness") == 0) {
            if (!j_parse_string(c, t->harness, sizeof(t->harness))) return false;
        } else if (strcmp(key, "title") == 0) {
            if (!j_parse_string(c, t->title, sizeof(t->title))) return false;
        } else if (strcmp(key, "status") == 0) {
            if (!j_parse_string(c, t->status, sizeof(t->status))) return false;
        } else if (strcmp(key, "pending") == 0) {
            if (!j_parse_bool(c, &t->pending)) return false;
        } else {
            if (!j_skip_value(c, 2)) return false;
        }
        if (j_consume(c, ',')) continue;
        return j_consume(c, '}');
    }
    return false;
}

bool pa_parse_digest_json(const char *json, pa_digest_t *out)
{
    if (!json || !out) return false;
    memset(out, 0, sizeof(*out));
    jcur_t c = { .p = json, .end = json + strlen(json) };
    if (!j_consume(&c, '{')) return false;
    if (j_consume(&c, '}')) return false;

    char key[32];
    while (c.p < c.end) {
        if (!j_parse_string(&c, key, sizeof(key))) return false;
        if (!j_consume(&c, ':')) return false;
        if (strcmp(key, "ok") == 0) {
            if (!j_parse_bool(&c, &out->ok)) return false;
        } else if (strcmp(key, "unchanged") == 0) {
            if (!j_parse_bool(&c, &out->unchanged)) return false;
        } else if (strcmp(key, "rev") == 0) {
            if (!j_parse_string(&c, out->rev, sizeof(out->rev))) return false;
        } else if (strcmp(key, "summary") == 0) {
            if (!j_parse_summary_obj(&c, out)) return false;
        } else if (strcmp(key, "approvals") == 0) {
            if (!j_consume(&c, '[')) return false;
            if (!j_consume(&c, ']')) {
                while (c.p < c.end) {
                    if (out->approval_count < PA_MAX_APPROVALS) {
                        if (!j_parse_approval_obj(&c, &out->approvals[out->approval_count])) return false;
                        out->approval_count++;
                    } else {
                        if (!j_skip_value(&c, 1)) return false;
                    }
                    if (j_consume(&c, ',')) continue;
                    if (!j_consume(&c, ']')) return false;
                    break;
                }
            }
        } else if (strcmp(key, "tasks") == 0) {
            if (!j_consume(&c, '[')) return false;
            if (!j_consume(&c, ']')) {
                while (c.p < c.end) {
                    if (out->task_count < PA_MAX_TASKS) {
                        if (!j_parse_task_obj(&c, &out->tasks[out->task_count])) return false;
                        out->task_count++;
                    } else {
                        if (!j_skip_value(&c, 1)) return false;
                    }
                    if (j_consume(&c, ',')) continue;
                    if (!j_consume(&c, ']')) return false;
                    break;
                }
            }
        } else {
            if (!j_skip_value(&c, 1)) return false;
        }
        if (j_consume(&c, ',')) continue;
        return j_consume(&c, '}');
    }
    return false;
}

bool pa_parse_action_result_json(const char *json, pa_action_result_t *out)
{
    if (!json || !out) return false;
    memset(out, 0, sizeof(*out));
    jcur_t c = { .p = json, .end = json + strlen(json) };
    if (!j_consume(&c, '{')) return false;
    if (j_consume(&c, '}')) return false;

    char key[32];
    while (c.p < c.end) {
        if (!j_parse_string(&c, key, sizeof(key))) return false;
        if (!j_consume(&c, ':')) return false;
        if (strcmp(key, "ok") == 0) {
            if (!j_parse_bool(&c, &out->ok)) return false;
        } else if (strcmp(key, "requiresPin") == 0) {
            if (!j_parse_bool(&c, &out->requires_pin)) return false;
        } else if (strcmp(key, "confirmPin") == 0) {
            if (!j_parse_string(&c, out->confirm_pin, sizeof(out->confirm_pin))) return false;
        } else if (strcmp(key, "message") == 0 || strcmp(key, "error") == 0) {
            if (out->message[0] == '\0') {
                if (!j_parse_string(&c, out->message, sizeof(out->message))) return false;
            } else {
                if (!j_skip_value(&c, 1)) return false;
            }
        } else {
            if (!j_skip_value(&c, 1)) return false;
        }
        if (j_consume(&c, ',')) continue;
        return j_consume(&c, '}');
    }
    return false;
}

bool pa_parse_voice_result_json(const char *json, pa_voice_result_t *out)
{
    if (!json || !out) return false;
    memset(out, 0, sizeof(*out));
    jcur_t c = { .p = json, .end = json + strlen(json) };
    if (!j_consume(&c, '{')) return false;
    if (j_consume(&c, '}')) return false;

    char key[32];
    while (c.p < c.end) {
        if (!j_parse_string(&c, key, sizeof(key))) return false;
        if (!j_consume(&c, ':')) return false;
        if (strcmp(key, "ok") == 0) {
            if (!j_parse_bool(&c, &out->ok)) return false;
        } else if (strcmp(key, "executed") == 0) {
            if (!j_parse_bool(&c, &out->executed)) return false;
        } else if (strcmp(key, "requiresPin") == 0) {
            if (!j_parse_bool(&c, &out->requires_pin)) return false;
        } else if (strcmp(key, "pin") == 0) {
            if (!j_parse_string(&c, out->pin, sizeof(out->pin))) return false;
        } else if (strcmp(key, "transcript") == 0) {
            if (!j_parse_string(&c, out->transcript, sizeof(out->transcript))) return false;
        } else if (strcmp(key, "reply") == 0 || strcmp(key, "error") == 0) {
            if (out->reply[0] == '\0') {
                if (!j_parse_string(&c, out->reply, sizeof(out->reply))) return false;
            } else {
                if (!j_skip_value(&c, 1)) return false;
            }
        } else if (strcmp(key, "ttsText") == 0) {
            if (!j_parse_string(&c, out->tts_text, sizeof(out->tts_text))) return false;
        } else {
            if (!j_skip_value(&c, 1)) return false;
        }
        if (j_consume(&c, ',')) continue;
        return j_consume(&c, '}');
    }
    return false;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------
static void set_toast(pa_state_t *st, const char *msg, bool is_err, uint32_t now_ms, uint32_t ttl_ms)
{
    copy_utf8_trunc(st->toast, sizeof(st->toast), msg);
    st->toast_is_error = is_err;
    st->toast_until_ms = now_ms + ttl_ms;
}

void pa_state_init(pa_state_t *st)
{
    if (!st) return;
    memset(st, 0, sizeof(*st));
    st->battery_soc = -1;
    st->net_status = PA_NET_CONNECTING;
    copy_utf8_trunc(st->net_detail, sizeof(st->net_detail), "正在连接 Wi-Fi...");
    st->screen = PA_SCREEN_DASHBOARD;
}

pa_chime_t pa_state_apply_digest(pa_state_t *st, const pa_digest_t *d, uint32_t now_ms)
{
    if (!st || !d || !d->ok) return PA_CHIME_NONE;

    st->net_status = PA_NET_ONLINE;
    st->net_detail[0] = '\0';

    if (d->unchanged) {
        copy_utf8_trunc(st->digest.rev, sizeof(st->digest.rev), d->rev);
        return PA_CHIME_NONE;
    }

    // Preserve currently viewed approval by code if still pending
    char prev_code[36] = { 0 };
    if (st->digest.approval_count > 0 && st->selected_approval < st->digest.approval_count) {
        copy_utf8_trunc(prev_code, sizeof(prev_code), st->digest.approvals[st->selected_approval].code);
    }

    st->digest = *d;

    if (st->digest.approval_count == 0) {
        st->selected_approval = 0;
        st->selected_option = 0;
        st->l2_pin_active = false;
        st->l2_pin_code[0] = '\0';
        st->l2_target_code[0] = '\0';
        st->last_alerted_top_code[0] = '\0';
        st->last_alerted_pending = 0;
        if (st->screen == PA_SCREEN_APPROVAL) {
            st->screen = PA_SCREEN_DASHBOARD;
        }
        return PA_CHIME_NONE;
    }

    int matched_idx = -1;
    if (prev_code[0] != '\0') {
        for (int i = 0; i < st->digest.approval_count; i++) {
            if (strcmp(st->digest.approvals[i].code, prev_code) == 0) {
                matched_idx = i;
                break;
            }
        }
    }
    if (matched_idx >= 0) {
        st->selected_approval = matched_idx;
    } else {
        st->selected_approval = 0;
        st->selected_option = 0;
    }

    // Clear L2 lock banner if its target approval disappeared
    if (st->l2_pin_active) {
        bool still_here = false;
        for (int i = 0; i < st->digest.approval_count; i++) {
            if (strcmp(st->digest.approvals[i].code, st->l2_target_code) == 0) {
                still_here = true;
                break;
            }
        }
        if (!still_here) {
            st->l2_pin_active = false;
            st->l2_pin_code[0] = '\0';
            st->l2_target_code[0] = '\0';
        }
    }

    if (st->selected_task >= st->digest.task_count && st->digest.task_count > 0) {
        st->selected_task = st->digest.task_count - 1;
    }

    // Detect brand-new approval arrival -> auto-pop Approval screen + alert chime
    const char *top_code = st->digest.approvals[0].code;
    bool new_arrival = (st->digest.pending_count > st->last_alerted_pending) ||
                       (top_code[0] != '\0' && strcmp(top_code, st->last_alerted_top_code) != 0);
    copy_utf8_trunc(st->last_alerted_top_code, sizeof(st->last_alerted_top_code), top_code);
    st->last_alerted_pending = st->digest.pending_count;

    if (new_arrival && st->screen != PA_SCREEN_VOICE) {
        st->screen = PA_SCREEN_APPROVAL;
        st->selected_approval = 0;
        st->selected_option = 0;
        (void)now_ms;
        return st->digest.approvals[0].risk == PA_RISK_L2 ? PA_CHIME_WARN_L2 : PA_CHIME_NEW_APPROVAL;
    }
    return PA_CHIME_NONE;
}

pa_chime_t pa_state_apply_action_result(pa_state_t *st, const pa_action_result_t *res,
                                        bool was_deny, uint32_t now_ms)
{
    if (!st || !res) return PA_CHIME_NONE;
    st->busy = false;

    if (res->requires_pin) {
        st->l2_pin_active = true;
        copy_utf8_trunc(st->l2_pin_code, sizeof(st->l2_pin_code), res->confirm_pin);
        if (st->selected_approval < st->digest.approval_count) {
            copy_utf8_trunc(st->l2_target_code, sizeof(st->l2_target_code),
                            st->digest.approvals[st->selected_approval].code);
        }
        char msg[80];
        snprintf(msg, sizeof(msg), "高危锁定！长按OK报码 %s",
                 res->confirm_pin[0] ? res->confirm_pin : "确认码");
        set_toast(st, msg, true, now_ms, 8000);
        return PA_CHIME_WARN_L2;
    }

    if (res->ok) {
        st->l2_pin_active = false;
        st->l2_pin_code[0] = '\0';
        set_toast(st, res->message[0] ? res->message : (was_deny ? "已拒绝" : "已放行"),
                  false, now_ms, 2600);
        return was_deny ? PA_CHIME_DENY : PA_CHIME_OK;
    }

    set_toast(st, res->message[0] ? res->message : "执行失败", true, now_ms, 3200);
    return PA_CHIME_DENY;
}

pa_chime_t pa_state_apply_voice_result(pa_state_t *st, const pa_voice_result_t *res, uint32_t now_ms)
{
    if (!st || !res) return PA_CHIME_NONE;
    st->busy = false;
    st->voice_phase = PA_VOICE_REPLY;
    copy_utf8_trunc(st->voice_transcript, sizeof(st->voice_transcript),
                    res->transcript[0] ? res->transcript : "(语音)");
    copy_utf8_trunc(st->voice_reply, sizeof(st->voice_reply),
                    res->reply[0] ? res->reply : (res->ok ? "已处理" : "语音处理失败"));

    if (res->requires_pin && res->pin[0]) {
        st->l2_pin_active = true;
        copy_utf8_trunc(st->l2_pin_code, sizeof(st->l2_pin_code), res->pin);
        set_toast(st, "需要高危确认码", true, now_ms, 5000);
        return PA_CHIME_WARN_L2;
    }
    if (res->ok && res->executed) {
        st->l2_pin_active = false;
        st->l2_pin_code[0] = '\0';
        set_toast(st, "语音指令已执行", false, now_ms, 2400);
        return PA_CHIME_OK;
    }
    return res->ok ? PA_CHIME_OK : PA_CHIME_DENY;
}

bool pa_parse_pair_exchange_json(const char *json, char *out_token, size_t out_size)
{
    if (!json || !out_token || out_size < 8) return false;
    out_token[0] = '\0';
    jcur_t c = { .p = json, .end = json + strlen(json) };
    if (!j_consume(&c, '{')) return false;
    if (j_consume(&c, '}')) return false;

    bool ok = false;
    char tok_primary[96] = { 0 };
    char tok_fallback[96] = { 0 };
    char key[32];
    while (c.p < c.end) {
        if (!j_parse_string(&c, key, sizeof(key))) return false;
        if (!j_consume(&c, ':')) return false;
        if (strcmp(key, "ok") == 0) {
            if (!j_parse_bool(&c, &ok)) return false;
        } else if (strcmp(key, "deviceToken") == 0) {
            if (!j_parse_string(&c, tok_primary, sizeof(tok_primary))) return false;
        } else if (strcmp(key, "token") == 0) {
            if (!j_parse_string(&c, tok_fallback, sizeof(tok_fallback))) return false;
        } else {
            if (!j_skip_value(&c, 1)) return false;
        }
        if (j_consume(&c, ',')) continue;
        if (!j_consume(&c, '}')) return false;
        break;
    }
    const char *chosen = tok_primary[0] ? tok_primary : tok_fallback;
    if (!ok || chosen[0] == '\0') return false;
    copy_utf8_trunc(out_token, out_size, chosen);
    return true;
}

size_t pa_url_decode(const char *src, size_t src_len, char *dst, size_t dst_size)
{
    if (!dst || dst_size == 0) return 0;
    size_t out = 0;
    size_t max_out = dst_size - 1;
    for (size_t i = 0; src && i < src_len && out < max_out; i++) {
        char ch = src[i];
        if (ch == '+') {
            dst[out++] = ' ';
        } else if (ch == '%' && i + 2 < src_len) {
            int hi = hex_val(src[i + 1]);
            int lo = hex_val(src[i + 2]);
            if (hi >= 0 && lo >= 0) {
                dst[out++] = (char)((hi << 4) | lo);
                i += 2;
            } else {
                dst[out++] = ch;
            }
        } else {
            dst[out++] = ch;
        }
    }
    dst[out] = '\0';
    return out;
}

bool pa_parse_form_field(const char *body, const char *key, char *out, size_t out_size)
{
    if (out && out_size > 0) out[0] = '\0';
    if (!body || !key || !key[0] || !out || out_size == 0) return false;

    size_t klen = strlen(key);
    const char *p = body;
    while (*p != '\0') {
        const char *amp = strchr(p, '&');
        size_t seg_len = amp ? (size_t)(amp - p) : strlen(p);
        const char *eq = memchr(p, '=', seg_len);
        if (eq) {
            size_t name_len = (size_t)(eq - p);
            if (name_len == klen && memcmp(p, key, klen) == 0) {
                const char *val = eq + 1;
                size_t val_len = seg_len - name_len - 1;
                (void)pa_url_decode(val, val_len, out, out_size);
                return true;
            }
        }
        if (!amp) break;
        p = amp + 1;
    }
    return false;
}

bool pa_is_pair_code(const char *token_or_code)
{
    if (!token_or_code) return false;
    size_t len = strlen(token_or_code);
    if (len != 6) return false;
    if (strncmp(token_or_code, "dev_", 4) == 0 || strncmp(token_or_code, "hst_", 4) == 0) {
        return false;
    }
    for (size_t i = 0; i < len; i++) {
        if (!isalnum((unsigned char)token_or_code[i])) return false;
    }
    return true;
}

void pa_state_enter_setup(pa_state_t *st, const char *ap_ssid, uint32_t now_ms)
{
    if (!st) return;
    if (st->demo_mode) {
        memset(&st->digest, 0, sizeof(st->digest));
    }
    st->demo_mode = false;
    st->busy = false;
    st->setup_ap_active = true;
    st->setup_phone_connected = false;
    copy_utf8_trunc(st->setup_ap_ssid, sizeof(st->setup_ap_ssid),
                    (ap_ssid && ap_ssid[0]) ? ap_ssid : "PocketAgents-Setup");
    st->screen = PA_SCREEN_SETUP;
    set_toast(st, "已开启手机配网热点", false, now_ms, 2200);
}

void pa_state_exit_setup(pa_state_t *st, uint32_t now_ms)
{
    if (!st) return;
    st->setup_ap_active = false;
    st->setup_phone_connected = false;
    if (st->screen == PA_SCREEN_SETUP) {
        st->screen = st->digest.approval_count > 0 ? PA_SCREEN_APPROVAL : PA_SCREEN_DASHBOARD;
    }
    (void)now_ms;
}

pa_chime_t pa_demo_start(pa_state_t *st, uint32_t now_ms)
{
    if (!st) return PA_CHIME_NONE;
    st->demo_mode = true;
    st->setup_ap_active = false;
    st->setup_phone_connected = false;
    st->busy = false;
    st->l2_pin_active = false;
    st->l2_pin_code[0] = '\0';
    st->l2_target_code[0] = '\0';
    st->selected_approval = 0;
    st->selected_option = 0;
    st->selected_task = 0;

    pa_digest_t *d = &st->digest;
    memset(d, 0, sizeof(*d));
    d->ok = true;
    copy_utf8_trunc(d->rev, sizeof(d->rev), "demo-v1");
    d->hosts_online = 1;
    d->hosts_total = 1;
    d->running_count = 1;
    d->pending_count = 3;
    d->approval_count = 3;

    // Demo #1: L1 standard Bash command
    pa_approval_t *a0 = &d->approvals[0];
    a0->slot = 1;
    copy_utf8_trunc(a0->host_name, sizeof(a0->host_name), "演示电脑");
    copy_utf8_trunc(a0->code, sizeof(a0->code), "DEMO-1");
    copy_utf8_trunc(a0->session, sizeof(a0->session), "修复支付单测");
    copy_utf8_trunc(a0->tool, sizeof(a0->tool), "终端命令");
    a0->risk = PA_RISK_L1;
    copy_utf8_trunc(a0->title, sizeof(a0->title), "运行自动化测试");
    copy_utf8_trunc(a0->cmd, sizeof(a0->cmd), "npm test -- device-lite-api.test.js");

    // Demo #2: Multi-choice Chinese question
    pa_approval_t *a1 = &d->approvals[1];
    a1->slot = 2;
    copy_utf8_trunc(a1->host_name, sizeof(a1->host_name), "演示电脑");
    copy_utf8_trunc(a1->code, sizeof(a1->code), "DEMO-2");
    copy_utf8_trunc(a1->session, sizeof(a1->session), "v0.9.21 发布");
    copy_utf8_trunc(a1->tool, sizeof(a1->tool), "请你选择");
    a1->is_question = true;
    a1->risk = PA_RISK_L0;
    copy_utf8_trunc(a1->title, sizeof(a1->title), "选择发布策略");
    a1->option_count = 3;
    copy_utf8_trunc(a1->options[0], sizeof(a1->options[0]), "灰度发布 10%");
    copy_utf8_trunc(a1->options[1], sizeof(a1->options[1]), "全量正式上线");
    copy_utf8_trunc(a1->options[2], sizeof(a1->options[2]), "暂缓并查日志");

    // Demo #3: L2 High-Risk command with 3-digit PIN guard
    pa_approval_t *a2 = &d->approvals[2];
    a2->slot = 3;
    copy_utf8_trunc(a2->host_name, sizeof(a2->host_name), "演示电脑");
    copy_utf8_trunc(a2->code, sizeof(a2->code), "DEMO-3");
    copy_utf8_trunc(a2->session, sizeof(a2->session), "清理构建缓存");
    copy_utf8_trunc(a2->tool, sizeof(a2->tool), "终端命令");
    a2->risk = PA_RISK_L2;
    copy_utf8_trunc(a2->title, sizeof(a2->title), "高危：删文件并强推代码");
    copy_utf8_trunc(a2->cmd, sizeof(a2->cmd), "rm -rf /tmp/old-build && git push --force origin main");

    // 3 Demo tasks
    d->task_count = 3;
    copy_utf8_trunc(d->tasks[0].title, sizeof(d->tasks[0].title), "修复支付单测");
    copy_utf8_trunc(d->tasks[0].status, sizeof(d->tasks[0].status), "approval");
    d->tasks[0].pending = true;
    copy_utf8_trunc(d->tasks[1].title, sizeof(d->tasks[1].title), "v0.9.21 发布");
    copy_utf8_trunc(d->tasks[1].status, sizeof(d->tasks[1].status), "approval");
    d->tasks[1].pending = true;
    copy_utf8_trunc(d->tasks[2].title, sizeof(d->tasks[2].title), "清理构建缓存");
    copy_utf8_trunc(d->tasks[2].status, sizeof(d->tasks[2].status), "approval");
    d->tasks[2].pending = true;

    st->screen = PA_SCREEN_APPROVAL;
    set_toast(st, "已进入离线演示 · 长按↑可配网", false, now_ms, 2600);
    return PA_CHIME_NEW_APPROVAL;
}

pa_chime_t pa_demo_handle_cmd(pa_state_t *st, const pa_dispatch_t *cmd, uint32_t now_ms)
{
    if (!st || !cmd) return PA_CHIME_NONE;
    st->busy = false;
    pa_digest_t *d = &st->digest;

    if (cmd->cmd == PA_CMD_VOICE_STOP) {
        st->voice_phase = PA_VOICE_REPLY;
        copy_utf8_trunc(st->voice_transcript, sizeof(st->voice_transcript), "演示语音（离线模式）");
        copy_utf8_trunc(st->voice_reply, sizeof(st->voice_reply),
                        "连上电脑 PocketAgents 后即可真实语音审批与播报。");
        return PA_CHIME_OK;
    }

    if (d->approval_count <= 0) return PA_CHIME_NONE;
    int idx = st->selected_approval;
    if (idx < 0 || idx >= d->approval_count) idx = 0;
    const pa_approval_t *cur = &d->approvals[idx];

    // L2 single-click OK triggers built-in PIN lock banner!
    if (cmd->cmd == PA_CMD_APPROVE && cur->risk == PA_RISK_L2) {
        st->l2_pin_active = true;
        copy_utf8_trunc(st->l2_pin_code, sizeof(st->l2_pin_code), "628");
        copy_utf8_trunc(st->l2_target_code, sizeof(st->l2_target_code), cur->code);
        set_toast(st, "高危拦截！长按↓拒绝", true, now_ms, 5000);
        return PA_CHIME_WARN_L2;
    }

    // Remove handled demo approval & update matching task status
    for (int i = 0; i < d->task_count; i++) {
        if (strcmp(d->tasks[i].title, cur->session) == 0) {
            d->tasks[i].pending = false;
            copy_utf8_trunc(d->tasks[i].status, sizeof(d->tasks[i].status),
                            cmd->cmd == PA_CMD_DENY ? "idle" : "running");
        }
    }
    for (int i = idx; i + 1 < d->approval_count; i++) {
        d->approvals[i] = d->approvals[i + 1];
        d->approvals[i].slot = i + 1;
    }
    d->approval_count--;
    d->pending_count = d->approval_count;
    d->running_count = 0;
    for (int i = 0; i < d->task_count; i++) {
        if (strcmp(d->tasks[i].status, "running") == 0) d->running_count++;
    }
    st->l2_pin_active = false;
    st->l2_pin_code[0] = '\0';
    st->l2_target_code[0] = '\0';
    st->selected_option = 0;

    if (d->approval_count == 0) {
        st->selected_approval = 0;
        st->screen = PA_SCREEN_DASHBOARD;
        set_toast(st, cmd->cmd == PA_CMD_DENY ? "已拒绝 · 演示完成" : "全部处理完 · 演示完成",
                  false, now_ms, 2600);
    } else {
        if (st->selected_approval >= d->approval_count) st->selected_approval = 0;
        if (cmd->cmd == PA_CMD_ANSWER) {
            char msg[48];
            snprintf(msg, sizeof(msg), "演示：已选第 %d 项", cmd->option_index);
            set_toast(st, msg, false, now_ms, 2000);
        } else {
            set_toast(st, cmd->cmd == PA_CMD_DENY ? "演示：已拒绝" : "演示：已放行", false, now_ms, 2000);
        }
    }
    return cmd->cmd == PA_CMD_DENY ? PA_CHIME_DENY : PA_CHIME_OK;
}

pa_dispatch_t pa_state_on_key(pa_state_t *st, pa_key_t key, pa_key_ev_t ev, uint32_t now_ms)
{
    pa_dispatch_t out;
    memset(&out, 0, sizeof(out));
    if (!st) return out;

    // Push-To-Talk release finishes recording
    if (st->screen == PA_SCREEN_VOICE && st->voice_phase == PA_VOICE_RECORDING) {
        if (key == PA_KEY_OK && ev == PA_KEY_EV_RELEASE) {
            st->voice_phase = PA_VOICE_SENDING;
            st->busy = true;
            out.cmd = PA_CMD_VOICE_STOP;
            out.chime = PA_CHIME_PTT_STOP;
            out.ui_dirty = true;
        }
        return out;
    }

    // Long-press UP from anywhere (when not recording) opens/re-opens Phone SoftAP Wi-Fi Setup!
    if (key == PA_KEY_UP && ev == PA_KEY_EV_LONG && !st->busy) {
        out.cmd = PA_CMD_ENTER_SETUP;
        out.chime = PA_CHIME_OK;
        out.ui_dirty = true;
        return out;
    }

    // Setup SoftAP screen interactions
    if (st->screen == PA_SCREEN_SETUP) {
        if (ev == PA_KEY_EV_CLICK && key == PA_KEY_DOWN) {
            out.cmd = PA_CMD_START_DEMO;
            out.ui_dirty = true;
            return out;
        }
        if (ev == PA_KEY_EV_CLICK && key == PA_KEY_OK) {
            out.cmd = PA_CMD_EXIT_SETUP;
            out.ui_dirty = true;
            return out;
        }
        return out;
    }

    // Long-press OK from anywhere (when not busy) starts Push-To-Talk voice
    if (key == PA_KEY_OK && ev == PA_KEY_EV_LONG && !st->busy) {
        st->screen = PA_SCREEN_VOICE;
        st->voice_phase = PA_VOICE_RECORDING;
        st->voice_transcript[0] = '\0';
        copy_utf8_trunc(st->voice_reply, sizeof(st->voice_reply), "录音中... 松开OK发送");
        out.cmd = PA_CMD_VOICE_START;
        out.chime = PA_CHIME_PTT_START;
        out.ui_dirty = true;
        return out;
    }

    // Voice reply screen: any click dismisses back to Approval or Dashboard
    if (st->screen == PA_SCREEN_VOICE) {
        if (ev == PA_KEY_EV_CLICK && st->voice_phase != PA_VOICE_SENDING) {
            st->voice_phase = PA_VOICE_IDLE;
            st->screen = st->digest.approval_count > 0 ? PA_SCREEN_APPROVAL : PA_SCREEN_DASHBOARD;
            out.ui_dirty = true;
        }
        return out;
    }

    if (st->busy) return out;

    // Dashboard screen navigation
    if (st->screen == PA_SCREEN_DASHBOARD) {
        if (ev == PA_KEY_EV_CLICK && key == PA_KEY_OK) {
            if (st->digest.approval_count > 0) {
                st->screen = PA_SCREEN_APPROVAL;
                out.ui_dirty = true;
            } else if (st->demo_mode) {
                out.cmd = PA_CMD_START_DEMO;
                out.ui_dirty = true;
            } else {
                set_toast(st, "正在同步...", false, now_ms, 1200);
                out.cmd = PA_CMD_FORCE_REFRESH;
                out.ui_dirty = true;
            }
            return out;
        }
        if (ev == PA_KEY_EV_CLICK && (key == PA_KEY_UP || key == PA_KEY_DOWN)) {
            if (st->digest.approval_count > 0) {
                st->screen = PA_SCREEN_APPROVAL;
                out.ui_dirty = true;
                return out;
            }
            if (st->digest.task_count == 0 && !st->demo_mode && key == PA_KEY_DOWN) {
                out.cmd = PA_CMD_START_DEMO;
                out.ui_dirty = true;
                return out;
            }
            if (st->digest.task_count > 0) {
                if (key == PA_KEY_DOWN) {
                    st->selected_task = (st->selected_task + 1) % st->digest.task_count;
                } else {
                    st->selected_task = (st->selected_task + st->digest.task_count - 1) % st->digest.task_count;
                }
                out.ui_dirty = true;
            }
        }
        return out;
    }

    // Approval / Question triage screen
    if (st->screen == PA_SCREEN_APPROVAL) {
        if (st->digest.approval_count <= 0) {
            st->screen = PA_SCREEN_DASHBOARD;
            out.ui_dirty = true;
            return out;
        }
        if (st->selected_approval >= st->digest.approval_count) {
            st->selected_approval = 0;
        }
        const pa_approval_t *cur = &st->digest.approvals[st->selected_approval];

        // Double-click UP returns to Dashboard anytime
        if (key == PA_KEY_UP && ev == PA_KEY_EV_DOUBLE) {
            st->screen = PA_SCREEN_DASHBOARD;
            out.ui_dirty = true;
            return out;
        }

        if (cur->is_question && cur->option_count > 0) {
            if (ev == PA_KEY_EV_CLICK && key == PA_KEY_DOWN) {
                st->selected_option = (st->selected_option + 1) % cur->option_count;
                out.ui_dirty = true;
                return out;
            }
            if (ev == PA_KEY_EV_CLICK && key == PA_KEY_UP) {
                st->selected_option = (st->selected_option + cur->option_count - 1) % cur->option_count;
                out.ui_dirty = true;
                return out;
            }
            if (ev == PA_KEY_EV_DOUBLE && key == PA_KEY_DOWN && st->digest.approval_count > 1) {
                st->selected_approval = (st->selected_approval + 1) % st->digest.approval_count;
                st->selected_option = 0;
                out.ui_dirty = true;
                return out;
            }
            if (ev == PA_KEY_EV_CLICK && key == PA_KEY_OK) {
                st->busy = true;
                out.cmd = PA_CMD_ANSWER;
                out.slot = cur->slot;
                copy_utf8_trunc(out.code, sizeof(out.code), cur->code);
                out.option_index = st->selected_option + 1;
                set_toast(st, "正在提交选项...", false, now_ms, 2000);
                out.ui_dirty = true;
                return out;
            }
            if (ev == PA_KEY_EV_DOUBLE && key == PA_KEY_OK) {
                st->screen = PA_SCREEN_DASHBOARD;
                out.ui_dirty = true;
                return out;
            }
        } else {
            // Standard command approval card
            if (ev == PA_KEY_EV_CLICK && key == PA_KEY_DOWN) {
                if (st->digest.approval_count > 1) {
                    st->selected_approval = (st->selected_approval + 1) % st->digest.approval_count;
                    st->selected_option = 0;
                    st->l2_pin_active = false;
                } else {
                    st->screen = PA_SCREEN_DASHBOARD;
                }
                out.ui_dirty = true;
                return out;
            }
            if (ev == PA_KEY_EV_CLICK && key == PA_KEY_UP) {
                if (st->digest.approval_count > 1) {
                    st->selected_approval =
                        (st->selected_approval + st->digest.approval_count - 1) % st->digest.approval_count;
                    st->selected_option = 0;
                    st->l2_pin_active = false;
                } else {
                    st->screen = PA_SCREEN_DASHBOARD;
                }
                out.ui_dirty = true;
                return out;
            }
            if (ev == PA_KEY_EV_CLICK && key == PA_KEY_OK) {
                st->busy = true;
                out.cmd = PA_CMD_APPROVE;
                out.slot = cur->slot;
                copy_utf8_trunc(out.code, sizeof(out.code), cur->code);
                set_toast(st, cur->risk == PA_RISK_L2 ? "正在核验高危..." : "正在放行...",
                          false, now_ms, 2500);
                out.ui_dirty = true;
                return out;
            }
            if ((ev == PA_KEY_EV_DOUBLE && key == PA_KEY_OK) ||
                (ev == PA_KEY_EV_LONG && key == PA_KEY_DOWN)) {
                st->busy = true;
                out.cmd = PA_CMD_DENY;
                out.slot = cur->slot;
                copy_utf8_trunc(out.code, sizeof(out.code), cur->code);
                set_toast(st, "正在拒绝...", false, now_ms, 2500);
                out.ui_dirty = true;
                return out;
            }
        }
    }

    return out;
}

bool pa_state_tick(pa_state_t *st, uint32_t now_ms)
{
    if (!st || st->toast[0] == '\0') return false;
    if ((int32_t)(now_ms - st->toast_until_ms) >= 0) {
        st->toast[0] = '\0';
        st->toast_is_error = false;
        return true;
    }
    return false;
}

int pa_build_action_json(const pa_dispatch_t *cmd, char *out, size_t out_size)
{
    if (!cmd || !out || out_size < 32) return -1;
    // Escape code safely (codes are alphanumeric + dash/colon)
    char safe_code[36];
    size_t j = 0;
    for (size_t i = 0; cmd->code[i] != '\0' && j + 1 < sizeof(safe_code); i++) {
        char c = cmd->code[i];
        if (c == '"' || c == '\\' || (unsigned char)c < 0x20u) continue;
        safe_code[j++] = c;
    }
    safe_code[j] = '\0';

    if (cmd->cmd == PA_CMD_APPROVE) {
        return snprintf(out, out_size, "{\"type\":\"approve\",\"slot\":%d,\"code\":\"%s\"}",
                        cmd->slot, safe_code);
    }
    if (cmd->cmd == PA_CMD_DENY) {
        return snprintf(out, out_size, "{\"type\":\"deny\",\"slot\":%d,\"code\":\"%s\"}",
                        cmd->slot, safe_code);
    }
    if (cmd->cmd == PA_CMD_ANSWER) {
        return snprintf(out, out_size,
                        "{\"type\":\"answer\",\"slot\":%d,\"code\":\"%s\",\"optionIndex\":%d}",
                        cmd->slot, safe_code, cmd->option_index > 0 ? cmd->option_index : 1);
    }
    return -1;
}

int pa_parse_console_cmd(const char *line, char *arg1, size_t arg1_size,
                         char *arg2, size_t arg2_size)
{
    if (arg1 && arg1_size > 0) arg1[0] = '\0';
    if (arg2 && arg2_size > 0) arg2[0] = '\0';
    if (!line) return 0;

    const char *p = line;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    if (strncmp(p, "pa ", 3) != 0) return 0;
    p += 3;
    while (*p == ' ' || *p == '\t') p++;

    int kind = 0;
    if (strncmp(p, "set ", 4) == 0) {
        kind = 1;
        p += 4;
    } else if (strncmp(p, "wifi ", 5) == 0) {
        kind = 2;
        p += 5;
    } else {
        return 0;
    }

    while (*p == ' ' || *p == '\t') p++;
    const char *a1 = p;
    while (*p && *p != ' ' && *p != '\t' && *p != '\r' && *p != '\n') p++;
    size_t a1_len = (size_t)(p - a1);
    if (a1_len == 0) return 0;
    if (arg1 && arg1_size > 1) {
        size_t n = a1_len < (arg1_size - 1) ? a1_len : (arg1_size - 1);
        memcpy(arg1, a1, n);
        arg1[n] = '\0';
    }

    while (*p == ' ' || *p == '\t') p++;
    const char *a2 = p;
    while (*p && *p != '\r' && *p != '\n') p++;
    while (p > a2 && (p[-1] == ' ' || p[-1] == '\t')) p--;
    size_t a2_len = (size_t)(p - a2);
    if (a2_len > 0 && arg2 && arg2_size > 1) {
        size_t n = a2_len < (arg2_size - 1) ? a2_len : (arg2_size - 1);
        memcpy(arg2, a2, n);
        arg2[n] = '\0';
    }
    return kind;
}
