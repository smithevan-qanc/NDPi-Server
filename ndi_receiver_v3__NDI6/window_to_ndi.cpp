/**
 * Window to NDI Sender
 * 
 * Captures a single X11 window and broadcasts as NDI stream
 * Works like NDI Scan Converter
 * 
 * Usage:
 *    ./window_to_ndi <window_id> [--name "name"] [--width 1280] [--height 1024] [--fps 30]
 *    
 * Example:
 *    xdotool search --name "firefox" | head -1 | xargs -I{} ./window_to_ndi {} --name Firefox
 * 
 * Compilation:
 *    g++ -o window_to_ndi window_to_ndi.cpp \
 *        $(pkg-config --cflags --libs gstreamer-1.0 gstreamer-app-1.0) \
 *        -I"include" -ldl -std=c++11
 */

#include <iostream>
#include <string>
#include <cstring>
#include <thread>
#include <signal.h>
#include <cstdlib>
#include <dlfcn.h>
#include <unistd.h>
#include <queue>
#include <mutex>
#include <gst/gst.h>
#include <gst/app/gstappsink.h>
#include <Processing.NDI.Lib.h>

// ===== NDI SDK v6 Dynamic Loading (proper pattern) =====

static const NDIlib_v6* g_pNDILib = nullptr;
static void* g_hNDILib = nullptr;
static bool g_running = true;

bool loadNDI() {
    std::string ndi_path;

    const char* p_NDI_runtime_folder = getenv("NDILIB_REDIST_FOLDER");
    if (p_NDI_runtime_folder) {
        ndi_path = p_NDI_runtime_folder;
        #ifdef _WIN32
        ndi_path += "\\Processing.NDI.Lib.x64.dll";
        #else
        ndi_path += "/libndi.so.6";
        #endif
    } else {
        // Try multiple paths
        const char* lib_paths[] = {
            "lib/aarch64-rpi4-linux-gnueabi/libndi.so.6",
            "lib/arm-rpi4-linux-gnueabihf/libndi.so.6",
            "/opt/NDI SDK for Linux/lib/arm-rpi4-linux-gnueabihf/libndi.so.6",
            "/usr/local/lib/libndi.so.6",
            "/usr/lib/libndi.so.6",
            "libndi.so.6",
            nullptr
        };

        for (const char** path = lib_paths; *path; ++path) {
            g_hNDILib = dlopen(*path, RTLD_LOCAL | RTLD_LAZY);
            if (g_hNDILib) {
                std::cout << "[NDI] Library loaded: " << *path << std::endl;
                break;
            }
        }

        if (!g_hNDILib) {
            std::cerr << "[NDI] ERROR: Failed to load NDI library from any path" << std::endl;
            return false;
        }

        // Get the v6 loader
        typedef const NDIlib_v6* (*NDIlib_v6_load_t)(void);
        NDIlib_v6_load_t NDIlib_v6_load = (NDIlib_v6_load_t)dlsym(g_hNDILib, "NDIlib_v6_load");

        if (!NDIlib_v6_load) {
            std::cerr << "[NDI] ERROR: Failed to get NDIlib_v6_load" << std::endl;
            dlclose(g_hNDILib);
            g_hNDILib = nullptr;
            return false;
        }

        g_pNDILib = NDIlib_v6_load();
        if (!g_pNDILib) {
            std::cerr << "[NDI] ERROR: NDIlib_v6_load returned NULL" << std::endl;
            dlclose(g_hNDILib);
            g_hNDILib = nullptr;
            return false;
        }

        return true;
    }

    g_hNDILib = dlopen(ndi_path.c_str(), RTLD_LOCAL | RTLD_LAZY);
    if (!g_hNDILib) {
        std::cerr << "[NDI] ERROR: Failed to load: " << ndi_path << std::endl;
        return false;
    }

    typedef const NDIlib_v6* (*NDIlib_v6_load_t)(void);
    NDIlib_v6_load_t NDIlib_v6_load = (NDIlib_v6_load_t)dlsym(g_hNDILib, "NDIlib_v6_load");

    if (!NDIlib_v6_load) {
        std::cerr << "[NDI] ERROR: Failed to get NDIlib_v6_load" << std::endl;
        dlclose(g_hNDILib);
        g_hNDILib = nullptr;
        return false;
    }

    g_pNDILib = NDIlib_v6_load();
    if (!g_pNDILib) {
        std::cerr << "[NDI] ERROR: NDIlib_v6_load returned NULL" << std::endl;
        dlclose(g_hNDILib);
        g_hNDILib = nullptr;
        return false;
    }

    return true;
}

