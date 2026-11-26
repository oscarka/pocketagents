// tests/test_pa_model.c
// Host-side C unit tests for PocketAgents FoloToy AI Passport pure state machine & JSON parser.
#include "../main/pa_model.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static void test_digest_parsing_and_auto_popup(void)
{
    const char *sample =
        "{\"ok\":true,\"unchanged\":false,\"rev\":\"9f8e7d6c5b\",\"ts\":1796000000000,"
        "\"summary\":{\"hostsOnline\":2,\"hostsTotal\":2,\"running\":1,\"pending\":2},"
        "\"approvals\":["
        "{\"slot\":1,\"hostId\":\"macbook-pro\",\"hostName\":\"MacBook Pro\",\"code\":\"CLD-101\","
        "\"agentId\":\"claude:1\",\"session\":\"\\u4fee\\u590d\\u5355\\u6d4b\",\"kind\":\"approval\","
        "\"tool\":\"Bash\",\"risk\":\"L1\",\"title\":\"Run unit tests\","
        "\"cmd\":\"npm test -- device-lite\",\"options\":[\"Allow once\",\"Deny\"]},"
        "{\"slot\":2,\"hostId\":\"mac-mini\",\"hostName\":\"Mac mini\",\"code\":\"AGY-202\","
        "\"agentId\":\"agy:2\",\"session\":\"Deploy\",\"kind\":\"question\","
        "\"tool\":\"ask_question\",\"risk\":\"L0\",\"title\":\"Select rollout\","
        "\"cmd\":\"Which strategy?\",\"options\":[\"Canary\",\"Full\",\"Hold\"]}"
        "],"
        "\"tasks\":["
        "{\"hostId\":\"macbook-pro\",\"hostName\":\"MacBook Pro\",\"agentId\":\"dsh:1\","
        "\"harness\":\"dsh\",\"title\":\"Build Web Bundle\",\"status\":\"running\",\"pending\":false}"
        "]}";

    pa_digest_t d;
    assert(pa_parse_digest_json(sample, &d));
    assert(d.ok == true);
    assert(d.unchanged == false);
    assert(strcmp(d.rev, "9f8e7d6c5b") == 0);
    assert(d.hosts_online == 2);
    assert(d.running_count == 1);
    assert(d.pending_count == 2);
    assert(d.approval_count == 2);
    assert(d.approvals[0].slot == 1);
    assert(d.approvals[0].risk == PA_RISK_L1);
    assert(d.approvals[0].is_question == false);
    assert(strcmp(d.approvals[0].session, "修复单测") == 0);
    assert(d.approvals[1].is_question == true);
    assert(d.approvals[1].option_count == 3);
    assert(strcmp(d.approvals[1].options[1], "Full") == 0);
    assert(d.task_count == 1);
    assert(strcmp(d.tasks[0].harness, "dsh") == 0);

    pa_state_t st;
    pa_state_init(&st);
    assert(st.screen == PA_SCREEN_DASHBOARD);

    // First arrival auto-pops Approval screen with alert chime
    pa_chime_t ch = pa_state_apply_digest(&st, &d, 1000);
    assert(ch == PA_CHIME_NEW_APPROVAL);
    assert(st.screen == PA_SCREEN_APPROVAL);
    assert(st.selected_approval == 0);

    // Unchanged digest does NOT re-chime
    pa_digest_t unchanged;
    assert(pa_parse_digest_json("{\"ok\":true,\"unchanged\":true,\"rev\":\"9f8e7d6c5b\",\"ts\":1796000001000}", &unchanged));
    assert(unchanged.unchanged == true);
    assert(pa_state_apply_digest(&st, &unchanged, 2000) == PA_CHIME_NONE);

    // DOWN navigates to approval #2 (multi-choice question)
    pa_dispatch_t act = pa_state_on_key(&st, PA_KEY_DOWN, PA_KEY_EV_CLICK, 2100);
    assert(act.cmd == PA_CMD_NONE);
    assert(st.selected_approval == 1);
    assert(st.selected_option == 0);

    // DOWN selects option 2 ("Full"), OK submits answer optionIndex=2
    act = pa_state_on_key(&st, PA_KEY_DOWN, PA_KEY_EV_CLICK, 2200);
    assert(st.selected_option == 1);
    act = pa_state_on_key(&st, PA_KEY_OK, PA_KEY_EV_CLICK, 2300);
    assert(act.cmd == PA_CMD_ANSWER);
    assert(act.slot == 2);
    assert(act.option_index == 2);
    char body[128];
    assert(pa_build_action_json(&act, body, sizeof(body)) > 0);
    assert(strcmp(body, "{\"type\":\"answer\",\"slot\":2,\"code\":\"AGY-202\",\"optionIndex\":2}") == 0);
}

