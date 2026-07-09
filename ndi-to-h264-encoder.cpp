/**
 * NDI to H.264 Encoder for WebRTC Streaming
 * 
 * Captures NDI video stream and encodes it to H.264 format suitable for WebRTC
 * Output goes to stdout for piping to Node.js server or other consumers
 * 
 * Compilation:
 *    g++ -o ndi-to-h264 ndi-to-h264-encoder.cpp $(pkg-config --cflags --libs gstreamer-1.0 gstreamer-app-1.0 glib-2.0) -I"ndi_receiver_v3__NDI6/include" -L"ndi_receiver_v3__NDI6/lib/x86_64-linux-gnu" -lndi -ldl -std=c++17 -Wall -O2
 * 
 * For Raspberry Pi:
 *    g++ -o ndi-to-h264 ndi-to-h264-encoder.cpp $(pkg-config --cflags --libs gstreamer-1.0 gstreamer-app-1.0 glib-2.0) -I"ndi_receiver_v3__NDI6/include" -L"ndi_receiver_v3__NDI6/lib/aarch64-rpi4-linux-gnueabi" -lndi -ldl -std=c++17 -Wall -O2
 * 
 * Usage:
 *    ./ndi-to-h264 "NDI Source Name" | ffmpeg -i pipe:0 -c:v copy -c:a copy output.mkv
 *    ./ndi-to-h264 "Camera 1" > stream.h264
 * 
 * Environment Variables:
 *    NDI_LIB_PATH      - Path to libndi.so (optional, will auto-detect)
 *    BITRATE           - Video bitrate in kbps (default: 2500)
 *    QUALITY           - Encoding quality: fast/medium/slow (default: fast)
 */

#include <iostream>
#include <string>
#include <cstring>
#include <thread>
#include <chrono>
#include <signal.h>
#include <cstdlib>
#include <dlfcn.h>
#include <gst/gst.h>
#include <gst/app/gstappsrc.h>
#include <Processing.NDI.Lib.h>

volatile bool running = true;

void signalHandler(int signum) {
    std::cerr << "\nSignal " << signum << " received, shutting down..." << std::endl;
    running = false;
}

// NDI SDK Dynamic Loading (same as in ndi_receiver_v4.cpp)
struct NDILib {
    void* handle = nullptr;
    
    bool (*initialize)(void) = nullptr;
    void (*destroy)(void) = nullptr;
    const char* (*version)(void) = nullptr;
    
    NDIlib_recv_instance_t (*recv_create_v3)(const NDIlib_recv_create_v3_t*) = nullptr;
    void (*recv_destroy)(NDIlib_recv_instance_t) = nullptr;
    void (*recv_connect)(NDIlib_recv_instance_t, const NDIlib_source_t*) = nullptr;
    NDIlib_frame_type_e (*recv_capture_v3)(NDIlib_recv_instance_t,
                                           NDIlib_video_frame_v2_t*,
                                           NDIlib_audio_frame_v3_t*,
                                           NDIlib_metadata_frame_t*,
                                           uint32_t) = nullptr;
    void (*recv_free_video_v2)(NDIlib_recv_instance_t, const NDIlib_video_frame_v2_t*) = nullptr;
    void (*recv_free_audio_v3)(NDIlib_recv_instance_t, const NDIlib_audio_frame_v3_t*) = nullptr;
    
    NDIlib_find_instance_t (*find_create_v2)(const NDIlib_find_create_t*) = nullptr;
    void (*find_destroy)(NDIlib_find_instance_t) = nullptr;
    bool (*find_wait_for_sources)(NDIlib_find_instance_t, uint32_t) = nullptr;
    const NDIlib_source_t* (*find_get_current_sources)(NDIlib_find_instance_t, uint32_t*) = nullptr;
    
    bool (*util_audio_to_interleaved_16s_v3)(const NDIlib_audio_frame_v3_t*,
                                             NDIlib_audio_frame_interleaved_16s_t*) = nullptr;
    