void unloadNDI() {
    if (g_hNDILib) {
        dlclose(g_hNDILib);
        g_hNDILib = nullptr;
    }
    g_pNDILib = nullptr;
}

void signalHandler(int sig) {
    std::cout << "\nShutting down..." << std::endl;
    g_running = false;
}

class WindowToNDI {
private:
    uint32_t window_id;
    std::string ndi_name;
    int target_width;
    int target_height;
    int target_fps;
    
    GstElement* pipeline = nullptr;
    GstElement* appsink = nullptr;
    GMainLoop* main_loop = nullptr;
    NDIlib_send_instance_t ndi_sender = nullptr;
    bool is_running = false;

    // Frame memory pool (keep frames briefly to prevent NDI from accessing freed memory)
    struct FrameBuffer {
        uint8_t* data;
        size_t size;
    };
    std::queue<FrameBuffer> frame_pool;
    std::mutex frame_pool_mutex;

    void enqueueFrame(uint8_t* data, size_t size) {
        std::lock_guard<std::mutex> lock(frame_pool_mutex);
        frame_pool.push({data, size});
        // Keep only last 3 frames in pool
        while (frame_pool.size() > 3) {
            free(frame_pool.front().data);
            frame_pool.pop();
        }
    }

    void clearFramePool() {
        std::lock_guard<std::mutex> lock(frame_pool_mutex);
        while (!frame_pool.empty()) {
            free(frame_pool.front().data);
            frame_pool.pop();
        }
    }

public:
    WindowToNDI(uint32_t xid, const std::string& name, int width, int height, int fps)
        : window_id(xid), ndi_name(name), target_width(width), target_height(height), target_fps(fps) {
        gst_init(nullptr, nullptr);
    }

    ~WindowToNDI() {
        stop();
    }

    bool initializeNDI() {
        if (!g_pNDILib) {
            std::cerr << "[NDI] ERROR: NDI library not loaded" << std::endl;
            return false;
        }

        std::cout << "[NDI] Initializing..." << std::endl;

        if (!g_pNDILib->initialize()) {
            std::cerr << "[NDI] ERROR: initialize() failed" << std::endl;
            return false;
        }

        std::cout << "[NDI] Version: " << g_pNDILib->version() << std::endl;

        // Create sender with proper settings
        NDIlib_send_create_t send_desc = {};
        send_desc.p_ndi_name = ndi_name.c_str();
        send_desc.clock_video = true;    // Clock to video
        send_desc.clock_audio = false;   // No audio

        ndi_sender = g_pNDILib->send_create(&send_desc);
        if (!ndi_sender) {
            std::cerr << "[NDI] ERROR: send_create() failed" << std::endl;
            return false;
        }

        std::cout << "[NDI] Sender created: " << ndi_name << std::endl;
        return true;
    }

