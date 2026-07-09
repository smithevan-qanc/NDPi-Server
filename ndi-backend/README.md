# NDI Backend (FastAPI)

Python FastAPI server that handles NDI stream capture and frame encoding. This backend provides MJPEG and single JPEG frame endpoints that the Node.js WebRTC server consumes.

## Setup

### 1. Install Dependencies

```bash
cd ndi-backend
pip install -r requirements.txt
```

### 2. Set NDI SDK Path (if needed)

If the NDI SDK is not in the default location, set the environment variable:

```bash
export NDI_DLL_PATH=/path/to/ndi/lib/libndi.dylib  # macOS
export NDI_DLL_PATH=/path/to/ndi/lib/libndi.so     # Linux
export NDI_DLL_PATH=/path/to/ndi/lib/Processing.NDI.Lib.x64.dll  # Windows
```

### 3. Run the Server

```bash
python3 app.py
```

Or use the included script:

```bash
./run.sh
```

The server will start on `http://127.0.0.1:5000`

## API Endpoints

### Source Discovery
- `GET /api/sources` - List all available NDI sources
- `GET /api/selected` - Get currently selected source
- `POST /api/select` - Select an NDI source (body: `{"name": "source name"}`)

### Stream Settings
- `GET /api/settings` - Get current settings (quality, output size)
- `POST /api/settings` - Update settings (body: `{"jpegQuality": 80, "outputWidth": 0, "outputHeight": 0}`)

### Video Streams
- `GET /mjpeg` - MJPEG stream (Motion JPEG)
- `GET /frame.jpg` - Single JPEG frame

### Health
- `GET /health` - Health check

## Integration with Node.js Server

The Node.js WebRTC server (`service/client_api_server.js`) proxies requests to this backend:

```javascript
// Example from NDIStreamManager
GET /api/v1/ndi-sources  →  http://127.0.0.1:5000/api/sources
GET /mjpeg               →  http://127.0.0.1:5000/mjpeg
```

## Files

- `app.py` - Main FastAPI application
- `ndi_receiver.py` - NDI SDK bindings and receiver logic
- `requirements.txt` - Python dependencies
- `run.sh` - Startup script
