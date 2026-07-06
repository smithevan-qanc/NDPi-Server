/**
 * NDI Discover - NDI SDK v6 with Dynamic Library Loading
 * 
 * Features:
 * - NDI SDK v6 support with dynamic library loading
 * - No compile-time NDI SDK linking required
 * - Discovers all available NDI sources on the network
 * - Outputs results in JSON format for easy parsing
 * 
 * Compilation:
 *   g++ -o ndi_discover ndi_discover.cpp -ldl -std=c++11
 * 
 * Usage:
 *   ./ndi_discover [timeout_seconds]
 *   Default timeout: 5 seconds
 *   Example: ./ndi_discover 10
 * 
 * Requirements:
 * - NDI SDK v6 installed (library will be dynamically loaded)
 * - Library paths: /usr/lib/libndi.so.6, /usr/local/lib/libndi.so.6, etc.
 */

#include <cstdio>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>
#include <dlfcn.h>
#include "Processing.NDI.Lib.h"

// NDIlib_frame_type_compressed_video is not part of the public NDI SDK v6 enum.
// NDI HX sources deliver compressed frames with a compressed FourCC via the
// regular NDIlib_frame_type_video path. We keep this value for forward-compat.
#ifndef NDIlib_frame_type_compressed_video
#  define NDIlib_frame_type_compressed_video ((NDIlib_frame_type_e)5)
#endif

// NDI SDK v6 Dynamic Loading
struct NDILib {
    void* handle = nullptr;
    
    // Function pointers for NDI SDK v6
    bool (*initialize)(void) = nullptr;
    void (*destroy)(void) = nullptr;
    const char* (*version)(void) = nullptr;
    
    // Finder functions (v6 compatible)
    NDIlib_find_instance_t (*find_create_v2)(const NDIlib_find_create_t* p_create_settings) = nullptr;
    void (*find_destroy)(NDIlib_find_instance_t p_instance) = nullptr;
    bool (*find_wait_for_sources)(NDIlib_find_instance_t p_instance, uint32_t timeout_in_ms) = nullptr;
    const NDIlib_source_t* (*find_get_current_sources)(NDIlib_find_instance_t p_instance, uint32_t* p_no_sources) = nullptr;
    
    bool loadLibrary() {
        // Try to load NDI library from common locations
        const char* lib_paths[] = {
            "/usr/local/lib/libndi.dylib",           // macOS Homebrew
            "/opt/homebrew/lib/libndi.dylib",        // macOS M1/M2 Homebrew
            "/usr/lib/libndi.so.6",                  // Linux v6
            "/usr/local/lib/libndi.so.6",            // Linux v6 alt
            "/usr/lib/libndi.so",                    // Linux fallback
            "/usr/local/lib/libndi.so",              // Linux alt fallback
            "libndi.dylib",                          // macOS system
            "libndi.so.6",                           // Linux v6 system
            "libndi.so",                             // Linux system fallback
            nullptr
        };
        
        for (int i = 0; lib_paths[i] != nullptr; i++) {
            handle = dlopen(lib_paths[i], RTLD_LAZY | RTLD_LOCAL);
            if (handle) {
                std::cout << "Loaded NDI library from: " << lib_paths[i] << std::endl;
                break;
            }
        }
        
        if (!handle) {
            std::cerr << "Failed to load NDI library: " << dlerror() << std::endl;
            return false;
        }
        
        // Load function pointers
        #define LOAD_FUNC(name) \
            name = reinterpret_cast<decltype(name)>(dlsym(handle, "NDIlib_" #name)); \
            if (!name) { \
                std::cerr << "Failed to load NDIlib_" #name << ": " << dlerror() << std::endl; \
                dlclose(handle); \
                handle = nullptr; \
                return false; \
            }
        
        LOAD_FUNC(initialize);
        LOAD_FUNC(destroy);
        LOAD_FUNC(version);
        LOAD_FUNC(find_create_v2);
        LOAD_FUNC(find_destroy);
        LOAD_FUNC(find_wait_for_sources);
        LOAD_FUNC(find_get_current_sources);
        
        #undef LOAD_FUNC
        
        std::cout << version() << std::endl;
        return true;
    }
    
    void unloadLibrary() {
        if (handle) {
            dlclose(handle);
            handle = nullptr;
        }
    }
};

// Global NDI library instance
NDILib g_ndi;

int main(int argc, char* argv[])
{
    std::cout << "NDPi - Custom NDI Tools (" << __FILE_NAME__ << ")" << std::endl;
    
    int timeout_seconds = 5;
    if (argc > 1) {
        timeout_seconds = std::atoi(argv[1]);
    }
    
    // Load NDI library dynamically
    if (!g_ndi.loadLibrary()) {
        std::cerr << "Failed to load NDI library. Please ensure NDI SDK v6 is installed." << std::endl;
        return 1;
    }
    
    // Initialize NDI
    if (!g_ndi.initialize()) {
        g_ndi.unloadLibrary();
        return 1;
    }

    // Create NDI finder
    NDIlib_find_instance_t pNDI_find = g_ndi.find_create_v2(nullptr);
    if (!pNDI_find) {
        g_ndi.destroy();
        g_ndi.unloadLibrary();
        return 1;
    }

    // Wait for sources with specified timeout
    g_ndi.find_wait_for_sources(pNDI_find, timeout_seconds * 1000);

    // Get the current sources
    uint32_t no_sources = 0;
    const NDIlib_source_t* p_sources = g_ndi.find_get_current_sources(pNDI_find, &no_sources);

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
    g_ndi.find_destroy(pNDI_find);
    g_ndi.destroy();
    g_ndi.unloadLibrary();

    return 0;
}