    bool createPipeline() {
        std::cout << "[GST] Creating capture pipeline for window " << std::hex << window_id << std::dec << std::endl;
        std::cout << "[GST] Resolution: " << target_width << "x" << target_height << " @ " << target_fps << " fps" << std::endl;

        char pipeline_str[1024];
        snprintf(pipeline_str, sizeof(pipeline_str),
            "ximagesrc xid=%u use-damage=false "
            "! videoscale ! video/x-raw,width=%d,height=%d,framerate=%d/1 "
            "! videoconvert ! video/x-raw,format=BGRA "
            "! appsink name=sink emit-signals=true sync=false max-buffers=1 drop=true",
            window_id, target_width, target_height, target_fps);

        std::cout << "[GST] Pipeline: " << pipeline_str << std::endl;

        GError* error = nullptr;
        pipeline = gst_parse_launch(pipeline_str, &error);

        if (error) {
            std::cerr << "[GST] ERROR: " << error->message << std::endl;
            g_error_free(error);
            return false;
        }

        if (!pipeline) {
            std::cerr << "[GST] ERROR: pipeline creation returned NULL" << std::endl;
            return false;
        }

        appsink = gst_bin_get_by_name(GST_BIN(pipeline), "sink");
        if (!appsink) {
            std::cerr << "[GST] ERROR: Could not find sink element" << std::endl;
            gst_object_unref(pipeline);
            pipeline = nullptr;
            return false;
        }

        g_signal_connect(appsink, "new-sample", G_CALLBACK(onNewSample), this);

        GstStateChangeReturn state_ret = gst_element_set_state(pipeline, GST_STATE_PLAYING);
        if (state_ret == GST_STATE_CHANGE_FAILURE) {
            std::cerr << "[GST] ERROR: Failed to start pipeline" << std::endl;
            gst_object_unref(appsink);
            gst_object_unref(pipeline);
            pipeline = nullptr;
            appsink = nullptr;
            return false;
        }

        std::cout << "[GST] Pipeline started" << std::endl;
        return true;
    }

    static GstFlowReturn onNewSample(GstElement* sink, gpointer user_data) {
        WindowToNDI* self = (WindowToNDI*)user_data;

        GstSample* sample = gst_app_sink_pull_sample(GST_APP_SINK(sink));
        if (!sample) return GST_FLOW_ERROR;

        GstBuffer* buffer = gst_sample_get_buffer(sample);
        GstCaps* caps = gst_sample_get_caps(sample);

        if (!buffer || !caps) {
            gst_sample_unref(sample);
            return GST_FLOW_ERROR;
        }

        // Extract video info from caps
        GstStructure* structure = gst_caps_get_structure(caps, 0);
        int width, height;
        gint fps_n, fps_d;

        if (!gst_structure_get_int(structure, "width", &width) ||
            !gst_structure_get_int(structure, "height", &height) ||
            !gst_structure_get_fraction(structure, "framerate", &fps_n, &fps_d)) {
            std::cerr << "[GST] ERROR: Could not extract caps info" << std::endl;
            gst_sample_unref(sample);
            return GST_FLOW_ERROR;
        }

        // Map buffer to read data
        GstMapInfo map;
        if (!gst_buffer_map(buffer, &map, GST_MAP_READ)) {
            gst_sample_unref(sample);
            return GST_FLOW_ERROR;
        }

        // Create NDI video frame (BGRA format)
        NDIlib_video_frame_v2_t video_frame = {};
        video_frame.xres = width;
        video_frame.yres = height;
        video_frame.frame_rate_N = fps_n;
        video_frame.frame_rate_D = fps_d;
        video_frame.FourCC = NDIlib_FourCC_type_BGRA;
        video_frame.picture_aspect_ratio = (float)width / (float)height;
        video_frame.frame_format_type = NDIlib_frame_format_type_progressive;
        video_frame.timecode = NDIlib_send_timecode_synthesize;
        video_frame.line_stride_in_bytes = width * 4;  // BGRA = 4 bytes per pixel

        // Copy buffer data
        uint8_t* frame_data = (uint8_t*)malloc(map.size);
        if (!frame_data) {
            std::cerr << "[NDI] ERROR: malloc failed for frame data" << std::endl;
            gst_buffer_unmap(buffer, &map);
            gst_sample_unref(sample);
            return GST_FLOW_ERROR;
        }

        memcpy(frame_data, map.data, map.size);
        gst_buffer_unmap(buffer, &map);

        video_frame.p_data = frame_data;
        video_frame.data_size_in_bytes = map.size;

        static int frame_count = 0;
        static bool first = true;
        if (first) {
            std::cout << "[NDI] First frame: " << width << "x" << height 
                      << " @ " << fps_n << "/" << fps_d << " fps, " 
                      << map.size << " bytes" << std::endl;
            first = false;
        }

        if (++frame_count % 60 == 0) {
            std::cout << "[NDI] Frame " << frame_count << ": " << map.size << " bytes" << std::endl;
        }

        // Send to NDI
        g_pNDILib->send_send_video_v2(self->ndi_sender, &video_frame);

        // Don't free immediately - keep frame in pool for NDI to process
        self->enqueueFrame(frame_data, map.size);
        gst_sample_unref(sample);

        return GST_FLOW_OK;
    }