static void test_l2_pin_guard_and_ptt_voice(void)
{
    const char *l2_digest =
        "{\"ok\":true,\"unchanged\":false,\"rev\":\"l2rev001\",\"ts\":100,"
        "\"summary\":{\"hostsOnline\":1,\"hostsTotal\":1,\"running\":0,\"pending\":1},"
        "\"approvals\":[{"
        "\"slot\":1,\"hostId\":\"m1\",\"hostName\":\"Mac\",\"code\":\"CDX-303\","
        "\"agentId\":\"codex:1\",\"session\":\"Cleanup\",\"kind\":\"approval\","
        "\"tool\":\"Bash\",\"risk\":\"L2\",\"title\":\"Force push\","
        "\"cmd\":\"git push --force\",\"options\":[\"Allow\",\"Deny\"]}],"
        "\"tasks\":[]}";

    pa_digest_t d;
    assert(pa_parse_digest_json(l2_digest, &d));
    pa_state_t st;
    pa_state_init(&st);
    assert(pa_state_apply_digest(&st, &d, 1000) == PA_CHIME_WARN_L2);
    assert(st.screen == PA_SCREEN_APPROVAL);

    // Single click OK sends approve -> Hub responds 409 requiresPin
    pa_dispatch_t act = pa_state_on_key(&st, PA_KEY_OK, PA_KEY_EV_CLICK, 1100);
    assert(act.cmd == PA_CMD_APPROVE);
    assert(st.busy == true);

    pa_action_result_t pin_res;
    assert(pa_parse_action_result_json(
        "{\"ok\":false,\"requiresPin\":true,\"risk\":\"L2\",\"confirmPin\":\"482\","
        "\"message\":\"L2 HIGH RISK! Say or enter PIN 482\"}", &pin_res));
    assert(pin_res.requires_pin == true);
    assert(strcmp(pin_res.confirm_pin, "482") == 0);
    assert(pa_state_apply_action_result(&st, &pin_res, false, 1200) == PA_CHIME_WARN_L2);
    assert(st.busy == false);
    assert(st.l2_pin_active == true);
    assert(strcmp(st.l2_pin_code, "482") == 0);

    // Hold OK -> PTT start, release OK -> PTT stop
    act = pa_state_on_key(&st, PA_KEY_OK, PA_KEY_EV_LONG, 1300);
    assert(act.cmd == PA_CMD_VOICE_START);
    assert(st.screen == PA_SCREEN_VOICE);
    assert(st.voice_phase == PA_VOICE_RECORDING);

    act = pa_state_on_key(&st, PA_KEY_OK, PA_KEY_EV_RELEASE, 2500);
    assert(act.cmd == PA_CMD_VOICE_STOP);
    assert(st.voice_phase == PA_VOICE_SENDING);

    pa_voice_result_t vres;
    assert(pa_parse_voice_result_json(
        "{\"ok\":true,\"transcript\":\"482\",\"reply\":\"Confirmed and approved\","
        "\"executed\":true,\"actionType\":\"approve\",\"requiresPin\":false}", &vres));
    assert(pa_state_apply_voice_result(&st, &vres, 2900) == PA_CHIME_OK);
    assert(st.l2_pin_active == false);
    assert(st.voice_phase == PA_VOICE_REPLY);

    // Click OK dismisses voice overlay back to approval/dashboard
    act = pa_state_on_key(&st, PA_KEY_OK, PA_KEY_EV_CLICK, 3000);
    assert(st.screen == PA_SCREEN_APPROVAL);

    // Double-click OK or Long-press DOWN denies
    act = pa_state_on_key(&st, PA_KEY_OK, PA_KEY_EV_DOUBLE, 3100);
    assert(act.cmd == PA_CMD_DENY);
    st.busy = false;
    act = pa_state_on_key(&st, PA_KEY_DOWN, PA_KEY_EV_LONG, 3200);
    assert(act.cmd == PA_CMD_DENY);

    // Console provisioning command parser
    char a1[160], a2[96];
    assert(pa_parse_console_cmd("pa set http://10.10.117.38:8787 passport-sim-demo\r\n",
                                a1, sizeof(a1), a2, sizeof(a2)) == 1);
    assert(strcmp(a1, "http://10.10.117.38:8787") == 0);
    assert(strcmp(a2, "passport-sim-demo") == 0);
    assert(pa_parse_console_cmd("pa wifi OfficeWiFi my secret pass\n",
                                a1, sizeof(a1), a2, sizeof(a2)) == 2);
    assert(strcmp(a1, "OfficeWiFi") == 0);
    assert(strcmp(a2, "my secret pass") == 0);
    assert(pa_parse_console_cmd("unknown cmd", a1, sizeof(a1), a2, sizeof(a2)) == 0);
}

