"""
NDI Backend - FastAPI server for NDI stream handling
Provides MJPEG and JPEG endpoints for Node.js WebRTC server to consume
"""
import threading
import time
import urllib.request
import json
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
import uvicorn

from ndi_receiver import NDIReceiver, NDISourceFinder, NDIError


# ============================================================================
# Configuration
# ============================================================================

PORT = 5000
HOST = "127.0.0.1"
NODE_SERVER_URL = "http://127.0.0.1:3080"


# ============================================================================
# Application State
# ============================================================================

# Lifespan event handler
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Handle startup and shutdown events"""
    # Startup
    yield
    # Shutdown - cleanup resources
    global receiver, finder
    
    with receiver_lock:
        if receiver is not None:
            try:
                receiver.close()
            except Exception:
                pass
            receiver = None
    
    try:
        finder.close()
    except Exception:
        pass


app = FastAPI(
    title="NDPi NDI Backend",
    version="1.0.0",
    lifespan=lifespan
)

finder = NDISourceFinder()
receiver_lock = threading.Lock()
receiver: Optional[NDIReceiver] = None
selected_source_name: Optional[str] = None

settings_lock = threading.Lock()
jpeg_quality: int = 90
output_width: int = 0
output_height: int = 0


# ============================================================================
# API Endpoints
# ============================================================================

@app.get("/health")
def health():
    """Health check endpoint"""
    return JSONResponse({"ok": True})


@app.get("/api/sources")
def list_sources():
    """List all available NDI sources from Node.js server"""
    try:
        url = f"{NODE_SERVER_URL}/api/v1/ndi-sources"
        with urllib.request.urlopen(url, timeout=5) as response:
            data = json.loads(response.read().decode())
            return {"sources": data.get("sources", [])}
    except Exception as e:
        # Fallback: try ctypes discovery if Node.js server not available
        try:
            sources = finder.list_sources(timeout_ms=500)
            return {"sources": sources}
        except NDIError:
            raise HTTPException(status_code=503, detail=f"NDI source discovery unavailable: {str(e)}")


@app.get("/api/selected")
def get_selected():
    """Get currently selected NDI source"""
    return {"selected": selected_source_name}


@app.post("/api/select")
def select_source(payload: dict):
    """Select an NDI source to stream"""
    global receiver, selected_source_name
    
    name = (payload or {}).get("name")
    if not name or not isinstance(name, str):
        raise HTTPException(status_code=400, detail="Missing 'name' in payload")
    
    with receiver_lock:
        if receiver is not None:
            receiver.close()
            receiver = None
        
        try:
            receiver = NDIReceiver(source_name=name)
            selected_source_name = name
        except NDIError as e:
            raise HTTPException(status_code=500, detail=str(e))
    
    return {"ok": True, "selected": selected_source_name}


@app.get("/api/settings")
def get_settings():
    """Get current stream settings"""
    with settings_lock:
        q = int(jpeg_quality)
        w = int(output_width)
        h = int(output_height)
    return {"jpegQuality": q, "outputWidth": w, "outputHeight": h}


@app.post("/api/settings")
def update_settings(payload: dict):
    """Update stream settings (quality, output size)"""
    global jpeg_quality, output_width, output_height
    
    if payload is None:
        raise HTTPException(status_code=400, detail="Missing payload")
    
    # Update JPEG quality
    if "jpegQuality" in payload:
        try:
            q = int(payload["jpegQuality"])
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="jpegQuality must be an integer")
        
        q = max(20, min(95, q))
        with settings_lock:
            jpeg_quality = q
    
    # Update output size
    if "outputWidth" in payload or "outputHeight" in payload:
        try:
            w = int(payload.get("outputWidth", 0) or 0)
            h = int(payload.get("outputHeight", 0) or 0)
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="outputWidth/outputHeight must be integers")
        
        if (w == 0) != (h == 0):
            raise HTTPException(status_code=400, detail="outputWidth and outputHeight must both be set (or both 0)")
        
        if w != 0:
            w = max(160, min(3840, w))
            h = max(120, min(2160, h))
        
        with settings_lock:
            output_width = w
            output_height = h
    
    return get_settings()


@app.get("/mjpeg")
def mjpeg_stream():
    """Stream MJPEG (Motion JPEG) - continuous frame stream"""
    def gen():
        boundary = b"frame"
        while True:
            with receiver_lock:
                r = receiver
            
            if r is None:
                time.sleep(0.1)
                continue
            
            with settings_lock:
                q = int(jpeg_quality)
                w = int(output_width)
                h = int(output_height)
            
            frame = r.get_jpeg_frame(timeout_ms=1000, jpeg_quality=q, output_width=w, output_height=h)
            if frame is None:
                time.sleep(0.01)
                continue
            
            yield (
                b"--" + boundary + b"\r\n"
                b"Content-Type: image/jpeg\r\n"
                b"Content-Length: " + str(len(frame)).encode("ascii") + b"\r\n\r\n" +
                frame + b"\r\n"
            )
    
    return StreamingResponse(gen(), media_type="multipart/x-mixed-replace; boundary=frame")


@app.get("/frame.jpg")
def get_single_frame():
    """Get a single JPEG frame"""
    with receiver_lock:
        r = receiver
    
    if r is None:
        raise HTTPException(status_code=503, detail="No stream selected")
    
    with settings_lock:
        q = int(jpeg_quality)
        w = int(output_width)
        h = int(output_height)
    
    frame = r.get_jpeg_frame(timeout_ms=2000, jpeg_quality=q, output_width=w, output_height=h)
    if frame is None:
        raise HTTPException(status_code=504, detail="Failed to capture frame")
    
    return StreamingResponse(iter([frame]), media_type="image/jpeg")


# ============================================================================
# Main
# ============================================================================

if __name__ == "__main__":
    print(f"Starting NDI Backend on {HOST}:{PORT}")
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
