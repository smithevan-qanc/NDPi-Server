/**
 * Window to NDI Sender
 * 
 * Captures a single X11 window and broadcasts as NDI stream
 * Works like NDI Scan Converter
 * 
 * Usage:
 *    ./window_to_ndi <window_id> [--name "name"] [--bitrate 5000] [--fps 30]
 *    
 * Example:
 *    xdotool search --name "firefox" | head -1 | xargs -I{} ./window_to_ndi {} --name "Firefox"
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
#include <gst/gst.h>
#include <gst/app/gstappsink.h>
#include <Processing.NDI.Lib.h>
#include <Processing.NDI.Send.h>

// ===== NDI SDK v6 Dynamic Loading =====

struct NDILib {
    void* handle = nullptr;
    
    bool (*initialize)(void) = nullptr;
    void (*destroy)(void) = nullptr;
    const char* (*version)(void) = nullptr;
    
    typedef NDIlib_send_instance_t (*SendCreateFn)(const NDIlib_send_create_t* p_create_settings);
    typedef void (*SendDestroyFn)(NDIlib_send_instance_t p_instance);
    typedef void (*SendSendVideoFn)(NDIlib_send_instance_t p_instance, const NDIlib_video_frame_v2_t* p_video_data);
    
    SendCreateFn send_create = nullptr;
    SendDestroyFn send_destroy = nullptr;
    SendSendVideoFn send_send_video_v2 = nullptr;
    
    bool loadLibrary() {
        const char* lib_paths[] = {
            "lib/aarch64-rpi4-linux-gnueabi/libndi.so.6",
            "/opt/NDI SDK for Linux/lib/aarch64-rpi4-linux-gnueabi/libndi.so.6",
            "/usr/local/lib/libndi.so.6",
            "/usr/lib/libndi.so.6",
            "libndi.so.6",
            nullptr
        };

        for (const char** path = lib_paths; *path; ++path) {
            handle = dlopen(*path, RTLD_LAZY);
            if (handle) break;
        }

        if (!handle) {
            std::cerr << "ERROR: Failed to load NDI library" << std::endl;
            return false;
        }

        initialize = (decltype(initialize))dlsym(handle, "NDIlib_initialize");
        destroy = (decltype(destroy))dlsym(handle, "NDIlib_destroy");
        version = (decltype(version))dlsym(handle, "NDIlib_version");
        send_create = (SendCreateFn)dlsym(handle, "NDIlib_send_create");
        send_destroy = (SendDestroyFn)dlsym(handle, "NDIlib_send_destroy");
        send_send_video_v2 = (SendSendVideoFn)dlsym(handle, "NDIlib_send_send_video_v2");

        if (!initialize || !destroy || !version || !send_create || !send_destroy || !send_send_video_v2) {
            std::cerr << "ERROR: Failed to load NDI functions" << std::endl;
            return false;
        }

        return true;
    }

    ~NDILib() {
        if (handle) dlclose(handle);
    }
};

static NDILib g_ndi;
static bool g_running = true;

void signalHandler(int sig) {
    std::cout << "\nShutting down..." << std::endl;
    g_running = false;
}

class WindowToNDI {
private:
    uint32_t window_id;
    std::string ndi_name;
    int target_bitrate;
    int target_fps;
    
    GstElement* pipeline = nullptr;
    GstElement* h264_appsink = nullptr;
    GMainLoop* main_loop = nullptr;
    NDIlib_send_instance_t ndi_sender = nullptr;
    bool is_running = false;

public:
    WindowToNDI(uint32_t xid, const std::string& name, int bitrate, int fps)
        : window_id(xid), ndi_name(name), target_bitrate(bitrate), target_fps(fps) {
        gst_init(nullptr, nullptr);
    }

    ~WindowToNDI() {
        stop();
    }

    bool initializeNDI() {
        std::cout << "Initializing NDI..." << std::endl;

        if (!g_ndi.initialize()) {
            std::cerr << "Failed to initialize NDI" << std::endl;
            return false;
        }

        std::cout << "NDI Version: " << g_ndi.version() << std::endl;

        NDIlib_send_create_t send_desc = {
            ndi_name.c_str(),
            nullptr,
            true,
            false
        };

        ndi_sender = g_ndi.send_create(&send_desc);
        if (!ndi_sender) {
            std::cerr << "Failed to create NDI sender" << std::endl;
            return false;
        }

        std::cout << "NDI Sender created: " << ndi_name << std::endl;
        return true;
    }

    bool createPipeline() {
        std::cout << "Creating capture pipeline for window " << std::hex << window_id << std::dec << std::endl;

        char pipeline_str[1024];
        snprintf(pipeline_str, sizeof(pipeline_str),
            "ximagesrc xid=%u use-damage=false "
            "! videoscale ! videoconvert ! video/x-raw,format=I420 "
            "! x264enc speed-preset=ultrafast bitrate=%d key-int-max=30 "
            "! appsink name=h264_sink emit-signals=true sync=false max-buffers=3",
            window_id, target_bitrate);

        std::cout << "Pipeline: " << pipeline_str << std::endl;

        GError* error = nullptr;
        pipeline = gst_parse_launch(pipeline_str, &error);

        if (error) {
            std::cerr << "Failed to create pipeline: " << error->message << std::endl;
            g_error_free(error);
            return false;
        }

        if (!pipeline) {
            std::cerr << "Failed to create pipeline: returned NULL" << std::endl;
            return false;
        }

        h264_appsink = gst_bin_get_by_name(GST_BIN(pipeline), "h264_sink");
        if (!h264_appsink) {
            std::cerr << "Failed to get h264_sink element" << std::endl;
            gst_object_unref(pipeline);
            pipeline = nullptr;
            return false;
        }

        g_signal_connect(h264_appsink, "new-sample", G_CALLBACK(onNewSample), this);

        GstStateChangeReturn state_ret = gst_element_set_state(pipeline, GST_STATE_PLAYING);
        if (state_ret == GST_STATE_CHANGE_FAILURE) {
            std::cerr << "Failed to start pipeline" << std::endl;
            gst_object_unref(h264_appsink);
            gst_object_unref(pipeline);
            pipeline = nullptr;
            return false;
        }

        std::cout << "Pipeline started successfully" << std::endl;
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

        GstStructure* structure = gst_caps_get_structure(caps, 0);
        int width, height;
        gint fps_n, fps_d;

        if (!gst_structure_get_int(structure, "width", &width) ||
            !gst_structure_get_int(structure, "height", &height) ||
            !gst_structure_get_fraction(structure, "framerate", &fps_n, &fps_d)) {
            gst_sample_unref(sample);
            return GST_FLOW_ERROR;
        }

        GstMapInfo map;
        if (!gst_buffer_map(buffer, &map, GST_MAP_READ)) {
            gst_sample_unref(sample);
            return GST_FLOW_ERROR;
        }

        NDIlib_video_frame_v2_t video_frame = {};
        video_frame.xres = width;
        video_frame.yres = height;
        video_frame.frame_rate_N = fps_n;
        video_frame.frame_rate_D = fps_d;
        video_frame.FourCC = (NDIlib_FourCC_video_type_e)NDI_LIB_FOURCC('H', '2', '6', '4');
        video_frame.picture_aspect_ratio = (float)width / (float)height;
        video_frame.frame_format_type = NDIlib_frame_format_type_progressive;
        video_frame.timecode = NDIlib_send_timecode_synthesize;

        uint8_t* frame_data = (uint8_t*)malloc(map.size);
        if (!frame_data) {
            gst_buffer_unmap(buffer, &map);
            gst_sample_unref(sample);
            return GST_FLOW_ERROR;
        }

        memcpy(frame_data, map.data, map.size);
        gst_buffer_unmap(buffer, &map);

        video_frame.p_data = frame_data;
        video_frame.data_size_in_bytes = map.size;
        video_frame.line_stride_in_bytes = 0;

        static int frame_count = 0;
        static bool first = true;
        if (first) {
            std::cout << "[NDI] Streaming: " << width << "x" << height << " @ " << fps_n << "/" << fps_d << " fps" << std::endl;
            first = false;
        }

        if (++frame_count % 60 == 0) {
            std::cout << "[NDI] Frame " << frame_count << " (" << map.size << " bytes)" << std::endl;
        }

        g_ndi.send_send_video_v2(self->ndi_sender, &video_frame);
        free(frame_data);
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

            if (h264_appsink) {
                gst_object_unref(h264_appsink);
                h264_appsink = nullptr;
            }

            gst_object_unref(pipeline);
            pipeline = nullptr;
        }

        if (ndi_sender) {
            g_ndi.send_destroy(ndi_sender);
            ndi_sender = nullptr;
        }

        std::cout << "Stopped" << std::endl;
    }

    void gstMainLoopThread() {
        g_main_loop_run(main_loop);
    }

    bool isRunning() const {
        return is_running;
    }
};

void printUsage(const char* prog) {
    std::cout << "Window to NDI - Capture X11 window and stream to NDI\n"
              << "Usage: " << prog << " <window_id> [options]\n"
              << "Options:\n"
              << "  --name <name>        NDI source name (default: window-ndi)\n"
              << "  --bitrate <kbps>     H.264 bitrate in Kbps (default: 5000)\n"
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
    int bitrate = 5000;
    int fps = 30;

    for (int i = 2; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--name" && i + 1 < argc) {
            ndi_name = argv[++i];
        } else if (arg == "--bitrate" && i + 1 < argc) {
            bitrate = std::atoi(argv[++i]);
        } else if (arg == "--fps" && i + 1 < argc) {
            fps = std::atoi(argv[++i]);
        } else if (arg == "--help") {
            printUsage(argv[0]);
            return 0;
        }
    }

    if (!g_ndi.loadLibrary()) {
        std::cerr << "Failed to load NDI library" << std::endl;
        return 1;
    }

    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    std::cout << "Window to NDI Sender" << std::endl;
    std::cout << "Window ID: " << std::hex << window_id << std::dec << std::endl;
    std::cout << "NDI Name: " << ndi_name << std::endl;
    std::cout << "Bitrate: " << bitrate << " Kbps" << std::endl;
    std::cout << "FPS: " << fps << std::endl;

    WindowToNDI sender(window_id, ndi_name, bitrate, fps);
    if (!sender.start()) {
        std::cerr << "Failed to start" << std::endl;
        return 1;
    }

    std::cout << "Press Ctrl+C to exit" << std::endl;

    while (g_running) {
        sleep(1);
    }

    sender.stop();
    return 0;
}
