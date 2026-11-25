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

int main(void)
{
    test_digest_parsing_and_auto_popup();
    test_l2_pin_guard_and_ptt_voice();
    printf("ALL pa_model C host tests PASSED!\n");
    return 0;
}
