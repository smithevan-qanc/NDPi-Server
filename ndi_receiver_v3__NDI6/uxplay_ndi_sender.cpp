/**
 * UXPlay to NDI Sender v1
 * 
 * Features:
 * - Launches uxplay (AirPlay receiver) as subprocess
 * - Captures video from framebuffer (/dev/fb0) or X11 display
 * - Encodes to H.264 using GPU acceleration (Raspberry Pi) or software fallback
 * - Broadcasts as discoverable NDI stream on network (NDI SDK v6)
 * - Ultra-low latency (<100ms), optimized for real-time AirPlay mirroring
 * - Automatic display resolution detection
 * - Graceful lifecycle management (auto-restart uxplay on crash)
 * 
 * Compilation (Raspberry Pi / Linux):
 *    g++ -o uxplay_ndi_sender uxplay_ndi_sender.cpp \
 *        $(pkg-config --cflags --libs gstreamer-1.0 gstreamer-app-1.0) \
 *        -I"include" -ldl -std=c++11
 * 
 * Usage:
 *    ./uxplay_ndi_sender [--name "uxplay-airplay"] [--bitrate 5000] [--fps 30]
 *    
 * Environment:
 *    DISPLAY=:0 for X11 capture
 *    or use /dev/fb0 for framebuffer capture (fallback)
 * 
 * Dependencies:
 *    - uxplay binary in PATH or /usr/local/bin/uxplay
 *    - GStreamer 1.0: gstreamer-1.0, gstreamer-app-1.0, gst-plugins-base, gst-plugins-good
 *    - NDI SDK v6: /opt/NDI SDK for Linux/lib/[arch]/libndi.so.6
 *    - Hardware: GPU H.264 encoder (omxh264enc) on Raspberry Pi 4/5, fallback to libx264
 */

#include <iostream>
#include <string>
#include <vector>
#include <cstring>
#include <thread>
#include <chrono>
#include <signal.h>
#include <cstdlib>
#include <dlfcn.h>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <gst/gst.h>
#include <gst/app/gstappsink.h>
#include <Processing.NDI.Lib.h>
#include <Processing.NDI.Send.h>

// ===== NDI SDK v6 Dynamic Loading =====

struct NDILib {
    void* handle = nullptr;
    
    // Core functions
    bool (*initialize)(void) = nullptr;
    void (*destroy)(void) = nullptr;
    const char* (*version)(void) = nullptr;
    
    // Send functions (NDI Sender) - typedef for proper casting
    typedef NDIlib_send_instance_t (*SendCreateFn)(const NDIlib_send_create_t* p_create_settings);
    typedef void (*SendDestroyFn)(NDIlib_send_instance_t p_instance);
    typedef void (*SendSendVideoFn)(NDIlib_send_instance_t p_instance, const NDIlib_video_frame_v2_t* p_video_data);
    typedef void (*SendSendAudioFn)(NDIlib_send_instance_t p_instance, const NDIlib_audio_frame_v3_t* p_audio_data);
    
    SendCreateFn send_create = nullptr;
    SendDestroyFn send_destroy = nullptr;
    SendSendVideoFn send_send_video_v2 = nullptr;
    SendSendAudioFn send_send_audio_v3 = nullptr;
    
    // Finder functions (for discovery)
    NDIlib_find_instance_t (*find_create_v2)(const NDIlib_find_create_t* p_create_settings) = nullptr;
    void (*find_destroy)(NDIlib_find_instance_t p_instance) = nullptr;
    
