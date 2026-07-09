#!/bin/bash
# NDI Backend Startup Script
# Ensures Python environment is ready and starts the FastAPI server

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Create virtual environment if it doesn't exist
if [ ! -d "venv" ]; then
    echo "[NDI Backend] Creating Python virtual environment..."
    python3 -m venv venv
fi

# Activate virtual environment
source venv/bin/activate 2>/dev/null || . venv/Scripts/activate 2>/dev/null || true

# Install/upgrade requirements
if [ -f "requirements.txt" ]; then
    python3 -m pip install -q -r requirements.txt 2>/dev/null || \
    python3 -m pip install -r requirements.txt
fi

# Start the FastAPI server
python3 app.py
