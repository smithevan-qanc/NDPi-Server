#!/bin/bash

# UXPlay NDI Sender - CLI Management Script
# Usage: ./uxplay-ndi.sh {start|stop|restart|status|build}

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="uxplay_ndi_sender"
APP_PATH="$SCRIPT_DIR/$APP_NAME"
LOG_FILE="/var/log/uxplay-ndi.log"
SERVICE_NAME="uxplay-ndi-sender"
PID_FILE="/tmp/uxplay-ndi.pid"

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

# Build the application
build() {
    print_info "Building UXPlay NDI Sender..."
    
    cd "$SCRIPT_DIR"
    
    if ! command -v pkg-config &> /dev/null; then
        print_error "pkg-config not found. Install with: sudo apt install pkg-config"
        return 1
    fi
    
    # Check for required packages
    for pkg in gstreamer-1.0 gstreamer-app-1.0; do
        if ! pkg-config --exists "$pkg"; then
            print_error "Missing package: $pkg"
            print_info "Install with: sudo apt install libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev"
            return 1
        fi
    done
    
    # Compile
    echo "Compiling with:"
    echo "  g++ -o $APP_NAME $APP_NAME.cpp $(pkg-config --cflags --libs gstreamer-1.0 gstreamer-app-1.0) -I\"include\" -ldl -std=c++11"
    
    g++ -o "$APP_NAME" "$APP_NAME.cpp" \
        $(pkg-config --cflags --libs gstreamer-1.0 gstreamer-app-1.0) \
        -I"include" \
        -ldl \
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

# Start the service
start() {
    print_info "Starting UXPlay NDI Sender..."
    
    if [ ! -f "$APP_PATH" ]; then
        print_error "Application not found: $APP_PATH"
        print_info "Run './uxplay-ndi.sh build' first"
        return 1
    fi
    
    # Try systemd service first
    if systemctl list-units --all | grep -q "$SERVICE_NAME"; then
        sudo systemctl start "$SERVICE_NAME"
        print_info "Service started via systemd"
        return 0
    fi
    
    # Fallback: run directly
    nohup "$APP_PATH" --name "uxplay-airplay" --bitrate 5000 --fps 30 >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    print_info "Service started directly (PID: $(cat $PID_FILE))"
}

# Stop the service
stop() {
    print_info "Stopping UXPlay NDI Sender..."
    
    # Try systemd service first
    if systemctl list-units --all | grep -q "$SERVICE_NAME"; then
        sudo systemctl stop "$SERVICE_NAME"
        print_info "Service stopped via systemd"
        return 0
    fi
    
    # Fallback: kill directly
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            kill "$PID"
            rm "$PID_FILE"
            print_info "Service stopped (PID: $PID)"
        else
            print_warning "Process not running (stale PID file)"
            rm "$PID_FILE"
        fi
    else
        print_warning "No PID file found"
    fi
}

# Restart the service
restart() {
    stop
    sleep 2
    start
}

# Check service status
status() {
    # Try systemd service first
    if systemctl list-units --all | grep -q "$SERVICE_NAME"; then
        print_info "Service status (systemd):"
        sudo systemctl status "$SERVICE_NAME" || true
        return 0
    fi
    
    # Fallback: check PID file
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            print_info "Service running (PID: $PID)"
            return 0
        else
            print_error "Service not running (stale PID file)"
            return 1
        fi
    else
        print_error "Service not running"
        return 1
    fi
}

# Install systemd service
install_service() {
    print_info "Installing systemd service..."
    
    SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"
    CONFIG_FILE="$SCRIPT_DIR/../config/systemd/$SERVICE_NAME.service"
    
    if [ ! -f "$CONFIG_FILE" ]; then
        print_error "Service file not found: $CONFIG_FILE"
        return 1
    fi
    
    sudo cp "$CONFIG_FILE" "$SERVICE_FILE"
    sudo systemctl daemon-reload
    sudo systemctl enable "$SERVICE_NAME"
    print_info "Service installed and enabled"
}

# Show help
show_help() {
    cat << EOF
UXPlay NDI Sender - CLI Management Script

Usage: $0 {command} [options]

Commands:
  build              Compile the application
  start              Start the service
  stop               Stop the service
  restart            Restart the service
  status             Check service status
  install-service    Install systemd service (requires sudo)
  logs               Show recent logs
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

For more information, see: NDI_NDI_UXPLAY_INTEGRATION.md
EOF
}

# Show logs
show_logs() {
    print_info "Recent logs from UXPlay NDI Sender:"
    
    if systemctl list-units --all | grep -q "$SERVICE_NAME"; then
        sudo journalctl -u "$SERVICE_NAME" -n 50 --no-pager
    elif [ -f "$LOG_FILE" ]; then
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