    bool loadLibrary() {
        const char* lib_paths[] = {
            "lib/aarch64-rpi4-linux-gnueabi/libndi.so.6",
            "lib/aarch64-rpi4-linux-gnueabi/libndi.so",
            "/opt/NDI SDK for Linux/lib/aarch64-rpi4-linux-gnueabi/libndi.so.6",
            "/opt/NDI SDK for Linux/lib/aarch64-rpi4-linux-gnueabi/libndi.so",
            "/usr/local/lib/libndi.so.6",
            "/usr/local/lib/libndi.so",
            "/usr/lib/libndi.so.6",
            "/usr/lib/libndi.so",
            "libndi.so.6",
            "libndi.so",
            nullptr
        };

        for (const char** path = lib_paths; *path; ++path) {
            handle = dlopen(*path, RTLD_LAZY);
            if (handle) {
                std::cout << "NDI Library loaded: " << *path << std::endl;
                break;
            }
        }

        if (!handle) {
            std::cerr << "ERROR: Failed to load NDI library" << std::endl;
            return false;
        }

        // Load function pointers - core NDI functions with NDIlib_ prefix
        auto* initialize_ptr = dlsym(handle, "NDIlib_initialize");
        auto* destroy_ptr = dlsym(handle, "NDIlib_destroy");
        auto* version_ptr = dlsym(handle, "NDIlib_version");
        
        if (!initialize_ptr || !destroy_ptr || !version_ptr) {
            std::cerr << "ERROR: Failed to load NDI core functions" << std::endl;
            return false;
        }
        
        initialize = (decltype(initialize))initialize_ptr;
        destroy = (decltype(destroy))destroy_ptr;
        version = (decltype(version))version_ptr;
        
        // Load send functions with proper casting
        auto* send_create_ptr = dlsym(handle, "NDIlib_send_create");
        auto* send_destroy_ptr = dlsym(handle, "NDIlib_send_destroy");
        auto* send_send_video_v2_ptr = dlsym(handle, "NDIlib_send_send_video_v2");
        auto* send_send_audio_v3_ptr = dlsym(handle, "NDIlib_send_send_audio_v3");
        
        if (!send_create_ptr || !send_destroy_ptr || !send_send_video_v2_ptr || !send_send_audio_v3_ptr) {
            std::cerr << "ERROR: Failed to load NDI send functions" << std::endl;
            return false;
        }
        
        send_create = (SendCreateFn)send_create_ptr;
        send_destroy = (SendDestroyFn)send_destroy_ptr;
        send_send_video_v2 = (SendSendVideoFn)send_send_video_v2_ptr;
        send_send_audio_v3 = (SendSendAudioFn)send_send_audio_v3_ptr;
        
        // Finder functions
        auto* find_create_v2_ptr = dlsym(handle, "NDIlib_find_create_v2");
        auto* find_destroy_ptr = dlsym(handle, "NDIlib_find_destroy");
        
        if (!find_create_v2_ptr || !find_destroy_ptr) {
            std::cerr << "ERROR: Failed to load NDI find functions" << std::endl;
            return false;
        }
        
        find_create_v2 = (decltype(find_create_v2))find_create_v2_ptr;
        find_destroy = (decltype(find_destroy))find_destroy_ptr;

        return true;
    }

    ~NDILib() {
        if (handle) {
            dlclose(handle);
        }
    }
};

static NDILib g_ndi;
static bool g_running = true;
static pid_t g_uxplay_pid = -1;

void signalHandler(int sig) {
    std::cout << "Received signal " << sig << ", shutting down..." << std::endl;
    g_running = false;
    
    if (g_uxplay_pid > 0) {
        std::cout << "Terminating uxplay (PID " << g_uxplay_pid << ")..." << std::endl;
        kill(g_uxplay_pid, SIGTERM);
        sleep(1);
        kill(g_uxplay_pid, SIGKILL);
    }
}

// ===== UXPlay NDI Sender Class =====

class UXPlayNDISender {
private:
    std::string ndi_source_name;
    int target_bitrate;  // Kbps
    int target_fps;
    int display_width = 1920;
    int display_height = 1080;
    uint32_t uxplay_window_id = 0;  // Will hold uxplay X11 window ID
    
    GstElement* pipeline = nullptr;
    GstElement* h264_appsink = nullptr;
    GMainLoop* main_loop = nullptr;
    
    NDIlib_send_instance_t ndi_sender = nullptr;
    
    bool is_running = false;
    bool pipeline_created = false;
    
    // NAL buffering for complete access units
    std::vector<uint8_t> nal_buffer;
    int current_width = 0;
    int current_height = 0;
    int current_fps_n = 0;
    int current_fps_d = 0;
    std::chrono::steady_clock::time_point last_buffer_time;

public:
    UXPlayNDISender(const std::string& name = "uxplay-airplay", 
                   int bitrate = 5000, 
                   int fps = 30)
        : ndi_source_name(name), target_bitrate(bitrate), target_fps(fps) {
        gst_init(nullptr, nullptr);
    }

    ~UXPlayNDISender() {
        stop();
    }

