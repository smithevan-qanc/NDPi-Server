/**
 * NDI Stream Manager Module
 * 
 * Manages NDI stream proxying from Python FastAPI backend
 * Handles stream lifecycle and client WebSocket connections
 */

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const http = require('http');

class NDIStreamManager extends EventEmitter {
    constructor(streamId, pythonBackendUrl = 'http://127.0.0.1:5000') {
        super();
        
        this.id = streamId;
        this.pythonBackendUrl = pythonBackendUrl;
        this.clients = new Set();
        this.isRunning = false;
        this.startTime = null;
        this.frameCount = 0;
        this.bandwidth = 0;
        this.lastFrameTime = Date.now();
        this.currentSource = null;
        this.mjpegRequest = null;
    }

    /**
     * Start streaming from the Python backend
     */
    async start(ndiSourceName) {
        if (this.isRunning) {
            console.log(`[${this.id}] Stream already running`);
            return;
        }

        console.log(`[${this.id}] Starting NDI stream for: ${ndiSourceName}`);
        this.startTime = Date.now();
        this.currentSource = ndiSourceName;
        this.isRunning = true;

        try {
            // Tell Python backend to select this source
            await this.selectSourceOnBackend(ndiSourceName);
            
            // Start proxying MJPEG stream to connected clients
            this.startMJPEGProxy();
        } catch (error) {
            console.error(`[${this.id}] Failed to start stream:`, error);
            this.isRunning = false;
            throw error;
        }
    }

    /**
     * Select NDI source on Python backend
     */
    async selectSourceOnBackend(sourceName) {
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify({ name: sourceName });
            
            const options = {
                hostname: 'localhost',
                port: 5000,
                path: '/api/select',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        resolve(JSON.parse(data));
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    }
                });
            });

            req.on('error', reject);
            req.write(postData);
            req.end();
        });
    }

    /**
     * Start proxying MJPEG stream from Python backend to WebSocket clients
     */
    startMJPEGProxy() {
        const backendUrl = `${this.pythonBackendUrl}/mjpeg`;
        
        console.log(`[${this.id}] Connecting to MJPEG stream: ${backendUrl}`);

        const options = {
            hostname: 'localhost',
            port: 5000,
            path: '/mjpeg',
            method: 'GET'
        };

        this.mjpegRequest = http.request(options, (res) => {
            console.log(`[${this.id}] MJPEG connected: ${res.statusCode}`);
            
            let buffer = Buffer.alloc(0);
            const boundaryMarker = Buffer.from('\r\n--frame\r\n');

            res.on('data', (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                
                // Try to extract complete JPEG frames
                let boundaryPos;
                while ((boundaryPos = buffer.indexOf(boundaryMarker)) !== -1) {
                    const frameEnd = boundaryPos;
                    const frameData = buffer.slice(0, frameEnd);
                    buffer = buffer.slice(boundaryPos + boundaryMarker.length);
                    
                    // Extract just the JPEG data (skip headers)
                    const headerEnd = frameData.indexOf('\r\n\r\n');
                    if (headerEnd !== -1) {
                        const jpegData = frameData.slice(headerEnd + 4);
                        this.frameCount++;
                        this.bandwidth += jpegData.length;
                        
                        this.broadcastToClients({
                            type: 'video-frame',
                            data: jpegData.toString('base64'),
                            timestamp: Date.now(),
                            frameCount: this.frameCount
                        });
                    }
                }
            });

            res.on('end', () => {
                console.log(`[${this.id}] MJPEG stream ended`);
                if (this.isRunning) {
                    console.log(`[${this.id}] Reconnecting to MJPEG stream...`);
                    setTimeout(() => this.startMJPEGProxy(), 2000);
                }
            });

            res.on('error', (error) => {
                console.error(`[${this.id}] MJPEG stream error:`, error);
                if (this.isRunning) {
                    setTimeout(() => this.startMJPEGProxy(), 2000);
                }
            });
        });

        this.mjpegRequest.on('error', (error) => {
            console.error(`[${this.id}] Failed to connect to MJPEG stream:`, error);
            if (this.isRunning) {
                setTimeout(() => this.startMJPEGProxy(), 2000);
            }
        });

        this.mjpegRequest.end();
    }

    /**
     * Broadcast message to all connected WebSocket clients
     */
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

    /**
     * Add a WebSocket client to this stream
     */
    addClient(ws) {
        this.clients.add(ws);
        console.log(`[${this.id}] Client connected. Total clients: ${this.clients.size}`);
        
        // Send current stream status
        ws.send(JSON.stringify({
            type: 'status',
            streamId: this.id,
            source: this.currentSource,
            isRunning: this.isRunning,
            frameCount: this.frameCount,
            bandwidth: this.bandwidth,
            clientCount: this.clients.size
        }));
    }

    /**
     * Remove a WebSocket client from this stream
     */
    removeClient(ws) {
        this.clients.delete(ws);
        console.log(`[${this.id}] Client disconnected. Total clients: ${this.clients.size}`);
        
        // Auto-stop stream if no more clients
        if (this.clients.size === 0) {
            this.stop();
        }
    }

    /**
     * Stop the stream
     */
    stop() {
        if (!this.isRunning) return;
        
        console.log(`[${this.id}] Stopping NDI stream`);
        this.isRunning = false;

        // Kill MJPEG connection
        if (this.mjpegRequest) {
            this.mjpegRequest.destroy();
            this.mjpegRequest = null;
        }

        // Notify all clients
        this.broadcastToClients({
            type: 'status',
            streamId: this.id,
            isRunning: false
        });

        this.emit('stopped', this.id);
    }

    /**
     * Get stream statistics
     */
    getStats() {
        return {
            id: this.id,
            source: this.currentSource,
            isRunning: this.isRunning,
            clientCount: this.clients.size,
            frameCount: this.frameCount,
            bandwidth: this.bandwidth,
            uptime: this.isRunning ? Date.now() - this.startTime : 0
        };
    }
}

module.exports = NDIStreamManager;