static void test_softap_form_pair_code_and_demo_mode(void)
{
    // URL decode + SoftAP POST form parsing (with Chinese UTF-8 & special chars)
    const char *form = "ssid=MyHome_2.4G&pass=a%2Bb%26c&hub=http%3A%2F%2F192.168.1.25%3A8788&token=482910";
    char v[160];
    assert(pa_parse_form_field(form, "ssid", v, sizeof(v)));
    assert(strcmp(v, "MyHome_2.4G") == 0);
    assert(pa_parse_form_field(form, "pass", v, sizeof(v)));
    assert(strcmp(v, "a+b&c") == 0);
    assert(pa_parse_form_field(form, "hub", v, sizeof(v)));
    assert(strcmp(v, "http://192.168.1.25:8788") == 0);
    assert(pa_parse_form_field(form, "token", v, sizeof(v)));
    assert(strcmp(v, "482910") == 0);
    assert(pa_is_pair_code(v) == true);
    assert(pa_is_pair_code("MF9AJP") == true);
    assert(pa_is_pair_code("mf9ajp") == true);
    assert(pa_is_pair_code("dev_abcdef") == false);
    assert(pa_is_pair_code("dev_12") == false);
    assert(pa_is_pair_code("hst_99") == false);
    assert(pa_is_pair_code("MF9AJ!") == false);
    assert(pa_is_pair_code("12345") == false);

    // 6-digit pairing exchange JSON response parser
    char dev_tok[96];
    assert(pa_parse_pair_exchange_json(
        "{\"ok\":true,\"token\":\"dev_abc123\",\"deviceToken\":\"dev_real999\",\"deviceId\":\"d1\"}",
        dev_tok, sizeof(dev_tok)));
    assert(strcmp(dev_tok, "dev_real999") == 0);
    assert(!pa_parse_pair_exchange_json("{\"ok\":false,\"error\":\"expired\"}", dev_tok, sizeof(dev_tok)));

    // Long-press UP enters Setup screen; DOWN on Setup starts Offline Demo Mode
    pa_state_t st;
    pa_state_init(&st);
    pa_dispatch_t act = pa_state_on_key(&st, PA_KEY_UP, PA_KEY_EV_LONG, 100);
    assert(act.cmd == PA_CMD_ENTER_SETUP);
    pa_state_enter_setup(&st, "PocketAgents-Setup", 100);
    assert(st.screen == PA_SCREEN_SETUP);
    assert(st.setup_ap_active == true);

    act = pa_state_on_key(&st, PA_KEY_DOWN, PA_KEY_EV_CLICK, 200);
    assert(act.cmd == PA_CMD_START_DEMO);
    assert(pa_demo_start(&st, 200) == PA_CHIME_NEW_APPROVAL);
    assert(st.demo_mode == true);
    assert(st.screen == PA_SCREEN_APPROVAL);
    assert(st.digest.approval_count == 3);

    // Demo #1 (L1 Bash) -> OK approves -> moves to Demo #2 (Multi-choice)
    act = pa_state_on_key(&st, PA_KEY_OK, PA_KEY_EV_CLICK, 300);
    assert(act.cmd == PA_CMD_APPROVE);
    assert(pa_demo_handle_cmd(&st, &act, 300) == PA_CHIME_OK);
    assert(st.digest.approval_count == 2);
    assert(st.digest.approvals[0].is_question == true);

    // Demo #2 (Multi-choice) -> DOWN + OK submits option 2 -> moves to Demo #3 (L2 Danger)
    (void)pa_state_on_key(&st, PA_KEY_DOWN, PA_KEY_EV_CLICK, 400);
    act = pa_state_on_key(&st, PA_KEY_OK, PA_KEY_EV_CLICK, 450);
    assert(act.cmd == PA_CMD_ANSWER);
    assert(act.option_index == 2);
    assert(pa_demo_handle_cmd(&st, &act, 450) == PA_CHIME_OK);
    assert(st.digest.approval_count == 1);
    assert(st.digest.approvals[0].risk == PA_RISK_L2);

    // Demo #3 (L2 Danger) -> single OK triggers PIN 628 lock -> long-DOWN denies -> Dashboard!
    act = pa_state_on_key(&st, PA_KEY_OK, PA_KEY_EV_CLICK, 500);
    assert(pa_demo_handle_cmd(&st, &act, 500) == PA_CHIME_WARN_L2);
    assert(st.l2_pin_active == true);
    assert(strcmp(st.l2_pin_code, "628") == 0);
    assert(st.digest.approval_count == 1);

    act = pa_state_on_key(&st, PA_KEY_DOWN, PA_KEY_EV_LONG, 600);
    assert(act.cmd == PA_CMD_DENY);
    assert(pa_demo_handle_cmd(&st, &act, 600) == PA_CHIME_DENY);
    assert(st.digest.approval_count == 0);
    assert(st.screen == PA_SCREEN_DASHBOARD);
}