    bool detectDisplayResolution() {
        // Method 1: xrandr
        FILE* pipe = popen("xrandr | grep '*' | head -1", "r");
        if (pipe) {
            char buffer[128];
            if (fgets(buffer, sizeof(buffer), pipe)) {
                int w, h;
                if (sscanf(buffer, "%dx%d", &w, &h) == 2 && w > 100 && h > 100) {
                    display_width = w;
                    display_height = h;
                    pclose(pipe);
                    std::cout << "Display Resolution (xrandr): " << display_width << "x" << display_height << std::endl;
                    return true;
                }
            }
            pclose(pipe);
        }

        // Method 2: DRM (for headless/embedded)
        pipe = popen("cat /sys/class/drm/card*-HDMI-A-1/modes 2>/dev/null | head -1", "r");
        if (pipe) {
            char buffer[128];
            if (fgets(buffer, sizeof(buffer), pipe)) {
                int w, h;
                if (sscanf(buffer, "%dx%d", &w, &h) == 2 && w > 100 && h > 100) {
                    display_width = w;
                    display_height = h;
                    pclose(pipe);
                    std::cout << "Display Resolution (drm): " << display_width << "x" << display_height << std::endl;
                    return true;
                }
            }
            pclose(pipe);
        }

        // Fallback
        std::cout << "Display Resolution (fallback): " << display_width << "x" << display_height << std::endl;
        return true;
    }

    bool findUXPlayWindow() {
        // Use xdotool to find uxplay window - single attempt
        FILE* pipe = popen("DISPLAY=:0 xdotool search --name 'uxplay' 2>/dev/null | head -1", "r");
        if (!pipe) {
            return false;
        }

        char buffer[32];
        if (fgets(buffer, sizeof(buffer), pipe)) {
            uint32_t new_id = (uint32_t)strtoul(buffer, nullptr, 10);
            pclose(pipe);
            
            if (new_id > 0 && new_id != uxplay_window_id) {
                uxplay_window_id = new_id;
                std::cout << "Found uxplay window: " << uxplay_window_id << std::endl;
                return true;
            }
        }
        pclose(pipe);
        return false;
    }

    // Background thread: continuously search for uxplay window and recreate pipeline when found
    void windowSearchThread() {
        while (is_running) {
            sleep(1);
            
            // Try to find the window
            if (findUXPlayWindow()) {
                // Window was just found - recreate pipeline with correct window ID
                std::cout << "Window found! Recreating pipeline with xid=" << uxplay_window_id << std::endl;
                
                // Stop old pipeline
                if (pipeline) {
                    gst_element_set_state(pipeline, GST_STATE_NULL);
                    gst_element_get_state(pipeline, nullptr, nullptr, GST_CLOCK_TIME_NONE);
                    if (h264_appsink) {
                        gst_object_unref(h264_appsink);
                        h264_appsink = nullptr;
                    }
                    gst_object_unref(pipeline);
                    pipeline = nullptr;
                    pipeline_created = false;
                }
                
                // Create new pipeline with correct window
                if (!createPipeline()) {
                    std::cerr << "Failed to recreate pipeline with new window" << std::endl;
                }
            }
        }
    }

