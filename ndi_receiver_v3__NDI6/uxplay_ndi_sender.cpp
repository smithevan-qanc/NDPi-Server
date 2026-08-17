/**
 * AirPlay (uxplay) to NDI Bridge v2
 *
 * Captures a dedicated X11 display (intended to be a headless Xvfb display
 * that `uxplay` renders to, fullscreen, kept separate from any real/kiosk
 * display on the same machine) and its PulseAudio monitor, and re-broadcasts
 * both as a single discoverable NDI source.
 *
 * This is a display+audio-device capture bridge only. It does NOT launch or
 * manage uxplay itself -- uxplay, the Xvfb display it renders to, and this
 * bridge are three independent, independently-restarting systemd services.
 * That keeps a crash/restart of any one of them from taking the others down,
 * and means this program keeps broadcasting (a black frame) even between
 * AirPlay sessions.
 *
 * v1 of this tool tried to hand GStreamer's x264-encoded H.264 bytes
 * straight to NDI with a FourCC of 'H264'. That FourCC does not exist in the
 * NDI SDK (NDIlib_FourCC_video_type_e only lists uncompressed pixel
 * formats -- NDI does its own compression internally) -- so every frame
 * v1 ever sent was structurally invalid and could never have displayed
 * correctly on any receiver. v2 sends raw UYVY video and planar float32
 * ("FLTP") audio instead, which are real, documented NDI formats.
 *
 * Compilation (Raspberry Pi / Linux):
 *    g++ -o uxplay_ndi_sender uxplay_ndi_sender.cpp \
 *        $(pkg-config --cflags --libs gstreamer-1.0 gstreamer-app-1.0) \
 *        -I"include" -ldl -pthread -std=c++11
 *
 * Usage:
 *    ./uxplay_ndi_sender [--name "uxplay-airplay"] [--display :1]
 *                        [--width 1920] [--height 1080] [--fps 30]
 *                        [--audio-device uxplay_ndi_audio.monitor] [--no-audio]
 *
 * Dependencies:
 *    - GStreamer 1.0 + gstreamer1.0-plugins-good (ximagesrc) +
 *      gstreamer1.0-pulseaudio (pulsesrc), unless run with --no-audio
 *    - NDI SDK v6: lib/<arch>/libndi.so.6 (bundled in this repo) or system-installed
 *    - An X11 display to capture (see uxplay-xvfb.service) and, for audio,
 *      a PulseAudio/PipeWire-pulse null-sink named to match --audio-device
 *      (see uxplay-audio-setup.sh)
 */

#include <iostream>
#include <string>
#include <cstring>
#include <thread>
#include <chrono>
#include <signal.h>
#include <cstdlib>
#include <dlfcn.h>
#include <unistd.h>
#include <gst/gst.h>
#include <gst/app/gstappsink.h>
#include <Processing.NDI.Lib.h>

// ===== NDI SDK v6 Dynamic Loading =====
// (Same dlopen/dlsym-by-name pattern as ndi_receiver_v4.cpp in this
// directory, extended with the Send-side functions this tool needs.)

struct NDILib {
    void* handle = nullptr;

    bool (*initialize)(void) = nullptr;
    void (*destroy)(void) = nullptr;
    const char* (*version)(void) = nullptr;

    NDIlib_send_instance_t (*send_create)(const NDIlib_send_create_t* p_create_settings) = nullptr;
    void (*send_destroy)(NDIlib_send_instance_t p_instance) = nullptr;
    void (*send_send_video_v2)(NDIlib_send_instance_t p_instance, const NDIlib_video_frame_v2_t* p_video_data) = nullptr;
    void (*send_send_audio_v3)(NDIlib_send_instance_t p_instance, const NDIlib_audio_frame_v3_t* p_audio_data) = nullptr;

