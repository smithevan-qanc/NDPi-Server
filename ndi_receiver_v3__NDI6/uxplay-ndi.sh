#!/bin/bash

# AirPlay to NDI Bridge - CLI Management Script
# Manages the 3-service stack: uxplay-audio-setup -> uxplay-airplay ->
# uxplay-ndi-sender. HDMI-2 (screen :0.1) itself is provided by the Hub's
# own kiosk Xorg process (see ../config/xorg/10-hdmi-zaphod.conf), not a
# service this script manages.
#
# Usage: ./uxplay-ndi.sh {build|start|stop|restart|status|logs|install-service}

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="uxplay_ndi_sender"
APP_PATH="$SCRIPT_DIR/$APP_NAME"
LOG_FILE="/var/log/uxplay-ndi.log"
PID_FILE="/tmp/uxplay-ndi.pid"

# Services in dependency order (start order; stop uses this reversed).
SERVICES=(uxplay-audio-setup uxplay-airplay uxplay-ndi-sender)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

services_installed() {
    systemctl list-unit-files 2>/dev/null | grep -q "uxplay-ndi-sender.service"
}

# Build the application
build() {
    print_info "Building AirPlay to NDI Bridge..."

    cd "$SCRIPT_DIR"

    if ! command -v pkg-config &> /dev/null; then
        print_error "pkg-config not found. Install with: sudo apt install pkg-config"
        return 1
    fi

    for pkg in gstreamer-1.0 gstreamer-app-1.0; do
        if ! pkg-config --exists "$pkg"; then
            print_error "Missing package: $pkg"
            print_info "Install with: sudo apt install libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev"
            return 1
        fi
    done

    echo "Compiling with:"
    echo "  g++ -o $APP_NAME $APP_NAME.cpp $(pkg-config --cflags --libs gstreamer-1.0 gstreamer-app-1.0) -I\"include\" -ldl -pthread -std=c++11"

    g++ -o "$APP_NAME" "$APP_NAME.cpp" \
        $(pkg-config --cflags --libs gstreamer-1.0 gstreamer-app-1.0) \
        -I"include" \
        -ldl \
        -pthread \
        -std=c++11

    if [ -f "$APP_PATH" ]; then
        chmod +x "$APP_PATH"
        print_info "Build successful: $APP_PATH"
        return 0
    else
        print_error "Build failed: executable not created"
        return 1
    fi
}

# Start the full stack
start() {
    if services_installed; then
        print_info "Starting AirPlay to NDI Bridge (systemd)..."
        for svc in "${SERVICES[@]}"; do
            sudo systemctl start "$svc"
            print_info "  started $svc"
        done
        return 0
    fi

    print_warning "systemd services not installed -- run './uxplay-ndi.sh install-service' for the full stack (audio + uxplay + NDI)."
    print_warning "Falling back to running $APP_NAME directly. This assumes screen :0.1 (HDMI-2,"
    print_warning "see ../config/xorg/10-hdmi-zaphod.conf) is already up and, for audio, a"
    print_warning "PulseAudio null-sink already set up manually."

    if [ ! -f "$APP_PATH" ]; then
        print_error "Application not found: $APP_PATH"
        print_info "Run './uxplay-ndi.sh build' first"
        return 1
    fi

    nohup "$APP_PATH" --name "uxplay-airplay" --display :0.1 --width 1920 --height 1080 --fps 30 >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    print_info "Started directly (PID: $(cat "$PID_FILE"))"
}

# Stop the full stack
stop() {
    if services_installed; then
        print_info "Stopping AirPlay to NDI Bridge (systemd)..."
        for (( idx=${#SERVICES[@]}-1 ; idx>=0 ; idx-- )); do
            svc="${SERVICES[$idx]}"
            sudo systemctl stop "$svc" || true
            print_info "  stopped $svc"
        done
        return 0
    fi

    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            kill "$PID"
            rm "$PID_FILE"
            print_info "Stopped (PID: $PID)"
        else
            print_warning "Process not running (stale PID file)"
            rm "$PID_FILE"
        fi
    else
        print_warning "No PID file found"
    fi
}

# Restart the full stack
restart() {
    stop
    sleep 2
    start
}

# Check status of every service in the stack
status() {
    if services_installed; then
        for svc in "${SERVICES[@]}"; do
            print_info "--- $svc ---"
            sudo systemctl status "$svc" --no-pager || true
        done
        return 0
    fi

    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            print_info "Running (PID: $PID)"
            return 0
        else
            print_error "Not running (stale PID file)"
            return 1
        fi
    else
        print_error "Not running"
        return 1
    fi
}

# Install all 3 systemd service files and enable them
install_service() {
    print_info "Installing systemd services..."

    CONFIG_DIR="$SCRIPT_DIR/../config/systemd"

    for svc in "${SERVICES[@]}"; do
        CONFIG_FILE="$CONFIG_DIR/$svc.service"
        if [ ! -f "$CONFIG_FILE" ]; then
            print_error "Service file not found: $CONFIG_FILE"
            return 1
        fi
        sudo cp "$CONFIG_FILE" "/etc/systemd/system/$svc.service"
    done

    sudo systemctl daemon-reload

    for svc in "${SERVICES[@]}"; do
        sudo systemctl enable "$svc"
    done

    print_info "All 3 services installed and enabled: ${SERVICES[*]}"
    print_info "Start with: ./uxplay-ndi.sh start"
}

# Show help
show_help() {
    cat << EOF
AirPlay to NDI Bridge - CLI Management Script

Usage: $0 {command} [options]

Commands:
  build              Compile uxplay_ndi_sender
  start              Start the full stack (audio setup, uxplay, NDI sender)
  stop               Stop the full stack
  restart            Restart the full stack
  status             Check status of every service in the stack
  install-service    Install and enable all 3 systemd services (requires sudo)
  logs               Show recent logs from every service
  help               Show this help message

Examples:
  # First time setup:
  $0 build
  $0 install-service

  # Daily usage:
  $0 start
  $0 status
  $0 stop

  # Check logs:
  $0 logs

For more information, see: BUILD_AND_SETUP.md
EOF
}

# Show logs from every service
show_logs() {
    if services_installed; then
        for svc in "${SERVICES[@]}"; do
            print_info "--- $svc (last 30 lines) ---"
            sudo journalctl -u "$svc" -n 30 --no-pager
        done
        return 0
    fi

    if [ -f "$LOG_FILE" ]; then
        tail -50 "$LOG_FILE"
    else
        print_warning "No logs found"
    fi
}

# Main command dispatcher
case "${1:-help}" in
    build)
        build
        ;;
    start)
        start
        ;;
    stop)
        stop
        ;;
    restart)
        restart
        ;;
    status)
        status
        ;;
    install-service)
        install_service
        ;;
    logs)
        show_logs
        ;;
    help)
        show_help
        ;;
    *)
        print_error "Unknown command: $1"
        show_help
        exit 1
        ;;
esac
