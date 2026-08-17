#!/bin/bash
#
# Creates (if missing) a PulseAudio/PipeWire-pulse null-sink dedicated to
# uxplay's audio output, and makes it the default sink so uxplay's
# "autoaudiosink" (which resolves to pulsesink on Linux) lands there instead
# of real hardware. uxplay_ndi_sender then captures "<sink>.monitor" as its
# NDI audio source (see --audio-device).
#
# Idempotent: safe to run on every boot/service start. Works against either
# a real PulseAudio server or PipeWire's pulse-compatible socket (the
# default on Raspberry Pi OS Bookworm+) -- both speak the same `pactl`
# protocol.

set -e

SINK_NAME="${UXPLAY_NDI_AUDIO_SINK:-uxplay_ndi_audio}"

# The user's Pulse/PipeWire-pulse session may not be up yet this early in
# boot -- give it a few seconds rather than failing immediately.
ready=0
for i in $(seq 1 15); do
    if pactl info >/dev/null 2>&1; then
        ready=1
        break
    fi
    sleep 1
done

if [ "$ready" -ne 1 ]; then
    echo "ERROR: no PulseAudio/PipeWire-pulse server reachable for this user." >&2
    echo "       Check that pipewire-pulse (or pulseaudio) is installed and" >&2
    echo "       that XDG_RUNTIME_DIR is set correctly for this service." >&2
    exit 1
fi

if pactl list short sinks | awk '{print $2}' | grep -qx "$SINK_NAME"; then
    echo "Null sink '$SINK_NAME' already exists."
else
    echo "Creating null sink '$SINK_NAME'..."
    pactl load-module module-null-sink \
        sink_name="$SINK_NAME" \
        sink_properties=device.description="UXPlayNDIAudio"
fi

echo "Setting '$SINK_NAME' as the default sink..."
pactl set-default-sink "$SINK_NAME"

echo "Done. uxplay's audio will route to '$SINK_NAME'; NDI captures it from '$SINK_NAME.monitor'."
