idf_component_register(
    SRCS "main.c"
         "pa_model.c"
         "pa_ui.c"
         "pa_audio.c"
         "pa_net.c"
    INCLUDE_DIRS "."
    REQUIRES bsp esp_event esp_http_client esp_hw_support esp_netif esp_timer esp_wifi nvs_flash mbedtls
)
