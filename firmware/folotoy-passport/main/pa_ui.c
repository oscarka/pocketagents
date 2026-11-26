// main/pa_ui.c
// Original PocketAgents 240x320 LVGL 9.5 Full-Chinese interface (zero runtime widget churn).
// Calibrated for physical FoloToy AI Passport 30px rounded display bezel + SoftAP phone setup view.
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

#ifdef PA_HAS_FULL_ZH_FONT
LV_FONT_DECLARE(pa_font_zh_16);
LV_FONT_DECLARE(pa_font_zh_12);
#endif

// Writable CJK font descriptors with clean fallback chains
static lv_font_t s_font_16;
static lv_font_t s_font_12;
static lv_font_t s_font_cmd_14;

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
static lv_obj_t *s_dash_guide_card;
static lv_obj_t *s_dash_guide_title;
static lv_obj_t *s_dash_guide_body;

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

// Phone SoftAP Wi-Fi Setup view
static lv_obj_t *s_setup_view;
static lv_obj_t *s_setup_pill;
static lv_obj_t *s_setup_pill_lbl;
static lv_obj_t *s_setup_ssid_lbl;
static lv_obj_t *s_setup_hint_lbl;

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
    lv_obj_align(val, LV_ALIGN_TOP_MID, 0, 5);
    lv_label_set_text(val, "0");

    lv_obj_t *cap = lv_label_create(box);
    lv_obj_set_style_text_font(cap, &s_font_12, 0);
    lv_obj_set_style_text_color(cap, lv_color_hex(COL_MUTED), 0);
    lv_obj_align(cap, LV_ALIGN_BOTTOM_MID, 0, -5);
    lv_label_set_text(cap, caption);

    *out_val = val;
    return box;
}