static void test_dns_captive_portal_edns0(void)
{
    const uint8_t ip4[4] = { 192, 168, 4, 1 };

    // 1. Modern iOS/Android A query for "captive.apple.com" WITH trailing 11-byte EDNS0 OPT record (ARCOUNT=1)
    uint8_t pkt[128];
    memset(pkt, 0, sizeof(pkt));
    // Header: ID=0x1234, RD=1, QDCOUNT=1, ARCOUNT=1
    pkt[0] = 0x12; pkt[1] = 0x34;
    pkt[2] = 0x01; pkt[3] = 0x00;
    pkt[4] = 0x00; pkt[5] = 0x01;
    pkt[10] = 0x00; pkt[11] = 0x01;
    // Question: \7captive\5apple\3com\0 + QTYPE=A(1) + QCLASS=IN(1)
    const uint8_t q[] = {
        7, 'c', 'a', 'p', 't', 'i', 'v', 'e',
        5, 'a', 'p', 'p', 'l', 'e',
        3, 'c', 'o', 'm', 0,
        0x00, 0x01, 0x00, 0x01
    };
    memcpy(pkt + 12, q, sizeof(q));
    // Trailing EDNS0 OPT RR (root=0, type=41, payload=4096, ext=0, rdlen=0)
    const uint8_t opt[] = { 0x00, 0x00, 0x29, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 };
    size_t q_end = 12 + sizeof(q);
    memcpy(pkt + q_end, opt, sizeof(opt));

    size_t rlen = pa_dns_build_captive_reply(pkt, q_end + sizeof(opt), sizeof(pkt), ip4);
    assert(rlen == q_end + 16); // EDNS0 cleanly stripped, A answer starts immediately at q_end!
    assert(pkt[6] == 0 && pkt[7] == 1);   // ANCOUNT = 1
    assert(pkt[10] == 0 && pkt[11] == 0); // ARCOUNT = 0
    assert(pkt[q_end] == 0xC0 && pkt[q_end + 1] == 0x0C);
    assert(pkt[q_end + 12] == 192 && pkt[q_end + 13] == 168 && pkt[q_end + 14] == 4 && pkt[q_end + 15] == 1);

    // 2. AAAA (type 28) query with EDNS0 -> must return NOERROR empty answer (ANCOUNT=0) so iOS falls back to IPv4
    uint8_t pkt6[128];
    memcpy(pkt6, pkt, q_end + sizeof(opt));
    pkt6[2] = 0x01; pkt6[3] = 0x00;
    pkt6[10] = 0x00; pkt6[11] = 0x01;
    pkt6[q_end - 3] = 0x1C; // QTYPE = 28 (AAAA)
    size_t rlen6 = pa_dns_build_captive_reply(pkt6, q_end + sizeof(opt), sizeof(pkt6), ip4);
    assert(rlen6 == q_end);
    assert(pkt6[6] == 0 && pkt6[7] == 0); // ANCOUNT = 0
    assert(pkt6[10] == 0 && pkt6[11] == 0);

    // 3. Truncated / malformed query must safely return 0
    uint8_t bad[16] = { 0 };
    bad[5] = 1;
    bad[12] = 40; // claims 40-byte label in 16-byte packet!
    assert(pa_dns_build_captive_reply(bad, sizeof(bad), sizeof(bad), ip4) == 0);
}

