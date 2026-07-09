#!/bin/bash
# NDI Backend Startup Script
# Ensures Python environment is ready and starts the FastAPI server

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Create virtual environment if it doesn't exist
if [ ! -d "venv" ]; then
    echo "[NDI Backend] Creating Python virtual environment..."
    sudo python3 -m venv venv
fi

# Activate virtual environment
source venv/bin/activate 2>/dev/null || . venv/Scripts/activate 2>/dev/null || true

# Upgrade pip and setuptools first (fixes build issues on ARM)
echo "[NDI Backend] Upgrading pip and setuptools..."
sudo python3 -m pip install --upgrade pip setuptools wheel 2>/dev/null || true

# Install/upgrade requirements with pre-built wheels only
if [ -f "requirements.txt" ]; then
    echo "[NDI Backend] Installing dependencies..."
    sudo python3 -m pip install --only-binary :all: -r requirements.txt 2>/dev/null || \
    sudo python3 -m pip install -r requirements.txt
fi

# Start the FastAPI server
echo "[NDI Backend] Starting FastAPI server..."
sudo bash -c 'source ./venv/bin/activate && ./venv/bin/python3 app.py'