void pa_ui_init(void)
{
#ifdef PA_HAS_FULL_ZH_FONT
    s_font_16 = pa_font_zh_16;
    s_font_16.fallback = &lv_font_montserrat_16;
    s_font_12 = pa_font_zh_12;
    s_font_12.fallback = &s_font_16;
#else
    s_font_16 = lv_font_source_han_sans_sc_16_cjk;
    s_font_16.fallback = &lv_font_montserrat_16;
    s_font_12 = lv_font_source_han_sans_sc_16_cjk;
    s_font_12.fallback = &lv_font_montserrat_12;
#endif
    s_font_cmd_14 = lv_font_montserrat_14;
    s_font_cmd_14.fallback = &s_font_16;

    s_scr = lv_obj_create(NULL);
    lv_obj_remove_style_all(s_scr);
    lv_obj_set_size(s_scr, 240, 320);
    lv_obj_set_style_bg_color(s_scr, lv_color_hex(COL_BG), 0);
    lv_obj_set_style_bg_opa(s_scr, LV_OPA_COVER, 0);
    lv_obj_remove_flag(s_scr, LV_OBJ_FLAG_SCROLLABLE);

    // --- Header bar (inset for 30px curved top corners) ---
    s_net_dot = make_clean_box(s_scr, 20, 17, 8, 8, COL_AMBER, 4, 0, 0);

    s_hdr_title = lv_label_create(s_scr);
    lv_obj_set_style_text_font(s_hdr_title, &s_font_16, 0);
    lv_obj_set_style_text_color(s_hdr_title, lv_color_hex(COL_TEXT), 0);
    lv_obj_set_pos(s_hdr_title, 33, 12);
    lv_label_set_text(s_hdr_title, "口袋代理");

    s_hdr_right = lv_label_create(s_scr);
    lv_obj_set_style_text_font(s_hdr_right, &s_font_12, 0);
    lv_obj_set_style_text_color(s_hdr_right, lv_color_hex(COL_MUTED), 0);
    lv_obj_align(s_hdr_right, LV_ALIGN_TOP_RIGHT, -20, 15);
    lv_label_set_text(s_hdr_right, "SIM");

    (void)make_clean_box(s_scr, 14, 36, 212, 1, COL_BORDER, 0, 0, 0);

    // --- 1. Dashboard View (y = 40..268) ---
    s_dash_view = make_clean_box(s_scr, 0, 40, 240, 228, COL_BG, 0, 0, 0);

    (void)make_metric_tile(s_dash_view, 12, 4, 68, 52, "电脑", COL_SKY, &s_tile_hosts_val);
    (void)make_metric_tile(s_dash_view, 86, 4, 68, 52, "运行", COL_EMERALD, &s_tile_run_val);
    s_tile_wait_box = make_metric_tile(s_dash_view, 160, 4, 68, 52, "待批", COL_AMBER, &s_tile_wait_val);

    // Status banner
    s_dash_banner = make_clean_box(s_dash_view, 12, 62, 216, 26, COL_CARD_ALT, 8, COL_BORDER, 1);
    s_dash_banner_lbl = lv_label_create(s_dash_banner);
    lv_obj_set_style_text_font(s_dash_banner_lbl, &s_font_12, 0);
    lv_obj_set_style_text_color(s_dash_banner_lbl, lv_color_hex(COL_MUTED), 0);
    lv_label_set_long_mode(s_dash_banner_lbl, LV_LABEL_LONG_DOT);
    lv_obj_set_width(s_dash_banner_lbl, 204);
    lv_obj_set_style_text_align(s_dash_banner_lbl, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_center(s_dash_banner_lbl);
    lv_label_set_text(s_dash_banner_lbl, "正在连 Wi-Fi...");

    // 4 compact task rows
    for (int i = 0; i < 4; i++) {
        int ry = 94 + i * 32;
        s_task_rows[i] = make_clean_box(s_dash_view, 12, ry, 216, 28, COL_CARD, 8, COL_BORDER, 1);
        s_task_dots[i] = make_clean_box(s_task_rows[i], 8, 10, 8, 8, COL_MUTED, 4, 0, 0);

        s_task_titles[i] = lv_label_create(s_task_rows[i]);
        lv_obj_set_style_text_font(s_task_titles[i], &s_font_16, 0);
        lv_obj_set_style_text_color(s_task_titles[i], lv_color_hex(COL_TEXT), 0);
        lv_label_set_long_mode(s_task_titles[i], LV_LABEL_LONG_DOT);
        lv_obj_set_width(s_task_titles[i], 148);
        lv_obj_set_pos(s_task_titles[i], 22, 4);
        lv_label_set_text(s_task_titles[i], "");

        s_task_tags[i] = lv_label_create(s_task_rows[i]);
        lv_obj_set_style_text_font(s_task_tags[i], &s_font_12, 0);
        lv_obj_set_style_text_color(s_task_tags[i], lv_color_hex(COL_MUTED), 0);
        lv_obj_align(s_task_tags[i], LV_ALIGN_RIGHT_MID, -8, 0);
        lv_label_set_text(s_task_tags[i], "");

        lv_obj_add_flag(s_task_rows[i], LV_OBJ_FLAG_HIDDEN);
    }

    // Helpful guide card when no tasks / not connected yet (never leave a blank void!)
    s_dash_guide_card = make_clean_box(s_dash_view, 12, 94, 216, 124, COL_CARD, 10, COL_BORDER, 1);
    s_dash_guide_title = lv_label_create(s_dash_guide_card);
    lv_obj_set_style_text_font(s_dash_guide_title, &s_font_16, 0);
    lv_obj_set_style_text_color(s_dash_guide_title, lv_color_hex(COL_SKY), 0);
    lv_obj_set_width(s_dash_guide_title, 196);
    lv_obj_set_pos(s_dash_guide_title, 10, 10);
    lv_label_set_text(s_dash_guide_title, "快速上手");

    s_dash_guide_body = lv_label_create(s_dash_guide_card);
    lv_obj_set_style_text_font(s_dash_guide_body, &s_font_12, 0);
    lv_obj_set_style_text_color(s_dash_guide_body, lv_color_hex(COL_TEXT), 0);
    lv_label_set_long_mode(s_dash_guide_body, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s_dash_guide_body, 196);
    lv_obj_set_style_text_line_space(s_dash_guide_body, 5, 0);
    lv_obj_set_pos(s_dash_guide_body, 10, 36);
    lv_label_set_text(s_dash_guide_body, "");
    lv_obj_add_flag(s_dash_guide_card, LV_OBJ_FLAG_HIDDEN);

    // --- 2. Approval / Multi-Choice Triage View (y = 40..268) ---
    s_app_view = make_clean_box(s_scr, 0, 40, 240, 228, COL_BG, 0, 0, 0);

    s_app_slot_lbl = lv_label_create(s_app_view);
    lv_obj_set_style_text_font(s_app_slot_lbl, &s_font_16, 0);
    lv_obj_set_style_text_color(s_app_slot_lbl, lv_color_hex(COL_TEXT), 0);
    lv_label_set_long_mode(s_app_slot_lbl, LV_LABEL_LONG_DOT);
    lv_obj_set_width(s_app_slot_lbl, 134);
    lv_obj_set_pos(s_app_slot_lbl, 14, 2);
    lv_label_set_text(s_app_slot_lbl, "#1/1");

    s_app_risk_pill = make_clean_box(s_app_view, 152, 2, 76, 22, COL_AMBER, 11, 0, 0);
    s_app_risk_lbl = lv_label_create(s_app_risk_pill);
    lv_obj_set_style_text_font(s_app_risk_lbl, &s_font_12, 0);
    lv_obj_set_style_text_color(s_app_risk_lbl, lv_color_hex(COL_DARK_TEXT), 0);
    lv_obj_center(s_app_risk_lbl);
    lv_label_set_text(s_app_risk_lbl, "L1 常规");

    s_app_meta_lbl = lv_label_create(s_app_view);
    lv_obj_set_style_text_font(s_app_meta_lbl, &s_font_12, 0);
    lv_obj_set_style_text_color(s_app_meta_lbl, lv_color_hex(COL_SKY), 0);
    lv_label_set_long_mode(s_app_meta_lbl, LV_LABEL_LONG_DOT);
    lv_obj_set_width(s_app_meta_lbl, 212);
    lv_obj_set_pos(s_app_meta_lbl, 14, 27);
    lv_label_set_text(s_app_meta_lbl, "");

    s_app_card = make_clean_box(s_app_view, 12, 46, 216, 174, COL_CARD, 12, COL_AMBER, 2);

    s_app_title_lbl = lv_label_create(s_app_card);
    lv_obj_set_style_text_font(s_app_title_lbl, &s_font_16, 0);
    lv_obj_set_style_text_color(s_app_title_lbl, lv_color_hex(COL_TEXT), 0);
    lv_label_set_long_mode(s_app_title_lbl, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s_app_title_lbl, 194);
    lv_obj_set_pos(s_app_title_lbl, 10, 8);
    lv_label_set_text(s_app_title_lbl, "");

    s_app_cmd_lbl = lv_label_create(s_app_card);
    lv_obj_set_style_text_font(s_app_cmd_lbl, &s_font_cmd_14, 0);
    lv_obj_set_style_text_color(s_app_cmd_lbl, lv_color_hex(COL_MUTED), 0);
    lv_label_set_long_mode(s_app_cmd_lbl, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s_app_cmd_lbl, 194);
    lv_obj_set_pos(s_app_cmd_lbl, 10, 50);
    lv_label_set_text(s_app_cmd_lbl, "");

    s_opt_box = make_clean_box(s_app_card, 8, 50, 200, 116, COL_CARD, 0, 0, 0);
    for (int i = 0; i < PA_MAX_OPTIONS; i++) {
        s_opt_rows[i] = make_clean_box(s_opt_box, 0, i * 28, 200, 25, COL_CARD_ALT, 6, COL_BORDER, 1);
        s_opt_lbls[i] = lv_label_create(s_opt_rows[i]);
        lv_obj_set_style_text_font(s_opt_lbls[i], &s_font_16, 0);
        lv_obj_set_style_text_color(s_opt_lbls[i], lv_color_hex(COL_TEXT), 0);
        lv_label_set_long_mode(s_opt_lbls[i], LV_LABEL_LONG_DOT);
        lv_obj_set_width(s_opt_lbls[i], 186);
        lv_obj_align(s_opt_lbls[i], LV_ALIGN_LEFT_MID, 7, 0);
        lv_label_set_text(s_opt_lbls[i], "");
    }
    lv_obj_add_flag(s_opt_box, LV_OBJ_FLAG_HIDDEN);

    s_l2_banner = make_clean_box(s_app_card, 8, 130, 200, 34, COL_CRIMSON, 8, 0, 0);
    s_l2_banner_lbl = lv_label_create(s_l2_banner);
    lv_obj_set_style_text_font(s_l2_banner_lbl, &s_font_12, 0);
    lv_obj_set_style_text_color(s_l2_banner_lbl, lv_color_hex(COL_TEXT), 0);
    lv_obj_center(s_l2_banner_lbl);
    lv_label_set_text(s_l2_banner_lbl, "高危码 ---");
    lv_obj_add_flag(s_l2_banner, LV_OBJ_FLAG_HIDDEN);

    lv_obj_add_flag(s_app_view, LV_OBJ_FLAG_HIDDEN);

    // --- 3. Voice Push-To-Talk View (y = 40..268) ---
    s_voice_view = make_clean_box(s_scr, 0, 40, 240, 228, COL_BG, 0, 0, 0);

    s_voice_badge = make_clean_box(s_voice_view, 36, 8, 168, 30, COL_SKY, 15, 0, 0);
    s_voice_badge_lbl = lv_label_create(s_voice_badge);
    lv_obj_set_style_text_font(s_voice_badge_lbl, &s_font_16, 0);
    lv_obj_set_style_text_color(s_voice_badge_lbl, lv_color_hex(COL_DARK_TEXT), 0);
    lv_obj_center(s_voice_badge_lbl);
    lv_label_set_text(s_voice_badge_lbl, "语音对讲");

    lv_obj_t *v_card = make_clean_box(s_voice_view, 12, 46, 216, 174, COL_CARD, 12, COL_SKY, 2);
    s_voice_user_lbl = lv_label_create(v_card);
    lv_obj_set_style_text_font(s_voice_user_lbl, &s_font_16, 0);
    lv_obj_set_style_text_color(s_voice_user_lbl, lv_color_hex(COL_SKY), 0);
    lv_label_set_long_mode(s_voice_user_lbl, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s_voice_user_lbl, 194);
    lv_obj_set_pos(s_voice_user_lbl, 10, 10);
    lv_label_set_text(s_voice_user_lbl, "");

    s_voice_reply_lbl = lv_label_create(v_card);
    lv_obj_set_style_text_font(s_voice_reply_lbl, &s_font_16, 0);
    lv_obj_set_style_text_color(s_voice_reply_lbl, lv_color_hex(COL_TEXT), 0);
    lv_label_set_long_mode(s_voice_reply_lbl, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s_voice_reply_lbl, 194);
    lv_obj_set_pos(s_voice_reply_lbl, 10, 62);
    lv_label_set_text(s_voice_reply_lbl, "");

    lv_obj_add_flag(s_voice_view, LV_OBJ_FLAG_HIDDEN);

    // --- 4. Phone SoftAP Wi-Fi Setup View (y = 40..268) ---
    s_setup_view = make_clean_box(s_scr, 0, 40, 240, 228, COL_BG, 0, 0, 0);

    s_setup_pill = make_clean_box(s_setup_view, 40, 6, 160, 26, COL_AMBER, 13, 0, 0);
    s_setup_pill_lbl = lv_label_create(s_setup_pill);
    lv_obj_set_style_text_font(s_setup_pill_lbl, &s_font_12, 0);
    lv_obj_set_style_text_color(s_setup_pill_lbl, lv_color_hex(COL_DARK_TEXT), 0);
    lv_obj_center(s_setup_pill_lbl);
    lv_label_set_text(s_setup_pill_lbl, "手机热点配网中");

    lv_obj_t *s_card = make_clean_box(s_setup_view, 12, 38, 216, 182, COL_CARD, 12, COL_SKY, 2);

    lv_obj_t *st1 = lv_label_create(s_card);
    lv_obj_set_style_text_font(st1, &s_font_12, 0);
    lv_obj_set_style_text_color(st1, lv_color_hex(COL_MUTED), 0);
    lv_obj_set_pos(st1, 10, 10);
    lv_label_set_text(st1, "1. 手机连免密 Wi-Fi 热点:");

    lv_obj_t *ssid_box = make_clean_box(s_card, 10, 29, 194, 30, COL_CARD_ALT, 8, COL_SKY, 1);
    s_setup_ssid_lbl = lv_label_create(ssid_box);
    lv_obj_set_style_text_font(s_setup_ssid_lbl, &lv_font_montserrat_16, 0);
    lv_obj_set_style_text_color(s_setup_ssid_lbl, lv_color_hex(COL_SKY), 0);
    lv_obj_center(s_setup_ssid_lbl);
    lv_label_set_text(s_setup_ssid_lbl, "PocketAgents-Setup");

    lv_obj_t *st2 = lv_label_create(s_card);
    lv_obj_set_style_text_font(st2, &s_font_12, 0);
    lv_obj_set_style_text_color(st2, lv_color_hex(COL_MUTED), 0);
    lv_obj_set_pos(st2, 10, 67);
    lv_label_set_text(st2, "2. 自动弹窗或浏览器打开:");

    lv_obj_t *ip_box = make_clean_box(s_card, 10, 86, 194, 28, 0x0B2B22u, 8, COL_EMERALD, 1);
    lv_obj_t *ip_lbl = lv_label_create(ip_box);
    lv_obj_set_style_text_font(ip_lbl, &lv_font_montserrat_16, 0);
    lv_obj_set_style_text_color(ip_lbl, lv_color_hex(COL_EMERALD), 0);
    lv_obj_center(ip_lbl);
    lv_label_set_text(ip_lbl, "192.168.4.1");

    s_setup_hint_lbl = lv_label_create(s_card);
    lv_obj_set_style_text_font(s_setup_hint_lbl, &s_font_12, 0);
    lv_obj_set_style_text_color(s_setup_hint_lbl, lv_color_hex(COL_TEXT), 0);
    lv_label_set_long_mode(s_setup_hint_lbl, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s_setup_hint_lbl, 194);
    lv_obj_set_style_text_line_space(s_setup_hint_lbl, 4, 0);
    lv_obj_set_pos(s_setup_hint_lbl, 10, 122);
    lv_label_set_text(s_setup_hint_lbl, "3. 选 2.4G Wi-Fi 点保存即可\n没开电脑？按 ↓ 先体验演示");

    lv_obj_add_flag(s_setup_view, LV_OBJ_FLAG_HIDDEN);

    // --- Toast pill ---
    s_toast_box = make_clean_box(s_scr, 18, 236, 204, 26, COL_EMERALD, 13, 0, 0);
    s_toast_lbl = lv_label_create(s_toast_box);
    lv_obj_set_style_text_font(s_toast_lbl, &s_font_12, 0);
    lv_obj_set_style_text_color(s_toast_lbl, lv_color_hex(COL_DARK_TEXT), 0);
    lv_label_set_long_mode(s_toast_lbl, LV_LABEL_LONG_DOT);
    lv_obj_set_width(s_toast_lbl, 188);
    lv_obj_set_style_text_align(s_toast_lbl, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_center(s_toast_lbl);
    lv_obj_add_flag(s_toast_box, LV_OBJ_FLAG_HIDDEN);

    // --- Footer keybar (raised 4px for crisp clearance above real physical bottom corner bezel) ---
    (void)make_clean_box(s_scr, 22, 270, 196, 1, COL_BORDER, 0, 0, 0);
    s_footer_lbl = lv_label_create(s_scr);
    lv_obj_set_style_text_font(s_footer_lbl, &s_font_12, 0);
    lv_obj_set_style_text_color(s_footer_lbl, lv_color_hex(COL_MUTED), 0);
    lv_obj_set_width(s_footer_lbl, 196);
    lv_obj_set_style_text_align(s_footer_lbl, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s_footer_lbl, LV_ALIGN_BOTTOM_MID, 0, -26);
    lv_label_set_text(s_footer_lbl, "OK:同步  长按↑:配网");

    lv_screen_load(s_scr);
}

static void render_header(const pa_state_t *st)
{
    uint32_t dot_col = COL_AMBER;
    if (st->demo_mode) dot_col = COL_SKY;
    else if (st->net_status == PA_NET_ONLINE) dot_col = COL_EMERALD;
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

    if (st->demo_mode) {
        lv_obj_set_style_bg_color(s_dash_banner, lv_color_hex(0x0B2B22u), 0);
        lv_obj_set_style_text_color(s_dash_banner_lbl, lv_color_hex(COL_EMERALD), 0);
        lv_label_set_text(s_dash_banner_lbl, "演示模式 · 全部就绪");
    } else if (st->net_status == PA_NET_AUTH_ERROR) {
        lv_obj_set_style_bg_color(s_dash_banner, lv_color_hex(0x3B0E18u), 0);
        lv_obj_set_style_text_color(s_dash_banner_lbl, lv_color_hex(COL_CRIMSON), 0);
        lv_label_set_text(s_dash_banner_lbl, st->net_detail[0] ? st->net_detail : "认证失败 (401)");
    } else if (st->net_status != PA_NET_ONLINE) {
        if (st->wifi_ip[0] != '\0') {
            lv_obj_set_style_bg_color(s_dash_banner, lv_color_hex(0x0B2B22u), 0);
            lv_obj_set_style_text_color(s_dash_banner_lbl, lv_color_hex(COL_EMERALD), 0);
            lv_label_set_text_fmt(s_dash_banner_lbl, "Wi-Fi已连 %s", st->wifi_ip);
        } else {
            lv_obj_set_style_bg_color(s_dash_banner, lv_color_hex(COL_CARD_ALT), 0);
            lv_obj_set_style_text_color(s_dash_banner_lbl, lv_color_hex(COL_AMBER), 0);
            lv_label_set_text(s_dash_banner_lbl, st->net_detail[0] ? st->net_detail : "正在连 Wi-Fi...");
        }
    } else if (st->digest.pending_count > 0) {
        lv_obj_set_style_bg_color(s_dash_banner, lv_color_hex(0x3B2A0Au), 0);
        lv_obj_set_style_text_color(s_dash_banner_lbl, lv_color_hex(COL_AMBER), 0);
        lv_label_set_text_fmt(s_dash_banner_lbl, "有 %d 条待批 · 按 OK 处理", st->digest.pending_count);
    } else {
        lv_obj_set_style_bg_color(s_dash_banner, lv_color_hex(0x0B2B22u), 0);
        lv_obj_set_style_text_color(s_dash_banner_lbl, lv_color_hex(COL_EMERALD), 0);
        lv_label_set_text(s_dash_banner_lbl, "已连接 · 全部就绪");
    }

    int count = st->digest.task_count < 4 ? st->digest.task_count : 4;
    if (count == 0 && !st->demo_mode) {
        for (int i = 0; i < 4; i++) lv_obj_add_flag(s_task_rows[i], LV_OBJ_FLAG_HIDDEN);
        lv_obj_remove_flag(s_dash_guide_card, LV_OBJ_FLAG_HIDDEN);
        if (st->wifi_ip[0] != '\0') {
            lv_label_set_text(s_dash_guide_title, "尚未连上电脑控制台");
            lv_label_set_text(s_dash_guide_body,
                              "• 长按 ↑ 键手机填电脑地址与\n  6 位配对码\n• 按 ↓ 键立即离线体验演示");
        } else {
            lv_label_set_text(s_dash_guide_title, "首次使用指引");
            lv_label_set_text(s_dash_guide_body,
                              "• 未连网将自动开配网热点\n• 随时长按 ↑ 键手机配 Wi-Fi\n• 按 ↓ 键直接体验离线演示");
        }
    } else {
        lv_obj_add_flag(s_dash_guide_card, LV_OBJ_FLAG_HIDDEN);
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
            const char *tag = "空闲";
            if (t->pending || strcmp(t->status, "approval") == 0) {
                dcol = COL_AMBER;
                tag = "待批";
            } else if (strcmp(t->status, "running") == 0) {
                dcol = COL_EMERALD;
                tag = "运行";
            }
            lv_obj_set_style_bg_color(s_task_dots[i], lv_color_hex(dcol), 0);
            lv_obj_set_style_text_color(s_task_tags[i], lv_color_hex(dcol), 0);
            lv_label_set_text(s_task_titles[i], t->title[0] ? t->title : t->agent_id);
            lv_label_set_text(s_task_tags[i], tag);
        }
    }

    if (st->demo_mode) {
        lv_label_set_text(s_footer_lbl, "OK:重播演示  长按↑:配网");
    } else if (st->digest.pending_count > 0) {
        lv_label_set_text(s_footer_lbl, "OK:去审批  长按OK:说话");
    } else if (count == 0) {
        lv_label_set_text(s_footer_lbl, "↓:演示体验  长按↑:配网");
    } else {
        lv_label_set_text(s_footer_lbl, "↑↓:切换  长按OK:说话");
    }
}

static void render_approval(const pa_state_t *st)
{
    if (st->digest.approval_count <= 0) return;
    int idx = st->selected_approval;
    if (idx < 0 || idx >= st->digest.approval_count) idx = 0;
    const pa_approval_t *a = &st->digest.approvals[idx];

    lv_label_set_text_fmt(s_app_slot_lbl, "#%d/%d %s", a->slot, st->digest.approval_count,
                          a->tool[0] ? a->tool : (a->is_question ? "请你选择" : "审批"));

    uint32_t risk_col = COL_AMBER;
    const char *risk_txt = "L1 常规";
    if (a->risk == PA_RISK_L0) {
        risk_col = COL_EMERALD;
        risk_txt = a->is_question ? "多选题" : "L0 安全";
    } else if (a->risk == PA_RISK_L2) {
        risk_col = COL_CRIMSON;
        risk_txt = "L2 高危";
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
    lv_label_set_text(s_app_title_lbl, a->title[0] ? a->title : "待确认审批");

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
            char line[64];
            snprintf(line, sizeof(line), "%s %d. %s", sel ? ">" : " ", i + 1, a->options[i]);
            lv_label_set_text(s_opt_lbls[i], line);
        }
        lv_obj_add_flag(s_l2_banner, LV_OBJ_FLAG_HIDDEN);
        lv_label_set_text(s_footer_lbl, "↑↓:选选项  OK:确认");
    } else {
        lv_obj_add_flag(s_opt_box, LV_OBJ_FLAG_HIDDEN);
        lv_obj_remove_flag(s_app_cmd_lbl, LV_OBJ_FLAG_HIDDEN);
        lv_label_set_text(s_app_cmd_lbl, a->cmd[0] ? a->cmd : "(无命令原文)");

        bool show_pin = st->l2_pin_active && strcmp(st->l2_target_code, a->code) == 0;
        if (show_pin) {
            lv_obj_remove_flag(s_l2_banner, LV_OBJ_FLAG_HIDDEN);
            lv_label_set_text_fmt(s_l2_banner_lbl, "高危码 %s · 长按OK报码",
                                  st->l2_pin_code[0] ? st->l2_pin_code : "---");
            lv_label_set_text(s_footer_lbl, "长按OK报码  长按↓拒");
        } else {
            lv_obj_add_flag(s_l2_banner, LV_OBJ_FLAG_HIDDEN);
            if (a->risk == PA_RISK_L2) {
                lv_label_set_text(s_footer_lbl, "OK:取高危码  长按↓:拒");
            } else {
                lv_label_set_text(s_footer_lbl, "OK:放行  长按↓:拒绝");
            }
        }
    }
}