static void test_wifi_reconnect_reason_and_quoted_cli(void)
{
    // 1. Quoted SSID with spaces & UTF-8 Chinese characters
    char a1[160], a2[96];
    assert(pa_parse_console_cmd("pa wifi \"My Home 2.4G\" my secret pass\r\n",
                                a1, sizeof(a1), a2, sizeof(a2)) == 2);
    assert(strcmp(a1, "My Home 2.4G") == 0);
    assert(strcmp(a2, "my secret pass") == 0);

    assert(pa_parse_console_cmd("pa wifi \"咖啡馆 2.4G\"\n",
                                a1, sizeof(a1), a2, sizeof(a2)) == 2);
    assert(strcmp(a1, "咖啡馆 2.4G") == 0);
    assert(a2[0] == '\0');

    // 2. Exponential backoff curve (78/esp-wifi-connect pattern)
    assert(pa_wifi_backoff_ms(0) == 2000u);
    assert(pa_wifi_backoff_ms(1) == 4000u);
    assert(pa_wifi_backoff_ms(2) == 8000u);
    assert(pa_wifi_backoff_ms(3) == 15000u);
    assert(pa_wifi_backoff_ms(4) == 30000u);
    assert(pa_wifi_backoff_ms(20) == 30000u);

    // 3. Disconnect reason Chinese diagnostics
    char msg[64];
    pa_wifi_reason_zh(0, msg, sizeof(msg));
    assert(strstr(msg, "Wi-Fi") != NULL);
    pa_wifi_reason_zh(202, msg, sizeof(msg));
    assert(strstr(msg, "密码错误") != NULL);
    pa_wifi_reason_zh(15, msg, sizeof(msg));
    assert(strstr(msg, "密码错误") != NULL);
    pa_wifi_reason_zh(201, msg, sizeof(msg));
    assert(strstr(msg, "2.4G") != NULL);
    pa_wifi_reason_zh(200, msg, sizeof(msg));
    assert(strstr(msg, "信号") != NULL);

    // 4. Auto-portal guard: NEVER kick an already-connected session back to SoftAP on transient blip!
    assert(pa_should_auto_open_portal(false, true, true, false, 60000u) == false);
    assert(pa_should_auto_open_portal(true, false, false, false, 60000u) == false);
    assert(pa_should_auto_open_portal(false, false, false, true, 60000u) == false);
    // Cold boot without saved Wi-Fi -> opens after 4.5s (gives Web Simulator ~1.5s to connect)
    assert(pa_should_auto_open_portal(false, false, false, false, 4499u) == false);
    assert(pa_should_auto_open_portal(false, false, false, false, 4500u) == true);
    // Cold boot with saved Wi-Fi -> waits 16s before opening SoftAP
    assert(pa_should_auto_open_portal(false, false, true, false, 15999u) == false);
    assert(pa_should_auto_open_portal(false, false, true, false, 16000u) == true);
}

int main(void)
{
    test_digest_parsing_and_auto_popup();
    test_l2_pin_guard_and_ptt_voice();
    test_softap_form_pair_code_and_demo_mode();
    test_dns_captive_portal_edns0();
    test_wifi_reconnect_reason_and_quoted_cli();
    printf("ALL pa_model C host tests PASSED!\n");
    return 0;
}