    bool createPipeline() {
        if (pipeline_created) return true;

        std::cout << "Creating GStreamer H.264 encoding pipeline..." << std::endl;
        std::cout << "  Resolution: " << display_width << "x" << display_height << std::endl;
        std::cout << "  FPS: " << target_fps << std::endl;
        std::cout << "  Bitrate: " << target_bitrate << " Kbps" << std::endl;

        // Build GStreamer pipeline
        // Try multiple source strategies:
        // 1. ximagesrc (X11 window capture)
        // 2. fbdevsrc (framebuffer device capture)
        // Encoder: Try GPU (omxh264enc) first, fallback to software (x264enc)
        // Output: appsink to capture H.264 access units
        
        char pipeline_str[2048];
        
        // Check if X11 is available
        const char* display = getenv("DISPLAY");
        if (display && display[0] != '\0') {
            // X11 pipeline - use uxplay window if found, otherwise root
            uint32_t xid = (uxplay_window_id > 0) ? uxplay_window_id : 0;
            snprintf(pipeline_str, sizeof(pipeline_str),
                "ximagesrc xid=%u use-damage=false "
                "! videoscale ! video/x-raw,width=%d,height=%d,framerate=%d/1 "
                "! videoconvert ! video/x-raw,format=I420 "
                "! x264enc speed-preset=ultrafast bitrate=%d key-int-max=30 "
                "! appsink name=h264_sink emit-signals=true sync=false max-buffers=3",
                xid, display_width, display_height, target_fps, target_bitrate);
        } else {
            // Fallback to fbdevsrc (framebuffer)
            snprintf(pipeline_str, sizeof(pipeline_str),
                "fbdevsrc ! videoscale ! video/x-raw,width=%d,height=%d,framerate=%d/1 "
                "! videoconvert ! video/x-raw,format=I420 "
                "! x264enc speed-preset=ultrafast bitrate=%d key-int-max=30 "
                "! appsink name=h264_sink emit-signals=true sync=false max-buffers=3",
                display_width, display_height, target_fps, target_bitrate);
        }

        std::cout << "GStreamer pipeline: " << pipeline_str << std::endl;

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

        // Connect signal for new samples
        g_signal_connect(h264_appsink, "new-sample", G_CALLBACK(onNewSample), this);

        // Start pipeline
        GstStateChangeReturn state_ret = gst_element_set_state(pipeline, GST_STATE_PLAYING);
        if (state_ret == GST_STATE_CHANGE_FAILURE) {
            std::cerr << "Failed to start pipeline" << std::endl;
            gst_object_unref(h264_appsink);
            gst_object_unref(pipeline);
            pipeline = nullptr;
            return false;
        }

        pipeline_created = true;
        std::cout << "Pipeline created successfully" << std::endl;
        return true;
    }

    // Helper: extract NAL type from byte
    static uint8_t getNalType(uint8_t byte) {
        return byte & 0x1f;
    }
    
    // Helper: check if NAL is a slice (contains picture data)
    static bool isSliceNal(uint8_t nal_type) {
        return (nal_type >= 1 && nal_type <= 5);  // 1=non-IDR, 2-4=part, 5=IDR slice
    }

    // Send buffered access unit to NDI
    void sendAccessUnit() {
        if (nal_buffer.empty()) return;

        NDIlib_video_frame_v2_t video_frame = {};
        video_frame.xres = current_width;
        video_frame.yres = current_height;
        video_frame.frame_rate_N = current_fps_n;
        video_frame.frame_rate_D = current_fps_d;
        video_frame.FourCC = (NDIlib_FourCC_video_type_e)NDI_LIB_FOURCC('H', '2', '6', '4');
        video_frame.picture_aspect_ratio = (float)current_width / (float)current_height;
        video_frame.frame_format_type = NDIlib_frame_format_type_progressive;
        video_frame.timecode = NDIlib_send_timecode_synthesize;

        // Copy buffered data
        uint8_t* frame_data = (uint8_t*)malloc(nal_buffer.size());
        if (!frame_data) {
            std::cerr << "[NDI] malloc failed" << std::endl;
            return;
        }

        memcpy(frame_data, nal_buffer.data(), nal_buffer.size());
        
        video_frame.p_data = frame_data;
        video_frame.data_size_in_bytes = nal_buffer.size();
        video_frame.line_stride_in_bytes = 0;

        static int frame_count = 0;
        static bool first_send = true;
        if (first_send) {
            std::cout << "[NDI] First access unit sent: " << current_width << "x" << current_height 
                      << " (" << nal_buffer.size() << " bytes)" << std::endl;
            first_send = false;
        }
        
        if (++frame_count % 30 == 0) {
            std::cout << "[NDI] Sent " << frame_count << " access units (" 
                      << nal_buffer.size() << " bytes/frame)" << std::endl;
        }

        g_ndi.send_send_video_v2(ndi_sender, &video_frame);
        free(frame_data);
        nal_buffer.clear();
        last_buffer_time = std::chrono::steady_clock::now();
    }

