// main/pa_portal.h
// Battle-tested SoftAP Captive Portal (modeled on 78/esp-wifi-connect WifiConfigurationAp):
// non-blocking background AP scan cache, live Wi-Fi verification with inline error reporting,
// MAC-suffixed AP SSID (PocketAgents-XXXX), and explicit OS captive-portal probes.
#pragma once

#include "pa_net.h"

#include <stdbool.h>
#include <stddef.h>

#define PA_PORTAL_AP_PREFIX "PocketAgents"

typedef void (*pa_portal_phone_cb_t)(bool connected);
typedef void (*pa_portal_saved_cb_t)(void);

// Fill MAC-suffixed SoftAP SSID (e.g. "PocketAgents-A1B2") into out.
void pa_portal_get_ap_ssid(char *out, size_t out_size);

// Start temporary APSTA hotspot + wildcard EDNS0 DNS captive portal + phone setup webpage.
bool pa_portal_start(pa_net_config_t *cfg,
                     pa_portal_phone_cb_t on_phone,
                     pa_portal_saved_cb_t on_saved);

// Stop HTTP server, background scan timer, DNS responder, and switch back to pure STA mode.
void pa_portal_stop(void);

bool pa_portal_is_active(void);
bool pa_portal_is_phone_connected(void);
