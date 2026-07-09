#!/bin/bash
# NDI Monitor - Start both Python and Node.js servers

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo "🎬 NDI Monitor - Starting servers..."
echo "=================================="

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Start Python NDI server
echo -e "${YELLOW}▸ Starting Python NDI server on port 3081...${NC}"
export NDI_SERVER_PORT=3081
export NDI_SERVER_HOST=127.0.0.1
python3 ndi_stream_server.py &
PYTHON_PID=$!
echo -e "${GREEN}✓ Python NDI server started (PID: $PYTHON_PID)${NC}"

# Give Python server time to start
sleep 2

# Start Node.js API server
echo -e "${YELLOW}▸ Starting Node.js API server on port 3080...${NC}"
npm start &
NODE_PID=$!
echo -e "${GREEN}✓ Node.js API server started (PID: $NODE_PID)${NC}"

echo ""
echo -e "${GREEN}✓ All servers running!${NC}"
echo "  Python NDI Server: http://127.0.0.1:3081"
echo "  Node.js API Server: http://127.0.0.1:3080"
echo ""
echo "Press Ctrl+C to stop all servers..."
echo ""

# Handle cleanup
cleanup() {
    echo ""
    echo -e "${YELLOW}Shutting down servers...${NC}"
    kill $PYTHON_PID 2>/dev/null || true
    kill $NODE_PID 2>/dev/null || true
    wait 2>/dev/null || true
    echo -e "${GREEN}✓ Servers stopped${NC}"
    exit 0
}

trap cleanup EXIT SIGINT SIGTERM

# Wait for both processes
wait
