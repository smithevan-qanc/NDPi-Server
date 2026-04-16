#include <cstdio>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>
#include "Processing.NDI.Lib.h"

int main(int argc, char* argv[])
{
    int timeout_seconds = 5;
    if (argc > 1) {
        timeout_seconds = std::atoi(argv[1]);
    }
    
    // Initialize NDI
    if (!NDIlib_initialize()) {
        return 1;
    }

    // Create NDI finder
    NDIlib_find_instance_t pNDI_find = NDIlib_find_create_v2();
    if (!pNDI_find) {
        NDIlib_destroy();
        return 1;
    }

    // Wait for sources with specified timeout
    NDIlib_find_wait_for_sources(pNDI_find, timeout_seconds * 1000);

    // Get the current sources
    uint32_t no_sources = 0;
    const NDIlib_source_t* p_sources = NDIlib_find_get_current_sources(pNDI_find, &no_sources);

    // Output JSON format for easy parsing
    printf("[\n");
    for (uint32_t i = 0; i < no_sources; i++) {
        printf("  {\"name\": \"%s\", \"url\": \"%s\"}", 
               p_sources[i].p_ndi_name ? p_sources[i].p_ndi_name : "", 
               p_sources[i].p_url_address ? p_sources[i].p_url_address : "");
        if (i < no_sources - 1) printf(",");
        printf("\n");
    }
    printf("]\n");

    // Cleanup
    NDIlib_find_destroy(pNDI_find);
    NDIlib_destroy();

    return 0;
}