static void render_voice(const pa_state_t *st)
{
    if (st->voice_phase == PA_VOICE_RECORDING) {
        lv_obj_set_style_bg_color(s_voice_badge, lv_color_hex(COL_CRIMSON), 0);
        lv_obj_set_style_text_color(s_voice_badge_lbl, lv_color_hex(COL_TEXT), 0);
        lv_label_set_text(s_voice_badge_lbl, "录音中 · 请说话");
        lv_label_set_text(s_voice_user_lbl, "正在采集 16kHz 语音...");
        lv_label_set_text(s_voice_reply_lbl, "松开 OK 键发送给控制台");
        lv_label_set_text(s_footer_lbl, "松开 OK 发送");
    } else if (st->voice_phase == PA_VOICE_SENDING) {
        lv_obj_set_style_bg_color(s_voice_badge, lv_color_hex(COL_AMBER), 0);
        lv_obj_set_style_text_color(s_voice_badge_lbl, lv_color_hex(COL_DARK_TEXT), 0);
        lv_label_set_text(s_voice_badge_lbl, "语音思考中...");
        lv_label_set_text(s_voice_user_lbl, "已上传语音片段");
        lv_label_set_text(s_voice_reply_lbl, "正在理解意图并执行...");
        lv_label_set_text(s_footer_lbl, "请稍候...");
    } else {
        lv_obj_set_style_bg_color(s_voice_badge, lv_color_hex(COL_EMERALD), 0);
        lv_obj_set_style_text_color(s_voice_badge_lbl, lv_color_hex(COL_DARK_TEXT), 0);
        lv_label_set_text(s_voice_badge_lbl, "语音回复");
        char uline[110];
        snprintf(uline, sizeof(uline), "> %s", st->voice_transcript[0] ? st->voice_transcript : "(语音)");
        lv_label_set_text(s_voice_user_lbl, uline);
        lv_label_set_text(s_voice_reply_lbl, st->voice_reply[0] ? st->voice_reply : "已处理");
        lv_label_set_text(s_footer_lbl, "OK:返回  长按:继续说");
    }
}