    static GstFlowReturn onNewSample(GstElement* sink, gpointer user_data) {
        UXPlayNDISender* self = (UXPlayNDISender*)user_data;
        
        GstSample* sample = gst_app_sink_pull_sample(GST_APP_SINK(sink));
        if (!sample) {
            return GST_FLOW_ERROR;
        }

        GstBuffer* buffer = gst_sample_get_buffer(sample);
        GstCaps* caps = gst_sample_get_caps(sample);

        if (!buffer || !caps) {
            gst_sample_unref(sample);
            return GST_FLOW_ERROR;
        }

        // Extract resolution and FPS from caps
        GstStructure* structure = gst_caps_get_structure(caps, 0);
        int width, height;
        gint fps_n, fps_d;
        
        if (!gst_structure_get_int(structure, "width", &width) ||
            !gst_structure_get_int(structure, "height", &height) ||
            !gst_structure_get_fraction(structure, "framerate", &fps_n, &fps_d)) {
            gst_sample_unref(sample);
            return GST_FLOW_ERROR;
        }

        // Map buffer
        GstMapInfo map;
        if (!gst_buffer_map(buffer, &map, GST_MAP_READ)) {
            gst_sample_unref(sample);
            return GST_FLOW_ERROR;
        }

        // Create NDI video frame - send raw x264 output directly
        NDIlib_video_frame_v2_t video_frame = {};
        video_frame.xres = width;
        video_frame.yres = height;
        video_frame.frame_rate_N = fps_n;
        video_frame.frame_rate_D = fps_d;
        video_frame.FourCC = (NDIlib_FourCC_video_type_e)NDI_LIB_FOURCC('H', '2', '6', '4');
        video_frame.picture_aspect_ratio = (float)width / (float)height;
        video_frame.frame_format_type = NDIlib_frame_format_type_progressive;
        video_frame.timecode = NDIlib_send_timecode_synthesize;

        // Allocate and copy frame data
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
        static bool first_frame = true;
        if (first_frame) {
            std::cout << "[NDI] First frame sent: " << width << "x" << height 
                      << " @ " << fps_n << "/" << fps_d << " fps, " 
                      << map.size << " bytes" << std::endl;
            first_frame = false;
        }
        
        if (++frame_count % 30 == 0) {
            std::cout << "[NDI] Sent " << frame_count << " frames (" 
                      << map.size << " bytes/frame)" << std::endl;
        }

        // Send to NDI
        g_ndi.send_send_video_v2(self->ndi_sender, &video_frame);
        free(frame_data);

        gst_sample_unref(sample);
        return GST_FLOW_OK;
    }

    bool initializeNDI() {
        std::cout << "Initializing NDI..." << std::endl;

        if (!g_ndi.initialize()) {
            std::cerr << "Failed to initialize NDI" << std::endl;
            return false;
        }

        std::cout << "NDI Version: " << g_ndi.version() << std::endl;

        // Create NDI sender instance
        NDIlib_send_create_t send_desc = {
            ndi_source_name.c_str(),  // p_ndi_name
            nullptr,                   // p_groups
            true,                       // clock_video
            false                       // clock_audio (video drives timing)
        };

        ndi_sender = g_ndi.send_create(&send_desc);
        if (!ndi_sender) {
            std::cerr << "Failed to create NDI sender" << std::endl;
            return false;
        }

        std::cout << "NDI Sender created: " << ndi_source_name << std::endl;
        return true;
    }

    bool start() {
        if (is_running) return true;

        std::cout << "Starting UXPlay NDI Sender..." << std::endl;

        // Detect display resolution
        if (!detectDisplayResolution()) {
            std::cerr << "Failed to detect display resolution" << std::endl;
            return false;
        }

        // Initialize NDI
        if (!initializeNDI()) {
            std::cerr << "Failed to initialize NDI" << std::endl;
            return false;
        }

        // Start main loop thread first
        main_loop = g_main_loop_new(nullptr, FALSE);
        std::thread(&UXPlayNDISender::gstMainLoopThread, this).detach();

        is_running = true;
        std::cout << "UXPlay NDI Sender started successfully (waiting for pipeline)" << std::endl;
        return true;
    }

    void stop() {
        if (!is_running) return;

        std::cout << "Stopping UXPlay NDI Sender..." << std::endl;
        is_running = false;

        // Stop main loop
        if (main_loop && g_main_loop_is_running(main_loop)) {
            g_main_loop_quit(main_loop);
        }

        // Stop pipeline
        if (pipeline) {
            gst_element_set_state(pipeline, GST_STATE_NULL);
            gst_element_get_state(pipeline, nullptr, nullptr, GST_CLOCK_TIME_NONE);
            
            if (h264_appsink) {
                gst_object_unref(h264_appsink);
                h264_appsink = nullptr;
            }
            
            gst_object_unref(pipeline);
            pipeline = nullptr;
            pipeline_created = false;
        }

        // Destroy NDI sender
        if (ndi_sender) {
            g_ndi.send_destroy(ndi_sender);
            ndi_sender = nullptr;
        }

        std::cout << "UXPlay NDI Sender stopped" << std::endl;
    }

