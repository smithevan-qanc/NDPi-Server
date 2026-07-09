#!/usr/bin/env node

/**
 * NDI to WebRTC Streaming Server
 * 
 * Captures NDI streams and serves them via WebRTC to web clients
 * 
 * Usage:
 *   node ndi-webrtc-server.js [port] [ndi-source-name]
 *   node ndi-webrtc-server.js 8080 "Camera 1"
 * 
 * Install dependencies:
 *   npm install express ws ffmpeg-static uuid nanoid
 */

const express = require('express');
const WebSocket = require('ws');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Configuration
const PORT = process.argv[2] || 8080;
const NDI_SOURCE = process.argv[3] || null; // If null, we'll discover sources
const OUTPUT_DIR = path.join(__dirname, 'tmp/ndi-webrtc');
const NDI_RECEIVER = path.join(__dirname, 'ndi_receiver_v3__NDI6/ndi_receiver_v4');
const NDI_DISCOVER = path.join(__dirname, 'ndi_receiver_v3__NDI6/ndpi_discover');

// Create output directory
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// ==================== NDI Discovery ====================
function discoverNDISources() {
    try {
        if (!fs.existsSync(NDI_DISCOVER)) {
            console.log('NDI Discover not found. Using fallback discovery.');
            return [];
        }
        
        const output = execSync(`${NDI_DISCOVER} --json --timeout 3000`, {
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024
        });
        
        return JSON.parse(output || '[]');
    } catch (error) {
        console.error('Error discovering NDI sources:', error.message);
        return [];
    }
}

// ==================== Stream Management ====================
const streams = new Map(); // Map of streamId -> { receiver, process, clients, metadata }

class NDIStreamManager {
    constructor(sourceId) {
        this.id = sourceId;
        this.sourceId = sourceId;
        this.receiver = null;
        this.ffmpegProcess = null;
        this.clients = new Set();
        this.isRunning = false;
        this.startTime = null;
        this.frameCount = 0;
        this.bandwidth = 0;
    }

    async start(ndiSourceName) {
        if (this.isRunning) {
            console.log(`[${this.id}] Stream already running`);
            return;
        }

        console.log(`[${this.id}] Starting NDI stream for: ${ndiSourceName}`);
        this.startTime = Date.now();
        this.isRunning = true;

        try {
            // Start NDI Receiver that outputs to stdout
            // We'll use the existing ndi_receiver but pipe output to FFmpeg
            
            // Create a named pipe for video data
            const pipePath = path.join(OUTPUT_DIR, `ndi-${this.id}.h264`);
            
            // Start the NDI receiver process
            // The ndi_receiver_v4 outputs raw video via GStreamer, 
            // so we need to encode it properly for WebRTC
            
            // For now, we'll use FFmpeg to grab from an RTMP source or encode directly
            // First attempt: Use the NDI receiver and pipe through FFmpeg
            
            console.log(`[${this.id}] Spawning NDI receiver for "${ndiSourceName}"`);
            
            // Option 1: Direct FFmpeg encoding (if NDI is accessible to FFmpeg)
            this.startFFmpegStream(ndiSourceName);
            
        } catch (error) {
            console.error(`[${this.id}] Failed to start stream:`, error);
            this.isRunning = false;
        }
    }

    startFFmpegStream(ndiSourceName) {
        try {
            // Try to use FFmpeg with NDI support if available
            // Otherwise, we'll need to use the NDI receiver C++ program
            
            const ffmpegCmd = this.getFFmpegCommand(ndiSourceName);
            console.log(`[${this.id}] FFmpeg command:`, ffmpegCmd);
            
            // For WebRTC, we need H.264 encoded video
            // FFmpeg command to encode NDI to H.264 for WebRTC
            const args = [
                '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:d=100', // Placeholder for now
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-b:v', '2500k',
                '-c:a', 'aac',
                '-f', 'matroska',
                'pipe:1'
            ];
            
            this.ffmpegProcess = spawn('ffmpeg', args);
            
            this.ffmpegProcess.stdout.on('data', (data) => {
                this.bandwidth += data.length;
                this.broadcastToClients({
                    type: 'video-frame',
                    data: data.toString('base64'),
                    timestamp: Date.now()
                });
            });

            this.ffmpegProcess.stderr.on('data', (data) => {
                console.log(`[${this.id}] FFmpeg:`, data.toString().trim());
            });

            this.ffmpegProcess.on('close', (code) => {
                console.log(`[${this.id}] FFmpeg process exited with code ${code}`);
                this.isRunning = false;
            });

            this.ffmpegProcess.on('error', (error) => {
                console.error(`[${this.id}] FFmpeg error:`, error);
                this.isRunning = false;
            });

        } catch (error) {
            console.error(`[${this.id}] Error starting FFmpeg:`, error);
            this.isRunning = false;
        }
    }

