// main/pa_ui.c
// Original PocketAgents 240x320 LVGL 9.5 interface (zero runtime widget churn).
#include "pa_ui.h"
#include "lvgl.h"

#include <stdio.h>
#include <string.h>

// Palette
#define COL_BG         0x090F1Au
#define COL_CARD       0x121C2Eu
#define COL_CARD_ALT   0x18253Du
#define COL_BORDER     0x243654u
#define COL_TEXT       0xF1F5F9u
#define COL_MUTED      0x8FA3BFu
#define COL_EMERALD    0x10B981u
#define COL_AMBER      0xF59E0Bu
#define COL_CRIMSON    0xEF4444u
#define COL_SKY        0x38BDF8u
#define COL_DARK_TEXT  0x061018u

// Writable CJK font descriptor with Montserrat fallback for LVGL icons/symbols
static lv_font_t s_font_cjk;

// Root + Header + Footer + Toast
static lv_obj_t *s_scr;
static lv_obj_t *s_net_dot;
static lv_obj_t *s_hdr_title;
static lv_obj_t *s_hdr_right;
static lv_obj_t *s_footer_lbl;
static lv_obj_t *s_toast_box;
static lv_obj_t *s_toast_lbl;

// Dashboard view
static lv_obj_t *s_dash_view;
static lv_obj_t *s_tile_hosts_val;
static lv_obj_t *s_tile_run_val;
static lv_obj_t *s_tile_wait_val;
static lv_obj_t *s_tile_wait_box;
static lv_obj_t *s_dash_banner;
static lv_obj_t *s_dash_banner_lbl;
static lv_obj_t *s_task_rows[4];
static lv_obj_t *s_task_dots[4];
static lv_obj_t *s_task_titles[4];
static lv_obj_t *s_task_tags[4];

// Approval / Question view
static lv_obj_t *s_app_view;
static lv_obj_t *s_app_slot_lbl;
static lv_obj_t *s_app_risk_pill;
static lv_obj_t *s_app_risk_lbl;
static lv_obj_t *s_app_meta_lbl;
static lv_obj_t *s_app_card;
static lv_obj_t *s_app_title_lbl;
static lv_obj_t *s_app_cmd_lbl;
static lv_obj_t *s_opt_box;
static lv_obj_t *s_opt_rows[PA_MAX_OPTIONS];
static lv_obj_t *s_opt_lbls[PA_MAX_OPTIONS];
static lv_obj_t *s_l2_banner;
static lv_obj_t *s_l2_banner_lbl;

// Voice PTT view
static lv_obj_t *s_voice_view;
static lv_obj_t *s_voice_badge;
static lv_obj_t *s_voice_badge_lbl;
static lv_obj_t *s_voice_user_lbl;
static lv_obj_t *s_voice_reply_lbl;

static lv_obj_t *make_clean_box(lv_obj_t *parent, int x, int y, int w, int h,
                                uint32_t bg, int radius, uint32_t border_col, int border_w)
{
    lv_obj_t *o = lv_obj_create(parent);
    lv_obj_remove_style_all(o);
    lv_obj_set_pos(o, x, y);
    lv_obj_set_size(o, w, h);
    lv_obj_set_style_bg_color(o, lv_color_hex(bg), 0);
    lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(o, radius, 0);
    if (border_w > 0) {
        lv_obj_set_style_border_color(o, lv_color_hex(border_col), 0);
        lv_obj_set_style_border_width(o, border_w, 0);
        lv_obj_set_style_border_opa(o, LV_OPA_COVER, 0);
    }
    lv_obj_remove_flag(o, LV_OBJ_FLAG_SCROLLABLE);
    return o;
}

