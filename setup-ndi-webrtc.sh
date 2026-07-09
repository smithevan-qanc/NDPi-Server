#!/bin/bash

################################################################################
# NDI to WebRTC Streaming Server - Setup Script
#
# This script sets up and starts the NDI to WebRTC streaming server
#
# Usage:
#   chmod +x setup-ndi-webrtc.sh
#   ./setup-ndi-webrtc.sh
#   ./setup-ndi-webrtc.sh start [port] [ndi-source]
################################################################################

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${2:-8080}"
NDI_SOURCE="${3:-}"
NODE_MODULES="$SCRIPT_DIR/node_modules"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
print_header() {
    echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║${NC} $1"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_info() {
    echo -e "${YELLOW}ℹ${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    print_header "Checking Prerequisites"
    
    # Check Node.js
    if ! command -v node &> /dev/null; then
        print_error "Node.js is not installed"
        echo "Please install Node.js from https://nodejs.org/"
        exit 1
    fi
    print_success "Node.js $(node --version) is installed"
    
    # Check npm
    if ! command -v npm &> /dev/null; then
        print_error "npm is not installed"
        exit 1
    fi
    print_success "npm $(npm --version) is installed"
    
    # Check for C++ compiler (for encoder)
    if ! command -v g++ &> /dev/null; then
        print_info "g++ is not installed (needed to compile H.264 encoder)"
        echo "Install with: brew install gcc (macOS) or apt-get install build-essential (Linux)"
    else
        print_success "g++ is installed"
    fi
    
    # Check for NDI SDK
    if [ ! -d "$SCRIPT_DIR/ndi_receiver_v3__NDI6" ]; then
        print_error "NDI SDK not found at ndi_receiver_v3__NDI6"
        exit 1
    fi
    print_success "NDI SDK found"
}

# Install dependencies
install_dependencies() {
    print_header "Installing Dependencies"
    
    if [ ! -d "$NODE_MODULES" ]; then
        print_info "Installing npm packages..."
        npm install express ws uuid
        print_success "npm packages installed"
    else
        print_success "Dependencies already installed"
    fi
}

# Compile H.264 encoder (optional)
compile_encoder() {
    print_header "Compiling H.264 Encoder (Optional)"
    
    if [ ! -f "$SCRIPT_DIR/ndi-to-h264-encoder.cpp" ]; then
        print_error "ndi-to-h264-encoder.cpp not found"
        return
    fi
    
    # Check for GStreamer
    if ! pkg-config --exists gstreamer-1.0; then
        print_info "GStreamer not found - encoder compilation skipped"
        print_info "Install with: brew install gstreamer (macOS) or apt-get install libgstreamer1.0-dev (Linux)"
        return
    fi
    
    print_info "Compiling ndi-to-h264-encoder..."
    
    # Determine architecture and library path
    ARCH=$(uname -m)
    case $ARCH in
        aarch64)
            LIB_ARCH="aarch64-rpi4-linux-gnueabi"
            ;;
        arm*)
            LIB_ARCH="arm-rpi4-linux-gnueabihf"
            ;;
        x86_64)
            LIB_ARCH="x86_64-linux-gnu"
            ;;
        *)
            LIB_ARCH="x86_64-linux-gnu"
            ;;
    esac
    
    g++ -o "$SCRIPT_DIR/ndi-to-h264" \
        "$SCRIPT_DIR/ndi-to-h264-encoder.cpp" \
        $(pkg-config --cflags --libs gstreamer-1.0 gstreamer-app-1.0 glib-2.0) \
        -I"$SCRIPT_DIR/ndi_receiver_v3__NDI6/include" \
        -L"$SCRIPT_DIR/ndi_receiver_v3__NDI6/lib/$LIB_ARCH" \
        -lndi -ldl -std=c++17 -Wall -O2
    
    if [ -f "$SCRIPT_DIR/ndi-to-h264" ]; then
        chmod +x "$SCRIPT_DIR/ndi-to-h264"
        print_success "H.264 encoder compiled successfully"
    else
        print_error "Failed to compile H.264 encoder"
    fi
}

# Start server
start_server() {
    print_header "Starting NDI WebRTC Server"
    
    cd "$SCRIPT_DIR"
    
    echo -e "${GREEN}Server Configuration:${NC}"
    echo "  Port: $PORT"
    echo "  NDI Source: ${NDI_SOURCE:-Auto-discovery}"
    echo ""
    
    if [ -z "$NDI_SOURCE" ]; then
        print_info "No NDI source specified. Use web interface to select source."
        node ndi-webrtc-server.js $PORT
    else
        print_info "Starting with NDI source: $NDI_SOURCE"
        node ndi-webrtc-server.js $PORT "$NDI_SOURCE"
    fi
}

# Show usage
show_usage() {
    cat << EOF
${BLUE}NDI to WebRTC Streaming Server${NC}

${GREEN}Usage:${NC}
  $0                    Setup and show menu
  $0 start [port] [source]  Start server
  $0 compile            Compile H.264 encoder only
  $0 help               Show this help

${GREEN}Examples:${NC}
  $0                              # Interactive setup
  $0 start                        # Start on default port 8080
  $0 start 9000                   # Start on port 9000
  $0 start 8080 "Camera 1"        # Start with specific NDI source

${GREEN}Environment Variables:${NC}
  PORT                Set server port (default: 8080)
  NDI_SOURCE          Set NDI source name (optional)

${GREEN}Once Running:${NC}
  Open: http://localhost:\$PORT
  API:  http://localhost:\$PORT/api/ndi-sources

${GREEN}Troubleshooting:${NC}
  - Ensure NDI SDK is in ndi_receiver_v3__NDI6/
  - Check firewall allows port \$PORT
  - Use web interface to discover NDI sources
  - Check debug log in web interface for errors

EOF
}

# Main logic
case "${1:-}" in
    start)
        check_prerequisites
        install_dependencies
        start_server
        ;;
    compile)
        check_prerequisites
        compile_encoder
        ;;
    help)
        show_usage
        ;;
    *)
        check_prerequisites
        install_dependencies
        compile_encoder
        echo ""
        show_usage
        echo ""
        read -p "Start server on port $PORT? (y/n) " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            start_server
        fi
        ;;
esac
