// main/pa_audio.h
// Lightweight ES8311 PCM16 chime synthesizer, PTT recorder, and streaming PCM playback.
#pragma once

#include "pa_model.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PA_AUDIO_SAMPLE_RATE 16000

bool pa_audio_init(void);
bool pa_audio_is_ready(void);
void pa_audio_play_chime(pa_chime_t chime);
void pa_audio_play_pcm_chunk(const void *pcm, size_t bytes);

// Start/stop non-blocking PTT capture on the audio worker; returns heap buffer caller must free().
bool pa_audio_record_start(void);
uint8_t *pa_audio_record_stop(size_t *out_bytes);
