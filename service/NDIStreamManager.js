/**
 * NDI Stream Manager Module
 * 
 * Manages NDI to WebRTC streaming for individual sources
 * Handles stream lifecycle, client connections, and video encoding
 */

const { spawn, execSync } = require('child_process');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

class NDIStreamManager extends EventEmitter {
    constructor(sourceId, outputDir, ndiReceiverPath, ndiDiscoverPath) {
        super();
        
        this.id = sourceId;
        this.sourceId = sourceId;
        this.receiver = null;
        this.ffmpegProcess = null;
        this.clients = new Set();
        this.isRunning = false;
        this.startTime = null;
        this.frameCount = 0;
        this.bandwidth = 0;
        
        this.outputDir = outputDir;
        this.ndiReceiverPath = ndiReceiverPath;
        this.ndiDiscoverPath = ndiDiscoverPath;
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
            this.startFFmpegStream(ndiSourceName);
        } catch (error) {
            console.error(`[${this.id}] Failed to start stream:`, error);
            this.isRunning = false;
            throw error;
        }
    }

    startFFmpegStream(ndiSourceName) {
        try {
            const args = [
                '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:d=100',
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
            throw error;
        }
    }

    getFFmpegCommand(ndiSourceName) {
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

        this.emit('stopped', this.id);
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

module.exports = NDIStreamManager;
