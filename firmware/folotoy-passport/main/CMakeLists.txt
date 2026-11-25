set(PA_SRCS
    "main.c"
    "pa_model.c"
    "pa_ui.c"
    "pa_audio.c"
    "pa_net.c"
)

set(PA_HAS_FULL_ZH 0)
if(EXISTS "${CMAKE_CURRENT_LIST_DIR}/pa_font_zh_16.c" AND EXISTS "${CMAKE_CURRENT_LIST_DIR}/pa_font_zh_12.c")
    list(APPEND PA_SRCS "pa_font_zh_16.c" "pa_font_zh_12.c")
    set(PA_HAS_FULL_ZH 1)
endif()

idf_component_register(
    SRCS ${PA_SRCS}
    INCLUDE_DIRS "."
    REQUIRES bsp esp_event esp_http_client esp_hw_support esp_netif esp_timer esp_wifi nvs_flash mbedtls
)

if(PA_HAS_FULL_ZH)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE PA_HAS_FULL_ZH_FONT=1)
endif()
