#!/bin/bash
# Start NDI Backend FastAPI server

# Navigate to script directory
cd "$(dirname "$0")" || exit 1

echo "Starting NDI Backend..."
python3 app.py