    bool start() {
        if (!initializeNDI()) return false;
        if (!createPipeline()) return false;

        main_loop = g_main_loop_new(nullptr, FALSE);
        std::thread(&WindowToNDI::gstMainLoopThread, this).detach();

        is_running = true;
        return true;
    }

    void stop() {
        if (!is_running) return;

        is_running = false;

        if (main_loop && g_main_loop_is_running(main_loop)) {
            g_main_loop_quit(main_loop);
        }

        if (pipeline) {
            gst_element_set_state(pipeline, GST_STATE_NULL);
            gst_element_get_state(pipeline, nullptr, nullptr, GST_CLOCK_TIME_NONE);

            if (appsink) {
                gst_object_unref(appsink);
                appsink = nullptr;
            }

            gst_object_unref(pipeline);
            pipeline = nullptr;
        }

        clearFramePool();

        if (ndi_sender && g_pNDILib) {
            g_pNDILib->send_destroy(ndi_sender);
            ndi_sender = nullptr;
        }

        std::cout << "[NDI] Stopped" << std::endl;
    }

    void gstMainLoopThread() {
        g_main_loop_run(main_loop);
    }
};

void printUsage(const char* prog) {
    std::cout << "Window to NDI - Capture X11 window and stream to NDI\n"
              << "Usage: " << prog << " <window_id> [options]\n"
              << "Options:\n"
              << "  --name <name>        NDI source name (default: window-ndi)\n"
              << "  --width <pixels>     Capture width (default: 1280)\n"
              << "  --height <pixels>    Capture height (default: 1024)\n"
              << "  --fps <fps>          Target FPS (default: 30)\n"
              << "  --help               Show this help message\n"
              << "\nExample:\n"
              << "  xdotool search --name 'firefox' | head -1 | xargs -I{} " << prog << " {} --name Firefox\n";
}

int main(int argc, char* argv[]) {
    if (argc < 2) {
        printUsage(argv[0]);
        return 1;
    }

    uint32_t window_id = (uint32_t)strtoul(argv[1], nullptr, 0);
    std::string ndi_name = "window-ndi";
    int width = 1280;
    int height = 1024;
    int fps = 30;

    for (int i = 2; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--name" && i + 1 < argc) {
            ndi_name = argv[++i];
        } else if (arg == "--width" && i + 1 < argc) {
            width = std::atoi(argv[++i]);
        } else if (arg == "--height" && i + 1 < argc) {
            height = std::atoi(argv[++i]);
        } else if (arg == "--fps" && i + 1 < argc) {
            fps = std::atoi(argv[++i]);
        } else if (arg == "--help") {
            printUsage(argv[0]);
            return 0;
        }
    }

    std::cout << "Window to NDI Sender\n"
              << "Window ID: " << std::hex << window_id << std::dec << "\n"
              << "NDI Name: " << ndi_name << "\n"
              << "Resolution: " << width << "x" << height << "\n"
              << "FPS: " << fps << std::endl;

    if (!loadNDI()) {
        std::cerr << "Failed to load NDI library" << std::endl;
        return 1;
    }

    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    WindowToNDI sender(window_id, ndi_name, width, height, fps);
    if (!sender.start()) {
        std::cerr << "Failed to start sender" << std::endl;
        unloadNDI();
        return 1;
    }

    std::cout << "[INFO] Press Ctrl+C to exit" << std::endl;

    while (g_running) {
        sleep(1);
    }

    sender.stop();
    unloadNDI();
    return 0;
}