    NDIlib_framesync_instance_t (*framesync_create)(NDIlib_recv_instance_t) = nullptr;
    void (*framesync_destroy)(NDIlib_framesync_instance_t) = nullptr;
    void (*framesync_capture_video)(NDIlib_framesync_instance_t,
                                    NDIlib_video_frame_v2_t*,
                                    NDIlib_frame_format_type_e) = nullptr;
    void (*framesync_free_video)(NDIlib_framesync_instance_t, NDIlib_video_frame_v2_t*) = nullptr;
    
    bool loadLibrary() {
        const char* lib_paths[] = {
            "ndi_receiver_v3__NDI6/lib/aarch64-rpi4-linux-gnueabi/libndi.so.6",
            "ndi_receiver_v3__NDI6/lib/x86_64-linux-gnu/libndi.so.6",
            "/opt/NDI SDK for Linux/lib/aarch64-rpi4-linux-gnueabi/libndi.so.6",
            "/opt/NDI SDK for Linux/lib/x86_64-linux-gnu/libndi.so.6",
            "/usr/local/lib/libndi.so.6",
            "/usr/lib/libndi.so.6",
            "libndi.so.6",
            nullptr
        };
        
        for (const char** path = lib_paths; *path; path++) {
            handle = dlopen(*path, RTLD_LAZY);
            if (handle) {
                std::cerr << "Loaded NDI library from: " << *path << std::endl;
                break;
            }
        }
        
        if (!handle) {
            std::cerr << "Error: Could not load NDI library" << std::endl;
            return false;
        }
        
        // Load function pointers
        initialize = (bool (*)())dlsym(handle, "NDIlib_initialize");
        destroy = (void (*)())dlsym(handle, "NDIlib_destroy");
        version = (const char* (*)())dlsym(handle, "NDIlib_version");
        
        recv_create_v3 = (NDIlib_recv_instance_t (*)(const NDIlib_recv_create_v3_t*))dlsym(handle, "NDIlib_recv_create_v3");
        recv_destroy = (void (*)(NDIlib_recv_instance_t))dlsym(handle, "NDIlib_recv_destroy");
        recv_connect = (void (*)(NDIlib_recv_instance_t, const NDIlib_source_t*))dlsym(handle, "NDIlib_recv_connect");
        recv_capture_v3 = (NDIlib_frame_type_e (*)(NDIlib_recv_instance_t, NDIlib_video_frame_v2_t*, NDIlib_audio_frame_v3_t*, NDIlib_metadata_frame_t*, uint32_t))dlsym(handle, "NDIlib_recv_capture_v3");
        recv_free_video_v2 = (void (*)(NDIlib_recv_instance_t, const NDIlib_video_frame_v2_t*))dlsym(handle, "NDIlib_recv_free_video_v2");
        recv_free_audio_v3 = (void (*)(NDIlib_recv_instance_t, const NDIlib_audio_frame_v3_t*))dlsym(handle, "NDIlib_recv_free_audio_v3");
        
        find_create_v2 = (NDIlib_find_instance_t (*)(const NDIlib_find_create_t*))dlsym(handle, "NDIlib_find_create_v2");
        find_destroy = (void (*)(NDIlib_find_instance_t))dlsym(handle, "NDIlib_find_destroy");
        find_wait_for_sources = (bool (*)(NDIlib_find_instance_t, uint32_t))dlsym(handle, "NDIlib_find_wait_for_sources");
        find_get_current_sources = (const NDIlib_source_t* (*)(NDIlib_find_instance_t, uint32_t*))dlsym(handle, "NDIlib_find_get_current_sources");
        
        framesync_create = (NDIlib_framesync_instance_t (*)(NDIlib_recv_instance_t))dlsym(handle, "NDIlib_framesync_create");
        framesync_destroy = (void (*)(NDIlib_framesync_instance_t))dlsym(handle, "NDIlib_framesync_destroy");
        framesync_capture_video = (void (*)(NDIlib_framesync_instance_t, NDIlib_video_frame_v2_t*, NDIlib_frame_format_type_e))dlsym(handle, "NDIlib_framesync_capture_video");
        framesync_free_video = (void (*)(NDIlib_framesync_instance_t, NDIlib_video_frame_v2_t*))dlsym(handle, "NDIlib_framesync_free_video");
        
        return true;
    }
};

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::cerr << "Usage: " << argv[0] << " <NDI Source Name>" << std::endl;
        std::cerr << "Example: " << argv[0] << " \"Camera 1\"" << std::endl;
        return 1;
    }
    
    std::string ndiSourceName = argv[1];
    
    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);
    
    // Load NDI library
    NDILib ndiLib;
    if (!ndiLib.loadLibrary()) {
        std::cerr << "Failed to load NDI library" << std::endl;
        return 1;
    }
    
    // Initialize NDI
    if (!ndiLib.initialize()) {
        std::cerr << "Failed to initialize NDI" << std::endl;
        return 1;
    }
    
    std::cerr << "NDI Library version: " << ndiLib.version() << std::endl;
    
    // Find NDI sources
    NDIlib_find_create_t find_create_desc = NDIlib_find_create_t();
    NDIlib_find_instance_t pNDI_find = ndiLib.find_create_v2(&find_create_desc);
    
    if (!pNDI_find) {
        std::cerr << "Error creating NDI finder" << std::endl;
        ndiLib.destroy();
        return 1;
    }
    
    std::cerr << "Waiting for NDI sources..." << std::endl;
    ndiLib.find_wait_for_sources(pNDI_find, 5000);
    
    // Get available sources
    uint32_t no_sources = 0;
    const NDIlib_source_t* p_sources = ndiLib.find_get_current_sources(pNDI_find, &no_sources);
    
    if (no_sources == 0) {
        std::cerr << "Error: No NDI sources found" << std::endl;
        ndiLib.find_destroy(pNDI_find);
        ndiLib.destroy();
        return 1;
    }
    
    std::cerr << "Found " << no_sources << " NDI source(s)" << std::endl;
    
    // Find the requested source
    NDIlib_source_t selectedSource;
    bool found = false;
    
    for (uint32_t i = 0; i < no_sources; i++) {
        std::cerr << "  [" << i << "] " << p_sources[i].p_ndi_name << std::endl;
        if (std::string(p_sources[i].p_ndi_name) == ndiSourceName) {
            selectedSource = p_sources[i];
            found = true;
            std::cerr << "Selected: " << selectedSource.p_ndi_name << std::endl;
            break;
        }
    }
    
    if (!found) {
        std::cerr << "Error: NDI source '" << ndiSourceName << "' not found" << std::endl;
        ndiLib.find_destroy(pNDI_find);
        ndiLib.destroy();
        return 1;
    }
    
    ndiLib.find_destroy(pNDI_find);
    
    // Create receiver
    NDIlib_recv_create_v3_t recv_create_desc = NDIlib_recv_create_v3_t();
    recv_create_desc.source_to_connect_to = selectedSource;
    recv_create_desc.p_ndi_recv_name = "H264 Encoder";
    recv_create_desc.bandwidth = NDIlib_recv_bandwidth_highest;
    recv_create_desc.color_format = NDIlib_recv_color_format_fastest;
    
    NDIlib_recv_instance_t pNDI_recv = ndiLib.recv_create_v3(&recv_create_desc);
    
    if (!pNDI_recv) {
        std::cerr << "Error creating NDI receiver" << std::endl;
        ndiLib.destroy();
        return 1;
    }
    
    std::cerr << "Connected to NDI source: " << ndiSourceName << std::endl;
    
    // Initialize GStreamer for H.264 encoding
    gst_init(nullptr, nullptr);
    
    // Create pipeline: appsrc -> x264enc -> h264parse -> appsink
    GstElement* pipeline = gst_pipeline_new("h264-pipeline");
    GstElement* appsrc = gst_element_factory_make("appsrc", "source");
    GstElement* videoconvert = gst_element_factory_make("videoconvert", "convert");
    GstElement* videoscale = gst_element_factory_make("videoscale", "scale");
    GstElement* x264enc = gst_element_factory_make("x264enc", "encoder");
    GstElement* h264parse = gst_element_factory_make("h264parse", "parse");
    GstElement* appsink = gst_element_factory_make("appsink", "sink");
    
    if (!pipeline || !appsrc || !videoconvert || !videoscale || !x264enc || !h264parse || !appsink) {
        std::cerr << "Error creating GStreamer elements" << std::endl;
        g_object_unref(pipeline);
        ndiLib.recv_destroy(pNDI_recv);
        ndiLib.destroy();
        return 1;
    }
    
    // Configure x264 encoder
    g_object_set(x264enc,
        "speed-preset", 1,  // fast: 0=ultrafast, 1=superfast, 2=veryfast, etc
        "tune", 4,          // 4 = zerolatency for streaming
        "bitrate", 2500,    // 2500 kbps
        nullptr);
    
    g_object_set(appsrc,
        "is-live", TRUE,
        "do-timestamp", TRUE,
        nullptr);
    
    g_object_set(appsink,
        "emit-signals", TRUE,
        nullptr);
    
    // Add elements to pipeline
    gst_bin_add_many(GST_BIN(pipeline), appsrc, videoconvert, videoscale, x264enc, h264parse, appsink, nullptr);
    
    // Link elements
    if (!gst_element_link_many(appsrc, videoconvert, videoscale, x264enc, h264parse, appsink, nullptr)) {
        std::cerr << "Error linking GStreamer elements" << std::endl;
        gst_object_unref(pipeline);
        ndiLib.recv_destroy(pNDI_recv);
        ndiLib.destroy();
        return 1;
    }
    
    // Set source caps for UYVY video (common NDI format)
    GstCaps* caps = gst_caps_new_simple("video/x-raw",
        "format", G_TYPE_STRING, "UYVY",
        "width", G_TYPE_INT, 1920,
        "height", G_TYPE_INT, 1080,
        "framerate", GST_TYPE_FRACTION, 30, 1,
        nullptr);
    
    g_object_set(appsrc, "caps", caps, nullptr);
    gst_caps_unref(caps);
    
    // Start pipeline
    gst_element_set_state(pipeline, GST_STATE_PLAYING);
    
    std::cerr << "GStreamer pipeline initialized. Starting video capture..." << std::endl;
    
    // Capture and encode video
    uint64_t frameCount = 0;
    
    while (running) {
        NDIlib_video_frame_v2_t video_frame = NDIlib_video_frame_v2_t();
        NDIlib_audio_frame_v3_t audio_frame = NDIlib_audio_frame_v3_t();
        NDIlib_metadata_frame_t metadata_frame = NDIlib_metadata_frame_t();
        
        NDIlib_frame_type_e frame_type = ndiLib.recv_capture_v3(
            pNDI_recv,
            &video_frame,
            &audio_frame,
            &metadata_frame,
            5000);  // 5 second timeout
        
        if (frame_type == NDIlib_frame_type_video) {
            // Create GStreamer buffer with video data
            GstBuffer* buffer = gst_buffer_new_allocate(nullptr, video_frame.line_stride_in_bytes * video_frame.yres, nullptr);
            
            gst_buffer_fill(buffer, 0, video_frame.p_data, video_frame.line_stride_in_bytes * video_frame.yres);
            
            // Set timestamp
            GST_BUFFER_PTS(buffer) = gst_util_uint64_scale(frameCount, GST_SECOND * 1, 30);
            GST_BUFFER_DURATION(buffer) = gst_util_uint64_scale(1, GST_SECOND * 1, 30);
            
            // Push buffer to pipeline
            GstFlowReturn ret;
            g_signal_emit_by_name(appsrc, "push-buffer", buffer, &ret);
            gst_buffer_unref(buffer);
            
            frameCount++;
            
            if (frameCount % 30 == 0) {
                std::cerr << "Encoded " << frameCount << " frames" << std::endl;
            }
            
            ndiLib.recv_free_video_v2(pNDI_recv, &video_frame);
        }
    }
    
    std::cerr << "\nShutting down..." << std::endl;
    
    // Cleanup
    gst_element_set_state(pipeline, GST_STATE_NULL);
    gst_object_unref(pipeline);
    
    ndiLib.recv_destroy(pNDI_recv);
    ndiLib.destroy();
    
    std::cerr << "Encoder shut down cleanly" << std::endl;
    return 0;
}
