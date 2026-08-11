#!/bin/bash
# Start both Node.js and Python backends for NDI-to-WebRTC streaming

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🎬 NDI-to-WebRTC Streaming System"
echo "=================================="
echo ""

# Check if Python is available
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is required but not installed"
    exit 1
fi

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is required but not installed"
    exit 1
fi

# Start Python backend
echo "📦 Starting Python FastAPI backend..."
cd "$SCRIPT_DIR/ndi-backend"

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "   Creating Python virtual environment..."
    python3 -m venv venv
fi

# Activate virtual environment
source venv/bin/activate 2>/dev/null || . venv/Scripts/activate 2>/dev/null || true

# Install/upgrade dependencies
echo "   Installing dependencies..."
pip install -q -r requirements.txt

# Start Python server in background
python3 app.py &
PYTHON_PID=$!
echo "   ✓ Python server started (PID: $PYTHON_PID)"

# Wait for Python server to be ready
echo "   Waiting for Python server to be ready..."
sleep 3

# Check if Python server is running
if ! kill -0 $PYTHON_PID 2>/dev/null; then
    echo "   ❌ Python server failed to start"
    exit 1
fi

echo ""
echo "🟢 Starting Node.js API server..."
cd "$SCRIPT_DIR"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "   Installing dependencies..."
    npm install
fi

# Start Node.js server in background
node service/hub_api_server.js &
NODE_PID=$!
echo "   ✓ Node.js server started (PID: $NODE_PID)"

echo ""
echo "✅ Both servers are running!"
echo ""
echo "📍 Web Interface:"
echo "   http://localhost:3080/test-page"
echo ""
echo "🔌 Python Backend:"
echo "   http://localhost:5000/health"
echo ""
echo "Press Ctrl+C to stop both servers"
echo ""

# Cleanup function
cleanup() {
    echo ""
    echo "Stopping servers..."
    kill $PYTHON_PID 2>/dev/null || true
    kill $NODE_PID 2>/dev/null || true
    wait $PYTHON_PID 2>/dev/null || true
    wait $NODE_PID 2>/dev/null || true
    echo "✓ Servers stopped"
    exit 0
}

# Trap signals
trap cleanup SIGINT SIGTERM

# Wait for both processes
wait