static void render_setup(const pa_state_t *st)
{
    if (st->setup_phone_connected) {
        lv_obj_set_style_bg_color(s_setup_pill, lv_color_hex(COL_EMERALD), 0);
        lv_obj_set_style_text_color(s_setup_pill_lbl, lv_color_hex(COL_DARK_TEXT), 0);
        lv_label_set_text(s_setup_pill_lbl, "手机已连入 · 开网页");
    } else {
        lv_obj_set_style_bg_color(s_setup_pill, lv_color_hex(COL_AMBER), 0);
        lv_obj_set_style_text_color(s_setup_pill_lbl, lv_color_hex(COL_DARK_TEXT), 0);
        lv_label_set_text(s_setup_pill_lbl, "手机热点配网中");
    }
    lv_label_set_text(s_setup_ssid_lbl, st->setup_ap_ssid[0] ? st->setup_ap_ssid : "PocketAgents-Setup");
    lv_label_set_text(s_footer_lbl, "↓:演示体验  OK:重试连网");
}

void pa_ui_render(const pa_state_t *st)
{
    if (!st || !s_scr) return;
    render_header(st);

    lv_obj_add_flag(s_dash_view, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_app_view, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_voice_view, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_setup_view, LV_OBJ_FLAG_HIDDEN);

    if (st->screen == PA_SCREEN_DASHBOARD) {
        lv_obj_remove_flag(s_dash_view, LV_OBJ_FLAG_HIDDEN);
        render_dashboard(st);
    } else if (st->screen == PA_SCREEN_APPROVAL) {
        lv_obj_remove_flag(s_app_view, LV_OBJ_FLAG_HIDDEN);
        render_approval(st);
    } else if (st->screen == PA_SCREEN_VOICE) {
        lv_obj_remove_flag(s_voice_view, LV_OBJ_FLAG_HIDDEN);
        render_voice(st);
    } else {
        lv_obj_remove_flag(s_setup_view, LV_OBJ_FLAG_HIDDEN);
        render_setup(st);
    }

    bool l2_banner_visible = (st->screen == PA_SCREEN_APPROVAL && st->l2_pin_active &&
                              st->digest.approval_count > 0 &&
                              st->selected_approval < st->digest.approval_count &&
                              strcmp(st->l2_target_code, st->digest.approvals[st->selected_approval].code) == 0);

    if (st->toast[0] != '\0' && !l2_banner_visible && st->screen != PA_SCREEN_SETUP) {
        lv_obj_remove_flag(s_toast_box, LV_OBJ_FLAG_HIDDEN);
        lv_obj_set_style_bg_color(s_toast_box, lv_color_hex(st->toast_is_error ? COL_CRIMSON : COL_EMERALD), 0);
        lv_obj_set_style_text_color(s_toast_lbl,
                                    lv_color_hex(st->toast_is_error ? COL_TEXT : COL_DARK_TEXT), 0);
        lv_label_set_text(s_toast_lbl, st->toast);
    } else {
        lv_obj_add_flag(s_toast_box, LV_OBJ_FLAG_HIDDEN);
    }
}