    bool loadLibrary() {
        const char* lib_paths[] = {
            "lib/aarch64-rpi4-linux-gnueabi/libndi.so.6",
            "lib/arm-rpi4-linux-gnueabihf/libndi.so.6",
            "/opt/NDI SDK for Linux/lib/aarch64-rpi4-linux-gnueabi/libndi.so.6",
            "/usr/local/lib/libndi.so.6",
            "/usr/lib/libndi.so.6",
            "libndi.so.6",
            nullptr
        };

        for (int i = 0; lib_paths[i] != nullptr; i++) {
            handle = dlopen(lib_paths[i], RTLD_LAZY | RTLD_LOCAL);
            if (handle) {
                std::cout << "[NDI] Library loaded: " << lib_paths[i] << std::endl;
                break;
            }
        }

        if (!handle) {
            std::cerr << "[NDI] ERROR: Failed to load NDI library: " << dlerror() << std::endl;
            return false;
        }

        #define LOAD_FUNC(name) \
            name = reinterpret_cast<decltype(name)>(dlsym(handle, "NDIlib_" #name)); \
            if (!name) { \
                std::cerr << "[NDI] ERROR: Failed to load NDIlib_" #name << ": " << dlerror() << std::endl; \
                dlclose(handle); \
                handle = nullptr; \
                return false; \
            }

        LOAD_FUNC(initialize);
        LOAD_FUNC(destroy);
        LOAD_FUNC(version);
        LOAD_FUNC(send_create);
        LOAD_FUNC(send_destroy);
        LOAD_FUNC(send_send_video_v2);
        LOAD_FUNC(send_send_audio_v3);

        #undef LOAD_FUNC

        return true;
    }

    ~NDILib() {
        if (handle) dlclose(handle);
    }
};

static NDILib g_ndi;
static volatile bool g_running = true;

void signalHandler(int sig) {
    std::cout << "Received signal " << sig << ", shutting down..." << std::endl;
    g_running = false;
}

// ===== AirPlay/X11 + PulseAudio -> NDI bridge =====

class AirPlayNDIBridge {
private:
    std::string ndi_source_name;
    std::string x_display;
    std::string audio_device;
    int capture_width;
    int capture_height;
    int target_fps;
    bool audio_enabled;

    GstElement* pipeline = nullptr;
    GstElement* video_appsink = nullptr;
    GstElement* audio_appsink = nullptr;
    GstBus* bus = nullptr;

    NDIlib_send_instance_t ndi_sender = nullptr;

public:
    AirPlayNDIBridge(const std::string& name, const std::string& display,
                      int width, int height, int fps,
                      bool with_audio, const std::string& audio_dev)
        : ndi_source_name(name), x_display(display), audio_device(audio_dev),
          capture_width(width), capture_height(height), target_fps(fps),
          audio_enabled(with_audio) {
        gst_init(nullptr, nullptr);
    }

    ~AirPlayNDIBridge() {
        stop();
    }

    bool initializeNDI() {
        std::cout << "[NDI] Initializing..." << std::endl;

        if (!g_ndi.initialize()) {
            std::cerr << "[NDI] ERROR: initialize() failed" << std::endl;
            return false;
        }

        std::cout << "[NDI] Version: " << g_ndi.version() << std::endl;

        NDIlib_send_create_t send_desc = {};
        send_desc.p_ndi_name = ndi_source_name.c_str();
        send_desc.p_groups = nullptr;
        // Video and audio are pushed from two separate GStreamer streaming
        // threads (one per appsink) -- clocking both lets the SDK pace each
        // stream independently instead of one starving the other.
        send_desc.clock_video = true;
        send_desc.clock_audio = true;

        ndi_sender = g_ndi.send_create(&send_desc);
        if (!ndi_sender) {
            std::cerr << "[NDI] ERROR: send_create() failed" << std::endl;
            return false;
        }

        std::cout << "[NDI] Sender created: " << ndi_source_name << std::endl;
        return true;
    }

    std::string buildPipelineString(bool with_audio) const {
        char video_part[512];
        snprintf(video_part, sizeof(video_part),
            "ximagesrc display-name=%s use-damage=false "
            "! video/x-raw,framerate=%d/1 "
            "! videoscale ! videoconvert "
            "! video/x-raw,format=UYVY,width=%d,height=%d "
            "! appsink name=video_sink emit-signals=true sync=false max-buffers=2 drop=true",
            x_display.c_str(), target_fps, capture_width, capture_height);

        std::string pipeline_str = video_part;

        if (with_audio) {
            char audio_part[512];
            snprintf(audio_part, sizeof(audio_part),
                " pulsesrc device=%s "
                "! audioconvert ! audioresample "
                "! audio/x-raw,format=F32LE,layout=non-interleaved,rate=48000,channels=2 "
                "! appsink name=audio_sink emit-signals=true sync=false max-buffers=8 drop=true",
                audio_device.c_str());
            pipeline_str += audio_part;
        }

        return pipeline_str;
    }

    // Attempts to build+start the pipeline. If audio is requested but the
    // pulseaudio plugin/device isn't available, falls back to video-only
    // rather than failing outright -- a broken audio setup shouldn't take
    // down the video monitoring feed.
    bool createPipeline() {
        bool try_audio = audio_enabled;

        for (int attempt = 0; attempt < 2; ++attempt) {
            std::string pipeline_str = buildPipelineString(try_audio);
            std::cout << "[GST] Pipeline: " << pipeline_str << std::endl;

            GError* error = nullptr;
            pipeline = gst_parse_launch(pipeline_str.c_str(), &error);

            if (error) {
                std::string msg = error->message;
                std::cerr << "[GST] ERROR: " << msg << std::endl;
                g_error_free(error);
                if (pipeline) { gst_object_unref(pipeline); pipeline = nullptr; }

                if (try_audio && attempt == 0) {
                    std::cerr << "[GST] Retrying without audio (pulseaudio plugin/device unavailable?)" << std::endl;
                    try_audio = false;
                    continue;
                }
                return false;
            }

            if (!pipeline) {
                std::cerr << "[GST] ERROR: pipeline creation returned NULL" << std::endl;
                if (try_audio && attempt == 0) { try_audio = false; continue; }
                return false;
            }

            video_appsink = gst_bin_get_by_name(GST_BIN(pipeline), "video_sink");
            if (!video_appsink) {
                std::cerr << "[GST] ERROR: could not find video_sink element" << std::endl;
                gst_object_unref(pipeline);
                pipeline = nullptr;
                return false;
            }
            g_signal_connect(video_appsink, "new-sample", G_CALLBACK(onNewVideoSample), this);

            if (try_audio) {
                audio_appsink = gst_bin_get_by_name(GST_BIN(pipeline), "audio_sink");
                if (audio_appsink) {
                    g_signal_connect(audio_appsink, "new-sample", G_CALLBACK(onNewAudioSample), this);
                } else {
                    std::cerr << "[GST] WARNING: audio_sink not found, continuing video-only" << std::endl;
                }
            }

            bus = gst_pipeline_get_bus(GST_PIPELINE(pipeline));

            GstStateChangeReturn state_ret = gst_element_set_state(pipeline, GST_STATE_PLAYING);
            if (state_ret == GST_STATE_CHANGE_FAILURE) {
                std::cerr << "[GST] ERROR: failed to start pipeline" << std::endl;
                teardownPipeline();
                if (try_audio && attempt == 0) { try_audio = false; continue; }
                return false;
            }

            std::cout << "[GST] Pipeline started (audio " << (try_audio ? "enabled" : "disabled") << ")" << std::endl;
            return true;
        }

        return false;
    }

    void teardownPipeline() {
        if (bus) { gst_object_unref(bus); bus = nullptr; }
        if (pipeline) {
            gst_element_set_state(pipeline, GST_STATE_NULL);
            gst_element_get_state(pipeline, nullptr, nullptr, GST_CLOCK_TIME_NONE);
        }
        if (video_appsink) { gst_object_unref(video_appsink); video_appsink = nullptr; }
        if (audio_appsink) { gst_object_unref(audio_appsink); audio_appsink = nullptr; }
        if (pipeline) { gst_object_unref(pipeline); pipeline = nullptr; }
    }

    static GstFlowReturn onNewVideoSample(GstElement* sink, gpointer user_data) {
        AirPlayNDIBridge* self = (AirPlayNDIBridge*)user_data;

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
        video_frame.FourCC = NDIlib_FourCC_video_type_UYVY;
        video_frame.picture_aspect_ratio = (float)width / (float)height;
        video_frame.frame_format_type = NDIlib_frame_format_type_progressive;
        video_frame.timecode = NDIlib_send_timecode_synthesize;
        video_frame.line_stride_in_bytes = width * 2; // UYVY = 2 bytes/pixel

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

        static bool first_frame = true;
        static int frame_count = 0;
        if (first_frame) {
            std::cout << "[NDI] First video frame: " << width << "x" << height
                      << " @ " << fps_n << "/" << fps_d << " fps (UYVY, " << map.size << " bytes)" << std::endl;
            first_frame = false;
        }
        if (++frame_count % 150 == 0) {
            std::cout << "[NDI] Sent " << frame_count << " video frames" << std::endl;
        }

        // send_send_video_v2 (not the _async_v2 variant) is synchronous: it
        // is safe to free p_data as soon as this call returns.
        g_ndi.send_send_video_v2(self->ndi_sender, &video_frame);
        free(frame_data);

        gst_sample_unref(sample);
        return GST_FLOW_OK;
    }

    static GstFlowReturn onNewAudioSample(GstElement* sink, gpointer user_data) {
        AirPlayNDIBridge* self = (AirPlayNDIBridge*)user_data;

        GstSample* sample = gst_app_sink_pull_sample(GST_APP_SINK(sink));
        if (!sample) return GST_FLOW_ERROR;

        GstBuffer* buffer = gst_sample_get_buffer(sample);
        GstCaps* caps = gst_sample_get_caps(sample);
        if (!buffer || !caps) {
            gst_sample_unref(sample);
            return GST_FLOW_ERROR;
        }

        GstStructure* structure = gst_caps_get_structure(caps, 0);
        int sample_rate, channels;
        if (!gst_structure_get_int(structure, "rate", &sample_rate) ||
            !gst_structure_get_int(structure, "channels", &channels) ||
            channels <= 0) {
            gst_sample_unref(sample);
            return GST_FLOW_ERROR;
        }

        GstMapInfo map;
        if (!gst_buffer_map(buffer, &map, GST_MAP_READ)) {
            gst_sample_unref(sample);
            return GST_FLOW_ERROR;
        }

        int no_samples = (int)(map.size / (channels * sizeof(float)));
        if (no_samples <= 0) {
            gst_buffer_unmap(buffer, &map);
            gst_sample_unref(sample);
            return GST_FLOW_OK;
        }

        uint8_t* frame_data = (uint8_t*)malloc(map.size);
        if (!frame_data) {
            gst_buffer_unmap(buffer, &map);
            gst_sample_unref(sample);
            return GST_FLOW_ERROR;
        }
        memcpy(frame_data, map.data, map.size);
        gst_buffer_unmap(buffer, &map);

        // NDI audio only accepts planar (non-interleaved) 32-bit float --
        // the "FLTP" FourCC is the only member of NDIlib_FourCC_audio_type_e.
        // The caps above request layout=non-interleaved for exactly this
        // reason, so channel_stride_in_bytes below is simply one channel's
        // worth of samples.
        NDIlib_audio_frame_v3_t audio_frame = {};
        audio_frame.sample_rate = sample_rate;
        audio_frame.no_channels = channels;
        audio_frame.no_samples = no_samples;
        audio_frame.timecode = NDIlib_send_timecode_synthesize;
        audio_frame.FourCC = NDIlib_FourCC_audio_type_FLTP;
        audio_frame.p_data = frame_data;
        audio_frame.channel_stride_in_bytes = no_samples * (int)sizeof(float);

        static bool first_audio = true;
        static int audio_count = 0;
        if (first_audio) {
            std::cout << "[NDI] First audio frame: " << sample_rate << "Hz, "
                      << channels << "ch, " << no_samples << " samples/ch" << std::endl;
            first_audio = false;
        }
        if (++audio_count % 500 == 0) {
            std::cout << "[NDI] Sent " << audio_count << " audio frames" << std::endl;
        }

        g_ndi.send_send_audio_v3(self->ndi_sender, &audio_frame);
        free(frame_data);

        gst_sample_unref(sample);
        return GST_FLOW_OK;
    }

    // Blocks until the pipeline reports an ERROR or EOS on its bus, then
    // returns. Lets main() exit non-zero and hand recovery to systemd
    // (Restart=on-failure) instead of trying to self-heal a broken
    // GStreamer pipeline in-process.
    bool waitForPipelineFailure() {
        if (!bus) return true;

        GstMessage* msg = gst_bus_timed_pop_filtered(
            bus, GST_CLOCK_TIME_NONE,
            (GstMessageType)(GST_MESSAGE_ERROR | GST_MESSAGE_EOS));

        if (!msg) return true; // NULL only on bus_set_flushing, i.e. we're stopping

        if (GST_MESSAGE_TYPE(msg) == GST_MESSAGE_ERROR) {
            GError* err = nullptr;
            gchar* debug = nullptr;
            gst_message_parse_error(msg, &err, &debug);
            std::cerr << "[GST] Pipeline error: " << (err ? err->message : "unknown")
                      << (debug ? (std::string(" (") + debug + ")") : "") << std::endl;
            if (err) g_error_free(err);
            if (debug) g_free(debug);
        } else {
            std::cerr << "[GST] Pipeline reached EOS unexpectedly" << std::endl;
        }

        gst_message_unref(msg);
        return false;
    }

    // Unblocks a thread parked in waitForPipelineFailure() without touching
    // the pipeline/bus objects themselves. Must be called -- and the
    // watchdog thread joined -- before stop() tears anything down, or the
    // watchdog can end up reading a bus that's being unreffed concurrently.
    void interrupt() {
        if (bus) gst_bus_set_flushing(bus, TRUE);
    }

    void stop() {
        teardownPipeline();

        if (ndi_sender) {
            g_ndi.send_destroy(ndi_sender);
            ndi_sender = nullptr;
        }
    }
};

// ===== Main =====

void printUsage(const char* prog) {
    std::cout << "AirPlay (uxplay) to NDI Bridge v2\n"
              << "Usage: " << prog << " [options]\n"
              << "Options:\n"
              << "  --name <name>          NDI source name (default: uxplay-airplay)\n"
              << "  --display <:N>         X display to capture, e.g. :1 (default: :1)\n"
              << "  --width <px>           Capture width, must match the X display's own\n"
              << "                         resolution (default: 1920)\n"
              << "  --height <px>          Capture height, ditto (default: 1080)\n"
              << "  --fps <fps>            Target FPS (default: 30)\n"
              << "  --audio-device <dev>   PulseAudio source/monitor device to capture\n"
              << "                         (default: uxplay_ndi_audio.monitor)\n"
              << "  --no-audio             Disable audio capture entirely (video only)\n"
              << "  --help                 Show this help message\n";
}

int main(int argc, char* argv[]) {
    std::string ndi_name = "uxplay-airplay";
    std::string x_display = ":1";
    std::string audio_device = "uxplay_ndi_audio.monitor";
    int width = 1920;
    int height = 1080;
    int fps = 30;
    bool audio_enabled = true;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--name" && i + 1 < argc) {
            ndi_name = argv[++i];
        } else if (arg == "--display" && i + 1 < argc) {
            x_display = argv[++i];
        } else if (arg == "--width" && i + 1 < argc) {
            width = std::atoi(argv[++i]);
        } else if (arg == "--height" && i + 1 < argc) {
            height = std::atoi(argv[++i]);
        } else if (arg == "--fps" && i + 1 < argc) {
            fps = std::atoi(argv[++i]);
        } else if (arg == "--audio-device" && i + 1 < argc) {
            audio_device = argv[++i];
        } else if (arg == "--no-audio") {
            audio_enabled = false;
        } else if (arg == "--help") {
            printUsage(argv[0]);
            return 0;
        }
    }

