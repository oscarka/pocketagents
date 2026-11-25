// main/pa_ui.h
// Custom cyber-dark 240x320 LVGL 9.5 UI for PocketAgents on FoloToy AI Passport.
// Caller MUST hold bsp_lvgl_lock() when invoking pa_ui_init() or pa_ui_render().
#pragma once

#include "pa_model.h"

void pa_ui_init(void);
void pa_ui_render(const pa_state_t *st);
