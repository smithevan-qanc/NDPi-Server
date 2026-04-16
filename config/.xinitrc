#!/bin/bash
# X initialization script for NDPi Monitor

# Depricated: Run autostart from systemd service instead
# Depricated: Run autostart from systemd service instead
# Depricated: Run autostart from systemd service instead
# Depricated: Run autostart from systemd service instead
# Depricated: Run autostart from systemd service instead
# Depricated: Run autostart from systemd service instead
# Depricated: Run autostart from systemd service instead

# Disable screen blanking and power management
xset s off
xset -dpms
xset s noblank

# Hide mouse cursor after 2 seconds of inactivity
unclutter -idle 2 &

# Start window manager (lightweight)
openbox &

# Wait for services to be ready
sleep 5

# Start Chromium in kiosk mode 
chromium --kiosk \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-component-extensions-with-background-pages \
    --no-first-run \
    --disable-default-apps \
    --disable-translate \
    --hide-scrollbars \
    --disable-features=TranslateUI \
    --noerrdialogs \
    --disable-web-security \
    --user-data-dir=/home/ndpi-server/.config/chromium-kiosk \
    http://localhost:3000