static lv_obj_t *make_metric_tile(lv_obj_t *parent, int x, int y, int w, int h,
                                  const char *caption, uint32_t accent, lv_obj_t **out_val)
{
    lv_obj_t *box = make_clean_box(parent, x, y, w, h, COL_CARD, 10, COL_BORDER, 1);

    lv_obj_t *val = lv_label_create(box);
    lv_obj_set_style_text_font(val, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(val, lv_color_hex(accent), 0);
    lv_obj_align(val, LV_ALIGN_TOP_MID, 0, 7);
    lv_label_set_text(val, "0");

    lv_obj_t *cap = lv_label_create(box);
    lv_obj_set_style_text_font(cap, &lv_font_montserrat_12, 0);
    lv_obj_set_style_text_color(cap, lv_color_hex(COL_MUTED), 0);
    lv_obj_align(cap, LV_ALIGN_BOTTOM_MID, 0, -6);
    lv_label_set_text(cap, caption);

    *out_val = val;
    return box;
}

void pa_ui_init(void)
{
    // Initialize CJK font descriptor with Montserrat fallback for symbols
    s_font_cjk = lv_font_source_han_sans_sc_16_cjk;
    s_font_cjk.fallback = &lv_font_montserrat_16;

    s_scr = lv_obj_create(NULL);
    lv_obj_remove_style_all(s_scr);
    lv_obj_set_size(s_scr, 240, 320);
    lv_obj_set_style_bg_color(s_scr, lv_color_hex(COL_BG), 0);
    lv_obj_set_style_bg_opa(s_scr, LV_OPA_COVER, 0);
    lv_obj_remove_flag(s_scr, LV_OBJ_FLAG_SCROLLABLE);

    // --- Header bar (inset for 30px curved top corners) ---
    s_net_dot = make_clean_box(s_scr, 20, 18, 8, 8, COL_AMBER, 4, 0, 0);

    s_hdr_title = lv_label_create(s_scr);
    lv_obj_set_style_text_font(s_hdr_title, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(s_hdr_title, lv_color_hex(COL_TEXT), 0);
    lv_obj_set_pos(s_hdr_title, 33, 14);
    lv_label_set_text(s_hdr_title, "POCKETAGENTS");

    s_hdr_right = lv_label_create(s_scr);
    lv_obj_set_style_text_font(s_hdr_right, &lv_font_montserrat_12, 0);
    lv_obj_set_style_text_color(s_hdr_right, lv_color_hex(COL_MUTED), 0);
    lv_obj_align(s_hdr_right, LV_ALIGN_TOP_RIGHT, -20, 16);
    lv_label_set_text(s_hdr_right, "SIM");

    // Subtle divider
    (void)make_clean_box(s_scr, 14, 36, 212, 1, COL_BORDER, 0, 0, 0);

    // --- 1. Dashboard View (y = 42..276) ---
    s_dash_view = make_clean_box(s_scr, 0, 42, 240, 236, COL_BG, 0, 0, 0);

    (void)make_metric_tile(s_dash_view, 12, 4, 68, 54, "HOSTS", COL_SKY, &s_tile_hosts_val);
    (void)make_metric_tile(s_dash_view, 86, 4, 68, 54, "RUN", COL_EMERALD, &s_tile_run_val);
    s_tile_wait_box = make_metric_tile(s_dash_view, 160, 4, 68, 54, "WAIT", COL_AMBER, &s_tile_wait_val);

    // Status / Call-to-action banner
    s_dash_banner = make_clean_box(s_dash_view, 12, 64, 216, 26, COL_CARD_ALT, 8, COL_BORDER, 1);
    s_dash_banner_lbl = lv_label_create(s_dash_banner);
    lv_obj_set_style_text_font(s_dash_banner_lbl, &lv_font_montserrat_12, 0);
    lv_obj_set_style_text_color(s_dash_banner_lbl, lv_color_hex(COL_MUTED), 0);
    lv_label_set_long_mode(s_dash_banner_lbl, LV_LABEL_LONG_DOT);
    lv_obj_set_width(s_dash_banner_lbl, 204);
    lv_obj_set_style_text_align(s_dash_banner_lbl, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_center(s_dash_banner_lbl);
    lv_label_set_text(s_dash_banner_lbl, "Connecting Wi-Fi...");

    // 4 compact task rows
    for (int i = 0; i < 4; i++) {
        int ry = 96 + i * 34;
        s_task_rows[i] = make_clean_box(s_dash_view, 12, ry, 216, 30, COL_CARD, 8, COL_BORDER, 1);
        s_task_dots[i] = make_clean_box(s_task_rows[i], 8, 11, 8, 8, COL_MUTED, 4, 0, 0);

        s_task_titles[i] = lv_label_create(s_task_rows[i]);
        lv_obj_set_style_text_font(s_task_titles[i], &s_font_cjk, 0);
        lv_obj_set_style_text_color(s_task_titles[i], lv_color_hex(COL_TEXT), 0);
        lv_label_set_long_mode(s_task_titles[i], LV_LABEL_LONG_DOT);
        lv_obj_set_width(s_task_titles[i], 144);
        lv_obj_set_pos(s_task_titles[i], 22, 6);
        lv_label_set_text(s_task_titles[i], "");

        s_task_tags[i] = lv_label_create(s_task_rows[i]);
        lv_obj_set_style_text_font(s_task_tags[i], &lv_font_montserrat_12, 0);
        lv_obj_set_style_text_color(s_task_tags[i], lv_color_hex(COL_MUTED), 0);
        lv_obj_align(s_task_tags[i], LV_ALIGN_RIGHT_MID, -8, 0);
        lv_label_set_text(s_task_tags[i], "");

        lv_obj_add_flag(s_task_rows[i], LV_OBJ_FLAG_HIDDEN);
    }

    // --- 2. Approval / Multi-Choice Triage View (y = 42..276) ---
    s_app_view = make_clean_box(s_scr, 0, 42, 240, 236, COL_BG, 0, 0, 0);

    s_app_slot_lbl = lv_label_create(s_app_view);
    lv_obj_set_style_text_font(s_app_slot_lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(s_app_slot_lbl, lv_color_hex(COL_TEXT), 0);
    lv_obj_set_pos(s_app_slot_lbl, 14, 4);
    lv_label_set_text(s_app_slot_lbl, "#1/1");

    s_app_risk_pill = make_clean_box(s_app_view, 136, 2, 92, 22, COL_AMBER, 11, 0, 0);
    s_app_risk_lbl = lv_label_create(s_app_risk_pill);
    lv_obj_set_style_text_font(s_app_risk_lbl, &lv_font_montserrat_12, 0);
    lv_obj_set_style_text_color(s_app_risk_lbl, lv_color_hex(COL_DARK_TEXT), 0);
    lv_obj_center(s_app_risk_lbl);
    lv_label_set_text(s_app_risk_lbl, "L1 EXEC");

    s_app_meta_lbl = lv_label_create(s_app_view);
    lv_obj_set_style_text_font(s_app_meta_lbl, &s_font_cjk, 0);
    lv_obj_set_style_text_color(s_app_meta_lbl, lv_color_hex(COL_SKY), 0);
    lv_label_set_long_mode(s_app_meta_lbl, LV_LABEL_LONG_DOT);
    lv_obj_set_width(s_app_meta_lbl, 212);
    lv_obj_set_pos(s_app_meta_lbl, 14, 27);
    lv_label_set_text(s_app_meta_lbl, "");

    s_app_card = make_clean_box(s_app_view, 12, 50, 216, 178, COL_CARD, 12, COL_AMBER, 2);

    s_app_title_lbl = lv_label_create(s_app_card);
    lv_obj_set_style_text_font(s_app_title_lbl, &s_font_cjk, 0);
    lv_obj_set_style_text_color(s_app_title_lbl, lv_color_hex(COL_TEXT), 0);
    lv_label_set_long_mode(s_app_title_lbl, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s_app_title_lbl, 194);
    lv_obj_set_pos(s_app_title_lbl, 10, 8);
    lv_label_set_text(s_app_title_lbl, "");

    s_app_cmd_lbl = lv_label_create(s_app_card);
    lv_obj_set_style_text_font(s_app_cmd_lbl, &s_font_cjk, 0);
    lv_obj_set_style_text_color(s_app_cmd_lbl, lv_color_hex(COL_MUTED), 0);
    lv_label_set_long_mode(s_app_cmd_lbl, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s_app_cmd_lbl, 194);
    lv_obj_set_pos(s_app_cmd_lbl, 10, 52);
    lv_label_set_text(s_app_cmd_lbl, "");

    // Multi-choice options container inside card
    s_opt_box = make_clean_box(s_app_card, 8, 48, 200, 122, COL_CARD, 0, 0, 0);
    for (int i = 0; i < PA_MAX_OPTIONS; i++) {
        s_opt_rows[i] = make_clean_box(s_opt_box, 0, i * 30, 200, 26, COL_CARD_ALT, 6, COL_BORDER, 1);
        s_opt_lbls[i] = lv_label_create(s_opt_rows[i]);
        lv_obj_set_style_text_font(s_opt_lbls[i], &s_font_cjk, 0);
        lv_obj_set_style_text_color(s_opt_lbls[i], lv_color_hex(COL_TEXT), 0);
        lv_label_set_long_mode(s_opt_lbls[i], LV_LABEL_LONG_DOT);
        lv_obj_set_width(s_opt_lbls[i], 186);
        lv_obj_align(s_opt_lbls[i], LV_ALIGN_LEFT_MID, 7, 0);
        lv_label_set_text(s_opt_lbls[i], "");
    }
    lv_obj_add_flag(s_opt_box, LV_OBJ_FLAG_HIDDEN);

    // L2 PIN lock overlay bar at bottom of card
    s_l2_banner = make_clean_box(s_app_card, 8, 134, 200, 34, COL_CRIMSON, 8, 0, 0);
    s_l2_banner_lbl = lv_label_create(s_l2_banner);
    lv_obj_set_style_text_font(s_l2_banner_lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(s_l2_banner_lbl, lv_color_hex(COL_TEXT), 0);
    lv_obj_center(s_l2_banner_lbl);
    lv_label_set_text(s_l2_banner_lbl, "L2 PIN: ---");
    lv_obj_add_flag(s_l2_banner, LV_OBJ_FLAG_HIDDEN);

    lv_obj_add_flag(s_app_view, LV_OBJ_FLAG_HIDDEN);

    // --- 3. Voice Push-To-Talk View (y = 42..276) ---
    s_voice_view = make_clean_box(s_scr, 0, 42, 240, 236, COL_BG, 0, 0, 0);

    s_voice_badge = make_clean_box(s_voice_view, 36, 12, 168, 30, COL_SKY, 15, 0, 0);
    s_voice_badge_lbl = lv_label_create(s_voice_badge);
    lv_obj_set_style_text_font(s_voice_badge_lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(s_voice_badge_lbl, lv_color_hex(COL_DARK_TEXT), 0);
    lv_obj_center(s_voice_badge_lbl);
    lv_label_set_text(s_voice_badge_lbl, "WALKIE-TALKIE");

    lv_obj_t *v_card = make_clean_box(s_voice_view, 12, 54, 216, 174, COL_CARD, 12, COL_SKY, 2);
    s_voice_user_lbl = lv_label_create(v_card);
    lv_obj_set_style_text_font(s_voice_user_lbl, &s_font_cjk, 0);
    lv_obj_set_style_text_color(s_voice_user_lbl, lv_color_hex(COL_SKY), 0);
    lv_label_set_long_mode(s_voice_user_lbl, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s_voice_user_lbl, 194);
    lv_obj_set_pos(s_voice_user_lbl, 10, 10);
    lv_label_set_text(s_voice_user_lbl, "");

    s_voice_reply_lbl = lv_label_create(v_card);
    lv_obj_set_style_text_font(s_voice_reply_lbl, &s_font_cjk, 0);
    lv_obj_set_style_text_color(s_voice_reply_lbl, lv_color_hex(COL_TEXT), 0);
    lv_label_set_long_mode(s_voice_reply_lbl, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s_voice_reply_lbl, 194);
    lv_obj_set_pos(s_voice_reply_lbl, 10, 62);
    lv_label_set_text(s_voice_reply_lbl, "");

    lv_obj_add_flag(s_voice_view, LV_OBJ_FLAG_HIDDEN);

    // --- Toast pill (overlays bottom of view area) ---
    s_toast_box = make_clean_box(s_scr, 16, 246, 208, 28, COL_EMERALD, 14, 0, 0);
    s_toast_lbl = lv_label_create(s_toast_box);
    lv_obj_set_style_text_font(s_toast_lbl, &lv_font_montserrat_12, 0);
    lv_obj_set_style_text_color(s_toast_lbl, lv_color_hex(COL_DARK_TEXT), 0);
    lv_label_set_long_mode(s_toast_lbl, LV_LABEL_LONG_DOT);
    lv_obj_set_width(s_toast_lbl, 192);
    lv_obj_set_style_text_align(s_toast_lbl, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_center(s_toast_lbl);
    lv_obj_add_flag(s_toast_box, LV_OBJ_FLAG_HIDDEN);

    // --- Footer keybar (well clear of 30px curved bottom corners) ---
    (void)make_clean_box(s_scr, 22, 274, 196, 1, COL_BORDER, 0, 0, 0);
    s_footer_lbl = lv_label_create(s_scr);
    lv_obj_set_style_text_font(s_footer_lbl, &lv_font_montserrat_12, 0);
    lv_obj_set_style_text_color(s_footer_lbl, lv_color_hex(COL_MUTED), 0);
    lv_obj_set_width(s_footer_lbl, 196);
    lv_obj_set_style_text_align(s_footer_lbl, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s_footer_lbl, LV_ALIGN_BOTTOM_MID, 0, -22);
    lv_label_set_text(s_footer_lbl, "OK:SYNC  HOLD:VOICE");

    lv_screen_load(s_scr);
}

static void render_header(const pa_state_t *st)
{
    uint32_t dot_col = COL_AMBER;
    if (st->net_status == PA_NET_ONLINE) dot_col = COL_EMERALD;
    else if (st->net_status == PA_NET_AUTH_ERROR || st->net_status == PA_NET_ERROR) dot_col = COL_CRIMSON;
    else if (st->net_status == PA_NET_OFFLINE) dot_col = COL_MUTED;
    lv_obj_set_style_bg_color(s_net_dot, lv_color_hex(dot_col), 0);

    if (st->battery_soc >= 0) {
        lv_label_set_text_fmt(s_hdr_right, "%d%%", st->battery_soc);
    } else {
        lv_label_set_text(s_hdr_right, "SIM");
    }
}

static void render_dashboard(const pa_state_t *st)
{
    lv_label_set_text_fmt(s_tile_hosts_val, "%d", st->digest.hosts_online);
    lv_label_set_text_fmt(s_tile_run_val, "%d", st->digest.running_count);
    lv_label_set_text_fmt(s_tile_wait_val, "%d", st->digest.pending_count);

    lv_obj_set_style_border_color(s_tile_wait_box,
                                  lv_color_hex(st->digest.pending_count > 0 ? COL_AMBER : COL_BORDER), 0);
    lv_obj_set_style_border_width(s_tile_wait_box, st->digest.pending_count > 0 ? 2 : 1, 0);

    if (st->net_status != PA_NET_ONLINE) {
        lv_obj_set_style_bg_color(s_dash_banner, lv_color_hex(COL_CARD_ALT), 0);
        lv_obj_set_style_text_color(s_dash_banner_lbl, lv_color_hex(COL_AMBER), 0);
        lv_label_set_text(s_dash_banner_lbl, st->net_detail[0] ? st->net_detail : "Connecting...");
    } else if (st->digest.pending_count > 0) {
        lv_obj_set_style_bg_color(s_dash_banner, lv_color_hex(0x3B2A0Au), 0);
        lv_obj_set_style_text_color(s_dash_banner_lbl, lv_color_hex(COL_AMBER), 0);
        lv_label_set_text_fmt(s_dash_banner_lbl, "%d PENDING - PRESS OK", st->digest.pending_count);
    } else {
        lv_obj_set_style_bg_color(s_dash_banner, lv_color_hex(0x0B2B22u), 0);
        lv_obj_set_style_text_color(s_dash_banner_lbl, lv_color_hex(COL_EMERALD), 0);
        lv_label_set_text(s_dash_banner_lbl, "HUB ONLINE - ALL CLEAR");
    }

    int count = st->digest.task_count < 4 ? st->digest.task_count : 4;
    for (int i = 0; i < 4; i++) {
        if (i >= count) {
            lv_obj_add_flag(s_task_rows[i], LV_OBJ_FLAG_HIDDEN);
            continue;
        }
        lv_obj_remove_flag(s_task_rows[i], LV_OBJ_FLAG_HIDDEN);
        const pa_task_t *t = &st->digest.tasks[i];
        bool sel = (i == st->selected_task);
        lv_obj_set_style_border_color(s_task_rows[i], lv_color_hex(sel ? COL_SKY : COL_BORDER), 0);

        uint32_t dcol = COL_MUTED;
        const char *tag = "IDLE";
        if (t->pending || strcmp(t->status, "approval") == 0) {
            dcol = COL_AMBER;
            tag = "WAIT";
        } else if (strcmp(t->status, "running") == 0) {
            dcol = COL_EMERALD;
            tag = "RUN";
        }
        lv_obj_set_style_bg_color(s_task_dots[i], lv_color_hex(dcol), 0);
        lv_obj_set_style_text_color(s_task_tags[i], lv_color_hex(dcol), 0);
        lv_label_set_text(s_task_titles[i], t->title[0] ? t->title : t->agent_id);
        lv_label_set_text(s_task_tags[i], tag);
    }

    if (st->digest.pending_count > 0) {
        lv_label_set_text(s_footer_lbl, "OK:TRIAGE  HOLD:VOICE");
    } else {
        lv_label_set_text(s_footer_lbl, "UP/DN:LIST  HOLD:VOICE");
    }
}

static void render_approval(const pa_state_t *st)
{
    if (st->digest.approval_count <= 0) return;
    int idx = st->selected_approval;
    if (idx < 0 || idx >= st->digest.approval_count) idx = 0;
    const pa_approval_t *a = &st->digest.approvals[idx];

    lv_label_set_text_fmt(s_app_slot_lbl, "#%d/%d  %s", a->slot, st->digest.approval_count,
                          a->is_question ? "PICK" : a->tool);

    uint32_t risk_col = COL_AMBER;
    const char *risk_txt = "L1 EXEC";
    if (a->risk == PA_RISK_L0) {
        risk_col = COL_EMERALD;
        risk_txt = a->is_question ? "QUESTION" : "L0 SAFE";
    } else if (a->risk == PA_RISK_L2) {
        risk_col = COL_CRIMSON;
        risk_txt = "L2 DANGER";
    }
    lv_obj_set_style_bg_color(s_app_risk_pill, lv_color_hex(risk_col), 0);
    lv_obj_set_style_text_color(s_app_risk_lbl,
                                lv_color_hex(a->risk == PA_RISK_L2 ? COL_TEXT : COL_DARK_TEXT), 0);
    lv_label_set_text(s_app_risk_lbl, risk_txt);
    lv_obj_set_style_border_color(s_app_card, lv_color_hex(risk_col), 0);

    char meta[80];
    snprintf(meta, sizeof(meta), "%s | %s", a->host_name[0] ? a->host_name : a->host_id,
             a->session[0] ? a->session : a->code);
    lv_label_set_text(s_app_meta_lbl, meta);
    lv_label_set_text(s_app_title_lbl, a->title[0] ? a->title : "Pending approval");

    if (a->is_question && a->option_count > 0) {
        lv_obj_add_flag(s_app_cmd_lbl, LV_OBJ_FLAG_HIDDEN);
        lv_obj_remove_flag(s_opt_box, LV_OBJ_FLAG_HIDDEN);
        for (int i = 0; i < PA_MAX_OPTIONS; i++) {
            if (i >= a->option_count) {
                lv_obj_add_flag(s_opt_rows[i], LV_OBJ_FLAG_HIDDEN);
                continue;
            }
            lv_obj_remove_flag(s_opt_rows[i], LV_OBJ_FLAG_HIDDEN);
            bool sel = (i == st->selected_option);
            lv_obj_set_style_bg_color(s_opt_rows[i], lv_color_hex(sel ? 0x163A5Fu : COL_CARD_ALT), 0);
            lv_obj_set_style_border_color(s_opt_rows[i], lv_color_hex(sel ? COL_SKY : COL_BORDER), 0);
            char line[56];
            snprintf(line, sizeof(line), "%s %d. %s", sel ? ">" : " ", i + 1, a->options[i]);
            lv_label_set_text(s_opt_lbls[i], line);
        }
        lv_obj_add_flag(s_l2_banner, LV_OBJ_FLAG_HIDDEN);
        lv_label_set_text(s_footer_lbl, "UP/DN:OPT  OK:PICK");
    } else {
        lv_obj_add_flag(s_opt_box, LV_OBJ_FLAG_HIDDEN);
        lv_obj_remove_flag(s_app_cmd_lbl, LV_OBJ_FLAG_HIDDEN);
        lv_label_set_text(s_app_cmd_lbl, a->cmd[0] ? a->cmd : "(no command preview)");

        bool show_pin = st->l2_pin_active && strcmp(st->l2_target_code, a->code) == 0;
        if (show_pin) {
            lv_obj_remove_flag(s_l2_banner, LV_OBJ_FLAG_HIDDEN);
            lv_label_set_text_fmt(s_l2_banner_lbl, "PIN %s - HOLD OK",
                                  st->l2_pin_code[0] ? st->l2_pin_code : "---");
            lv_label_set_text(s_footer_lbl, "HOLD:PIN  2xOK:DENY");
        } else {
            lv_obj_add_flag(s_l2_banner, LV_OBJ_FLAG_HIDDEN);
            if (a->risk == PA_RISK_L2) {
                lv_label_set_text(s_footer_lbl, "OK:GET PIN  2xOK:DENY");
            } else {
                lv_label_set_text(s_footer_lbl, "OK:ALLOW  2xOK:DENY");
            }
        }
    }
}

static void render_voice(const pa_state_t *st)
{
    if (st->voice_phase == PA_VOICE_RECORDING) {
        lv_obj_set_style_bg_color(s_voice_badge, lv_color_hex(COL_CRIMSON), 0);
        lv_obj_set_style_text_color(s_voice_badge_lbl, lv_color_hex(COL_TEXT), 0);
        lv_label_set_text(s_voice_badge_lbl, "REC - SPEAK NOW");
        lv_label_set_text(s_voice_user_lbl, "Mic active (16kHz PCM)...");
        lv_label_set_text(s_voice_reply_lbl, "Release OK to send to Hub");
        lv_label_set_text(s_footer_lbl, "RELEASE OK TO SEND");
    } else if (st->voice_phase == PA_VOICE_SENDING) {
        lv_obj_set_style_bg_color(s_voice_badge, lv_color_hex(COL_AMBER), 0);
        lv_obj_set_style_text_color(s_voice_badge_lbl, lv_color_hex(COL_DARK_TEXT), 0);
        lv_label_set_text(s_voice_badge_lbl, "THINKING...");
        lv_label_set_text(s_voice_user_lbl, "Uploading clip to Hub...");
        lv_label_set_text(s_voice_reply_lbl, "Running Voice Copilot...");
        lv_label_set_text(s_footer_lbl, "PLEASE WAIT...");
    } else {
        lv_obj_set_style_bg_color(s_voice_badge, lv_color_hex(COL_EMERALD), 0);
        lv_obj_set_style_text_color(s_voice_badge_lbl, lv_color_hex(COL_DARK_TEXT), 0);
        lv_label_set_text(s_voice_badge_lbl, "VOICE REPLY");
        char uline[110];
        snprintf(uline, sizeof(uline), "> %s", st->voice_transcript[0] ? st->voice_transcript : "(voice)");
        lv_label_set_text(s_voice_user_lbl, uline);
        lv_label_set_text(s_voice_reply_lbl, st->voice_reply[0] ? st->voice_reply : "Done.");
        lv_label_set_text(s_footer_lbl, "OK: CLOSE  HOLD: SPEAK");
    }
}

void pa_ui_render(const pa_state_t *st)
{
    if (!st || !s_scr) return;
    render_header(st);

    if (st->screen == PA_SCREEN_DASHBOARD) {
        lv_obj_remove_flag(s_dash_view, LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_flag(s_app_view, LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_flag(s_voice_view, LV_OBJ_FLAG_HIDDEN);
        render_dashboard(st);
    } else if (st->screen == PA_SCREEN_APPROVAL) {
        lv_obj_add_flag(s_dash_view, LV_OBJ_FLAG_HIDDEN);
        lv_obj_remove_flag(s_app_view, LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_flag(s_voice_view, LV_OBJ_FLAG_HIDDEN);
        render_approval(st);
    } else {
        lv_obj_add_flag(s_dash_view, LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_flag(s_app_view, LV_OBJ_FLAG_HIDDEN);
        lv_obj_remove_flag(s_voice_view, LV_OBJ_FLAG_HIDDEN);
        render_voice(st);
    }

    if (st->toast[0] != '\0') {
        lv_obj_remove_flag(s_toast_box, LV_OBJ_FLAG_HIDDEN);
        lv_obj_set_style_bg_color(s_toast_box, lv_color_hex(st->toast_is_error ? COL_CRIMSON : COL_EMERALD), 0);
        lv_obj_set_style_text_color(s_toast_lbl,
                                    lv_color_hex(st->toast_is_error ? COL_TEXT : COL_DARK_TEXT), 0);
        lv_label_set_text(s_toast_lbl, st->toast);
    } else {
        lv_obj_add_flag(s_toast_box, LV_OBJ_FLAG_HIDDEN);
    }
}