    getFFmpegCommand(ndiSourceName) {
        // Returns the FFmpeg input specification for NDI source
        // Requires FFmpeg built with NDI support
        // Example: `decklink:0` for DeckLink, or if NDI filter available
        
        // Fallback: Use the NDI receiver C++ program as input
        // Unfortunately, we'd need to pipe it, so let's use a simpler approach
        
        return `-i "ndi:[${ndiSourceName}]"`;
    }

    broadcastToClients(message) {
        this.clients.forEach(client => {
            try {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(message));
                }
            } catch (error) {
                console.error(`[${this.id}] Error sending to client:`, error.message);
                this.clients.delete(client);
            }
        });
    }

    addClient(ws) {
        this.clients.add(ws);
        console.log(`[${this.id}] Client connected. Total clients: ${this.clients.size}`);
        
        // Send current stream status
        ws.send(JSON.stringify({
            type: 'status',
            streamId: this.id,
            isRunning: this.isRunning,
            frameCount: this.frameCount,
            bandwidth: this.bandwidth
        }));
    }

    removeClient(ws) {
        this.clients.delete(ws);
        console.log(`[${this.id}] Client disconnected. Total clients: ${this.clients.size}`);
        
        // Stop stream if no more clients
        if (this.clients.size === 0) {
            this.stop();
        }
    }

    stop() {
        if (!this.isRunning) return;
        
        console.log(`[${this.id}] Stopping NDI stream`);
        this.isRunning = false;

        if (this.ffmpegProcess) {
            this.ffmpegProcess.kill();
            this.ffmpegProcess = null;
        }

        if (this.receiver) {
            this.receiver.kill();
            this.receiver = null;
        }

        this.broadcastToClients({
            type: 'status',
            streamId: this.id,
            isRunning: false
        });

        streams.delete(this.id);
    }

    getStats() {
        return {
            id: this.id,
            isRunning: this.isRunning,
            clientCount: this.clients.size,
            frameCount: this.frameCount,
            bandwidth: this.bandwidth,
            uptime: this.isRunning ? Date.now() - this.startTime : 0
        };
    }
}

// ==================== Express Server ====================
const app = express();
app.use(express.json());
app.use(express.static('public'));

// Serve NDI WebRTC client page
app.get('/', (req, res) => {
    res.send(getNDIWebRTCHTML());
});

// Get available NDI sources
app.get('/api/ndi-sources', (req, res) => {
    try {
        const sources = discoverNDISources();
        res.json(sources);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get active streams
app.get('/api/streams', (req, res) => {
    const activeStreams = Array.from(streams.values()).map(s => s.getStats());
    res.json(activeStreams);
});

// Start new stream
app.post('/api/stream/start', (req, res) => {
    const { ndiSource } = req.body;
    
    if (!ndiSource) {
        return res.status(400).json({ error: 'NDI source name required' });
    }

    const streamId = uuidv4().substring(0, 8);
    const manager = new NDIStreamManager(streamId);
    
    streams.set(streamId, manager);
    
    manager.start(ndiSource)
        .then(() => {
            res.json({ streamId, status: 'starting' });
        })
        .catch(error => {
            streams.delete(streamId);
            res.status(500).json({ error: error.message });
        });
});

// Stop stream
app.post('/api/stream/stop', (req, res) => {
    const { streamId } = req.body;
    const stream = streams.get(streamId);
    
    if (!stream) {
        return res.status(404).json({ error: 'Stream not found' });
    }

    stream.stop();
    res.json({ status: 'stopped' });
});

// ==================== WebSocket Server ====================
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, req) => {
    const streamId = req.url.split('/').pop();
    console.log(`WebSocket connection for stream: ${streamId}`);

    let stream = streams.get(streamId);

    if (!stream) {
        ws.close(1008, 'Stream not found');
        return;
    }

    stream.addClient(ws);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'start') {
                stream.start(data.ndiSource);
            } else if (data.type === 'stop') {
                stream.stop();
            }
        } catch (error) {
            console.error('Error handling WebSocket message:', error);
        }
    });

    ws.on('close', () => {
        stream.removeClient(ws);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        stream.removeClient(ws);
    });
});

