// main/pa_portal.h
// Short-lived SoftAP Captive Portal (PocketAgents-Setup @ 192.168.4.1) for phone Wi-Fi + Hub setup.
// Follows ESP32-C3 no-PSRAM resource budget: strict bounded inputs, clean AP/DNS/HTTP teardown.
#pragma once

#include "pa_net.h"

#include <stdbool.h>

#define PA_PORTAL_AP_SSID "PocketAgents-Setup"

typedef void (*pa_portal_phone_cb_t)(bool connected);
typedef void (*pa_portal_saved_cb_t)(void);

// Start temporary APSTA hotspot + wildcard DNS captive portal + phone setup webpage.
bool pa_portal_start(pa_net_config_t *cfg,
                     pa_portal_phone_cb_t on_phone,
                     pa_portal_saved_cb_t on_saved);

// Stop HTTP server, stop DNS responder, and switch back to pure STA mode to free SRAM & sockets.
void pa_portal_stop(void);

bool pa_portal_is_active(void);
bool pa_portal_is_phone_connected(void);