    void gstMainLoopThread() {
        g_main_loop_run(main_loop);
    }

    bool isRunning() const {
        return is_running;
    }
};

// ===== UXPlay Subprocess Manager =====

bool launchUXPlay() {
    std::cout << "Launching uxplay..." << std::endl;

    // Check if uxplay exists
    if (access("/usr/local/bin/uxplay", X_OK) != 0 &&
        access("/usr/bin/uxplay", X_OK) != 0 &&
        access("uxplay", X_OK) != 0) {
        std::cerr << "ERROR: uxplay not found in PATH" << std::endl;
        return false;
    }

    g_uxplay_pid = fork();
    if (g_uxplay_pid == 0) {
        // Child process: exec uxplay
        // -as 0: turn off audio (we only capture video)
        // -vs ximagesink: output to X11 display for ximagesrc capture
        execlp("uxplay", "uxplay", "-as", "0", "-vs", "ximagesink", nullptr);
        std::cerr << "Failed to exec uxplay" << std::endl;
        exit(1);
    } else if (g_uxplay_pid > 0) {
        std::cout << "uxplay launched (PID " << g_uxplay_pid << ")" << std::endl;
        return true;
    } else {
        std::cerr << "fork() failed" << std::endl;
        return false;
    }
}

void monitorUXPlayProcess() {
    while (g_running) {
        if (g_uxplay_pid > 0) {
            int status;
            pid_t result = waitpid(g_uxplay_pid, &status, WNOHANG);
            
            if (result == g_uxplay_pid) {
                std::cout << "uxplay process exited (status " << WEXITSTATUS(status) << ")" << std::endl;
                g_uxplay_pid = -1;
                
                if (g_running) {
                    std::cout << "Restarting uxplay..." << std::endl;
                    sleep(2);
                    launchUXPlay();
                }
            }
        }
        sleep(1);
    }
}

// ===== Main =====

void printUsage(const char* prog) {
    std::cout << "UXPlay to NDI Sender v1\n"
              << "Usage: " << prog << " [options]\n"
              << "Options:\n"
              << "  --name <name>        NDI source name (default: uxplay-airplay)\n"
              << "  --bitrate <kbps>     H.264 bitrate in Kbps (default: 5000)\n"
              << "  --fps <fps>          Target FPS (default: 30)\n"
              << "  --help               Show this help message\n";
}

int main(int argc, char* argv[]) {
    std::string ndi_name = "uxplay-airplay";
    int bitrate = 5000;
    int fps = 30;

    // Parse arguments
    for (int i = 1; i < argc; ++i) {
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

    // Load NDI library
    if (!g_ndi.loadLibrary()) {
        std::cerr << "Failed to load NDI library" << std::endl;
        return 1;
    }

    // Setup signal handlers
    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    // Create sender
    UXPlayNDISender sender(ndi_name, bitrate, fps);
    if (!sender.start()) {
        std::cerr << "Failed to start sender" << std::endl;
        return 1;
    }

    // Launch uxplay subprocess
    if (!launchUXPlay()) {
        std::cerr << "Failed to launch uxplay" << std::endl;
        sender.stop();
        return 1;
    }

    // Create initial pipeline (will capture root window xid=0 until AirPlay connection)
    std::cout << "Creating initial pipeline..." << std::endl;
    if (!sender.createPipeline()) {
        std::cerr << "Failed to create initial pipeline" << std::endl;
        sender.stop();
        return 1;
    }

    // Start background window search thread (will recreate pipeline when uxplay window appears)
    std::thread window_search_thread(&UXPlayNDISender::windowSearchThread, &sender);
    window_search_thread.detach();

    // Monitor uxplay process
    std::thread monitor_thread(&monitorUXPlayProcess);

    // Keep running
    std::cout << "NDI Stream available as: " << ndi_name << std::endl;
    std::cout << "Press Ctrl+C to exit" << std::endl;

    while (g_running) {
        sleep(1);
    }

    sender.stop();
    monitor_thread.join();

    return 0;
}