    if (!g_ndi.loadLibrary()) {
        return 1;
    }

    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    AirPlayNDIBridge bridge(ndi_name, x_display, width, height, fps, audio_enabled, audio_device);

    if (!bridge.initializeNDI()) {
        return 1;
    }

    // The X display (Xvfb) this depends on is a separate systemd service and
    // may not have finished starting yet -- retry pipeline creation for a
    // while instead of failing immediately on a cold boot race.
    bool started = false;
    for (int attempt = 0; g_running && attempt < 10; ++attempt) {
        if (bridge.createPipeline()) {
            started = true;
            break;
        }
        std::cerr << "[GST] Pipeline start failed (attempt " << (attempt + 1)
                  << "/10), retrying in 2s..." << std::endl;
        sleep(2);
    }

    if (!started) {
        std::cerr << "[GST] Giving up after repeated pipeline failures" << std::endl;
        bridge.stop();
        return 1;
    }

    std::cout << "NDI source available as: " << ndi_name << std::endl;
    std::cout << "Press Ctrl+C to exit" << std::endl;

    std::thread watchdog([&bridge]() {
        if (!bridge.waitForPipelineFailure()) {
            g_running = false;
        }
    });

    while (g_running) {
        sleep(1);
    }

    // Unblock+join the watchdog before tearing down the pipeline it's
    // reading from, then tear down for real.
    bridge.interrupt();
    if (watchdog.joinable()) watchdog.join();
    bridge.stop();

    return 0;
}