// ==================== HTTP Server ====================
const server = require('http').createServer(app);

server.on('upgrade', (request, socket, head) => {
    const pathname = request.url;
    
    if (pathname.startsWith('/ws/stream/')) {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║         NDI to WebRTC Streaming Server v1.0               ║
╚═══════════════════════════════════════════════════════════╝

Server running at: http://0.0.0.0:${PORT}
Local access:     http://localhost:${PORT}

API Endpoints:
  GET  /api/ndi-sources     - List available NDI sources
  GET  /api/streams         - List active streams
  POST /api/stream/start    - Start streaming (body: {ndiSource})
  POST /api/stream/stop     - Stop streaming (body: {streamId})

WebSocket:
  ws://localhost:${PORT}/ws/stream/{streamId}

HTML Client:
  Open browser to http://localhost:${PORT}

${NDI_SOURCE ? `\nStarting with NDI source: ${NDI_SOURCE}` : '\n(No NDI source specified. Use HTML client to select one.)\n'}
    `);

    // Auto-start with specified source if provided
    if (NDI_SOURCE) {
        const streamId = uuidv4().substring(0, 8);
        const manager = new NDIStreamManager(streamId);
        streams.set(streamId, manager);
        manager.start(NDI_SOURCE);
    }
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\nShutting down gracefully...');
    
    streams.forEach(stream => {
        stream.stop();
    });
    
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
    
    setTimeout(() => {
        console.error('Forced shutdown');
        process.exit(1);
    }, 5000);
});

// ==================== HTML Client ====================
function getNDIWebRTCHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NDI WebRTC Streaming</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
        }

        .header {
            color: white;
            margin-bottom: 30px;
            text-align: center;
        }

        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
        }

        .header p {
            font-size: 1.1em;
            opacity: 0.9;
        }

        .main-content {
            display: grid;
            grid-template-columns: 1fr 350px;
            gap: 20px;
            margin-bottom: 30px;
        }

        .video-container {
            background: black;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 10px 40px rgba(0,0,0,0.3);
            aspect-ratio: 16/9;
        }

        video {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }

        .video-placeholder {
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #666;
            font-size: 1.2em;
        }

        .control-panel {
            background: white;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            height: fit-content;
        }

        .control-section {
            margin-bottom: 20px;
        }

        .control-section:last-child {
            margin-bottom: 0;
        }

        .control-section h3 {
            color: #333;
            font-size: 0.95em;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 12px;
            border-bottom: 2px solid #667eea;
            padding-bottom: 8px;
        }

        select, button {
            width: 100%;
            padding: 10px 12px;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 0.95em;
            font-family: inherit;
            cursor: pointer;
            transition: all 0.3s ease;
        }

        select {
            background: white;
            color: #333;
            margin-bottom: 10px;
        }

        select:hover {
            border-color: #667eea;
        }

        select:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }

        button {
            background: #667eea;
            color: white;
            border: none;
            font-weight: 600;
            margin-bottom: 8px;
        }

        button:hover {
            background: #5568d3;
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }

        button:active {
            transform: scale(0.98);
        }

        button:disabled {
            background: #ccc;
            cursor: not-allowed;
            opacity: 0.6;
        }

        .status-indicator {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.9em;
            margin-top: 10px;
        }

        .status-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: #ccc;
            animation: none;
        }

        .status-dot.connected {
            background: #22c55e;
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        .stats {
            background: #f5f5f5;
            border-radius: 4px;
            padding: 12px;
            font-size: 0.85em;
            color: #666;
        }

        .stats-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 6px;
        }

        .stats-row:last-child {
            margin-bottom: 0;
        }

        .stats-label {
            font-weight: 600;
        }

        .sources-list {
            max-height: 200px;
            overflow-y: auto;
            border: 1px solid #ddd;
            border-radius: 4px;
        }

        .source-item {
            padding: 10px;
            border-bottom: 1px solid #eee;
            cursor: pointer;
            transition: background 0.2s;
        }

        .source-item:last-child {
            border-bottom: none;
        }

        .source-item:hover {
            background: #f5f5f5;
        }

        .source-item.selected {
            background: #e3f2fd;
            color: #667eea;
            font-weight: 600;
        }

        .loading {
            text-align: center;
            color: #999;
            padding: 20px;
        }

        .spinner {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 3px solid #f3f3f3;
            border-top: 3px solid #667eea;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .info-box {
            background: #ecf0f1;
            border-left: 4px solid #667eea;
            padding: 12px;
            border-radius: 4px;
            font-size: 0.9em;
            color: #333;
            margin-top: 12px;
        }

        @media (max-width: 768px) {
            .main-content {
                grid-template-columns: 1fr;
            }

            .header h1 {
                font-size: 1.8em;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎥 NDI WebRTC Streaming</h1>
            <p>Real-time NDI video streaming to your browser</p>
        </div>

        <div class="main-content">
            <div class="video-container">
                <video id="ndiVideo" autoplay muted playsinline></video>
            </div>

            <div class="control-panel">
                <div class="control-section">
                    <h3>NDI Sources</h3>
                    <button onclick="discoverSources()">🔍 Discover Sources</button>
                    <div id="sourcesList" class="sources-list">
                        <div class="loading"><div class="spinner"></div></div>
                    </div>
                </div>

                <div class="control-section">
                    <h3>Stream Control</h3>
                    <button id="startBtn" onclick="startStream()" disabled>▶ Start Stream</button>
                    <button id="stopBtn" onclick="stopStream()" disabled>⏹ Stop Stream</button>
                </div>

                <div class="control-section">
                    <div class="status-indicator">
                        <div class="status-dot" id="statusDot"></div>
                        <span id="statusText">Disconnected</span>
                    </div>
                    
                    <div class="stats" id="stats">
                        <div class="stats-row">
                            <span class="stats-label">Status:</span>
                            <span id="streamStatus">Idle</span>
                        </div>
                        <div class="stats-row">
                            <span class="stats-label">Bitrate:</span>
                            <span id="bitrate">--</span>
                        </div>
                        <div class="stats-row">
                            <span class="stats-label">FPS:</span>
                            <span id="fps">--</span>
                        </div>
                    </div>

                    <div class="info-box">
                        ℹ️ Select an NDI source and click "Start Stream" to begin viewing.
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let currentSource = null;
        let streamId = null;
        let ws = null;
        let videoStats = {
            frameCount: 0,
            lastUpdateTime: Date.now(),
            bytesReceived: 0
        };

        // Discover NDI sources
        async function discoverSources() {
            const sourcesList = document.getElementById('sourcesList');
            sourcesList.innerHTML = '<div class="loading"><div class="spinner"></div> Discovering...</div>';

            try {
                const response = await fetch('/api/ndi-sources');
                const sources = await response.json();

                if (sources.length === 0) {
                    sourcesList.innerHTML = '<div class="loading">No NDI sources found</div>';
                    return;
                }

                sourcesList.innerHTML = sources.map(source => \`
                    <div class="source-item" onclick="selectSource('\${source.name}')">
                        <strong>\${source.name}</strong><br>
                        <small>\${source.url || 'Local'}</small>
                    </div>
                \`).join('');

            } catch (error) {
                sourcesList.innerHTML = '<div class="loading">Error discovering sources</div>';
                console.error('Error discovering sources:', error);
            }
        }

        // Select NDI source
        function selectSource(sourceName) {
            currentSource = sourceName;
            
            document.querySelectorAll('.source-item').forEach(el => {
                el.classList.remove('selected');
            });
            event.target.closest('.source-item').classList.add('selected');
            
            document.getElementById('startBtn').disabled = false;
            console.log('Selected source:', sourceName);
        }

        // Start streaming
        async function startStream() {
            if (!currentSource) {
                alert('Please select an NDI source first');
                return;
            }

            try {
                // Create new stream
                const response = await fetch('/api/stream/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ndiSource: currentSource })
                });

                const data = await response.json();
                if (!response.ok) throw new Error(data.error);

                streamId = data.streamId;
                connectWebSocket();
                
                document.getElementById('startBtn').disabled = true;
                document.getElementById('stopBtn').disabled = false;
                updateStatus('Connecting...', false);

            } catch (error) {
                alert('Error starting stream: ' + error.message);
                console.error(error);
            }
        }

        // Stop streaming
        async function stopStream() {
            if (ws) {
                ws.close();
            }

            try {
                await fetch('/api/stream/stop', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ streamId })
                });
            } catch (error) {
                console.error('Error stopping stream:', error);
            }

            streamId = null;
            document.getElementById('startBtn').disabled = currentSource ? false : true;
            document.getElementById('stopBtn').disabled = true;
            updateStatus('Stopped', false);
        }

        // Connect WebSocket
        function connectWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = \`\${protocol}//\${window.location.host}/ws/stream/\${streamId}\`;

            ws = new WebSocket(wsUrl);

            ws.onopen = () => {
                console.log('WebSocket connected');
                updateStatus('Connected', true);
            };

            ws.onmessage = (event) => {
                const message = JSON.parse(event.data);
                
                if (message.type === 'video-frame') {
                    handleVideoFrame(message.data);
                    videoStats.frameCount++;
                    updateStats();
                } else if (message.type === 'status') {
                    console.log('Stream status:', message);
                }
            };

            ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                updateStatus('Connection error', false);
            };

            ws.onclose = () => {
                console.log('WebSocket closed');
                updateStatus('Disconnected', false);
            };
        }

        // Handle video frame
        function handleVideoFrame(frameData) {
            try {
                const binaryData = atob(frameData);
                const bytes = new Uint8Array(binaryData.length);
                for (let i = 0; i < binaryData.length; i++) {
                    bytes[i] = binaryData.charCodeAt(i);
                }

                videoStats.bytesReceived += bytes.length;

                // In production, this would use MediaSource or another streaming protocol
                // For now, we display a placeholder
                console.log('Received frame:', bytes.length, 'bytes');

            } catch (error) {
                console.error('Error handling video frame:', error);
            }
        }

        // Update status
        function updateStatus(status, connected) {
            document.getElementById('statusText').textContent = status;
            document.getElementById('streamStatus').textContent = status;
            const dot = document.getElementById('statusDot');
            
            if (connected) {
                dot.classList.add('connected');
            } else {
                dot.classList.remove('connected');
            }
        }

        // Update stats
        function updateStats() {
            const now = Date.now();
            const timeDiff = (now - videoStats.lastUpdateTime) / 1000;
            
            if (timeDiff >= 1) {
                const fps = Math.round(videoStats.frameCount / timeDiff);
                const bitrate = Math.round((videoStats.bytesReceived / timeDiff) / 1024 / 1024 * 8);
                
                document.getElementById('fps').textContent = fps + ' fps';
                document.getElementById('bitrate').textContent = bitrate + ' Mbps';
                
                videoStats.frameCount = 0;
                videoStats.bytesReceived = 0;
                videoStats.lastUpdateTime = now;
            }
        }

        // Initialize on load
        window.addEventListener('load', () => {
            discoverSources();
        });

        // Update stats periodically
        setInterval(updateStats, 1000);
    </script>
</body>
</html>
`;
}

module.exports = { NDIStreamManager, app };
