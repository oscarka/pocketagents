// main/pa_audio.c
#include "pa_audio.h"
#include "bsp_audio.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

static const char *TAG = "pa_audio";

// Max 1.5 seconds of 16kHz 16-bit mono PCM = 48 KB (allocated on demand during PTT, freed after upload).
#define PA_PTT_MAX_BYTES   (PA_AUDIO_SAMPLE_RATE * 2 * 3 / 2)
#define PA_PTT_CHUNK_BYTES 1024

static bool s_ready = false;
static SemaphoreHandle_t s_audio_mux = NULL;
static volatile bool s_recording = false;
static TaskHandle_t s_rec_task = NULL;
static uint8_t *s_rec_buf = NULL;
static size_t s_rec_len = 0;

bool pa_audio_init(void)
{
    if (!s_audio_mux) {
        s_audio_mux = xSemaphoreCreateMutex();
    }
    if (bsp_audio_init() != ESP_OK) {
        ESP_LOGW(TAG, "ES8311 audio init failed (running muted)");
        s_ready = false;
        return false;
    }
    if (bsp_audio_set_format(PA_AUDIO_SAMPLE_RATE, 16, 1) != ESP_OK) {
        ESP_LOGW(TAG, "ES8311 format 16kHz/16bit/mono failed");
        s_ready = false;
        return false;
    }
    bsp_audio_set_volume(72);
    s_ready = true;
    ESP_LOGI(TAG, "Audio ready (16kHz 16-bit mono)");
    return true;
}

bool pa_audio_is_ready(void)
{
    return s_ready;
}

static void play_tone_locked(float freq_hz, int duration_ms, float gain)
{
    if (!s_ready || freq_hz <= 0.0f || duration_ms <= 0) return;
    int16_t buf[256];
    int total_samples = (PA_AUDIO_SAMPLE_RATE * duration_ms) / 1000;
    int rendered = 0;
    const float phase_step = (2.0f * 3.14159265f * freq_hz) / (float)PA_AUDIO_SAMPLE_RATE;
    float phase = 0.0f;

    while (rendered < total_samples) {
        int n = total_samples - rendered;
        if (n > 256) n = 256;
        for (int i = 0; i < n; i++) {
            int pos = rendered + i;
            float env = 1.0f;
            if (pos < 80) env = (float)pos / 80.0f;
            else if (pos > total_samples - 120) env = (float)(total_samples - pos) / 120.0f;
            if (env < 0.0f) env = 0.0f;
            float s = sinf(phase) * gain * env * 22000.0f;
            buf[i] = (int16_t)s;
            phase += phase_step;
            if (phase >= 6.2831853f) phase -= 6.2831853f;
        }
        (void)bsp_audio_write(buf, (size_t)n * sizeof(int16_t));
        rendered += n;
    }
}

static void play_silence_locked(int duration_ms)
{
    if (!s_ready || duration_ms <= 0) return;
    int16_t zeros[128] = { 0 };
    int total_samples = (PA_AUDIO_SAMPLE_RATE * duration_ms) / 1000;
    while (total_samples > 0) {
        int n = total_samples > 128 ? 128 : total_samples;
        (void)bsp_audio_write(zeros, (size_t)n * sizeof(int16_t));
        total_samples -= n;
    }
}

void pa_audio_play_chime(pa_chime_t chime)
{
    if (!s_ready || chime == PA_CHIME_NONE || !s_audio_mux) return;
    if (xSemaphoreTake(s_audio_mux, pdMS_TO_TICKS(150)) != pdTRUE) return;

    switch (chime) {
    case PA_CHIME_NEW_APPROVAL:
        play_tone_locked(659.25f, 85, 0.55f);
        play_silence_locked(25);
        play_tone_locked(880.0f, 110, 0.60f);
        break;
    case PA_CHIME_OK:
        play_tone_locked(880.0f, 65, 0.50f);
        play_tone_locked(1174.66f, 95, 0.55f);
        break;
    case PA_CHIME_DENY:
        play_tone_locked(440.0f, 80, 0.50f);
        play_tone_locked(329.63f, 110, 0.50f);
        break;
    case PA_CHIME_WARN_L2:
        for (int i = 0; i < 3; i++) {
            play_tone_locked(987.77f, 75, 0.65f);
            play_silence_locked(45);
        }
        break;
    case PA_CHIME_PTT_START:
        play_tone_locked(784.0f, 60, 0.45f);
        break;
    case PA_CHIME_PTT_STOP:
        play_tone_locked(587.33f, 60, 0.45f);
        break;
    default:
        break;
    }
    xSemaphoreGive(s_audio_mux);
}

void pa_audio_play_pcm_chunk(const void *pcm, size_t bytes)
{
    if (!s_ready || !pcm || bytes == 0 || !s_audio_mux) return;
    if (xSemaphoreTake(s_audio_mux, pdMS_TO_TICKS(250)) != pdTRUE) return;
    (void)bsp_audio_write(pcm, bytes);
    xSemaphoreGive(s_audio_mux);
}

static void ptt_record_task(void *arg)
{
    (void)arg;
    while (s_recording && s_rec_buf && s_rec_len + PA_PTT_CHUNK_BYTES <= PA_PTT_MAX_BYTES) {
        if (xSemaphoreTake(s_audio_mux, pdMS_TO_TICKS(100)) == pdTRUE) {
            esp_err_t err = bsp_audio_read(s_rec_buf + s_rec_len, PA_PTT_CHUNK_BYTES);
            xSemaphoreGive(s_audio_mux);
            if (err == ESP_OK) {
                s_rec_len += PA_PTT_CHUNK_BYTES;
            } else {
                vTaskDelay(pdMS_TO_TICKS(20));
            }
        } else {
            vTaskDelay(pdMS_TO_TICKS(10));
        }
    }
    s_rec_task = NULL;
    vTaskDelete(NULL);
}

bool pa_audio_record_start(void)
{
    if (!s_ready || s_recording) return false;
    if (s_rec_buf) {
        free(s_rec_buf);
        s_rec_buf = NULL;
    }
    s_rec_buf = (uint8_t *)malloc(PA_PTT_MAX_BYTES);
    if (!s_rec_buf) {
        ESP_LOGE(TAG, "Out of heap for PTT buffer (%u bytes)", (unsigned)PA_PTT_MAX_BYTES);
        return false;
    }
    s_rec_len = 0;
    s_recording = true;
    if (xTaskCreate(ptt_record_task, "pa_ptt", 3072, NULL, 4, &s_rec_task) != pdPASS) {
        s_recording = false;
        free(s_rec_buf);
        s_rec_buf = NULL;
        return false;
    }
    return true;
}

uint8_t *pa_audio_record_stop(size_t *out_bytes)
{
    if (out_bytes) *out_bytes = 0;
    s_recording = false;
    for (int i = 0; i < 30 && s_rec_task != NULL; i++) {
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    uint8_t *buf = s_rec_buf;
    size_t len = s_rec_len;
    s_rec_buf = NULL;
    s_rec_len = 0;
    if (out_bytes) *out_bytes = len;
    return buf;
}
