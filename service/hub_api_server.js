const { EventEmitter } = require('events');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('node:child_process');
const os = require('node:os');
const NDIStreamManager = require('./NDIStreamManager');
const { v4: uuidv4 } = require('uuid');
const http_lib = require('http');
const bonjour = require('bonjour')();


// Python NDI server configuration
const NDI_SERVER_HOST = process.env.NDI_SERVER_HOST || '127.0.0.1';
const NDI_SERVER_PORT = process.env.NDI_SERVER_PORT || 3081;
const NDI_SERVER_URL = `http://${NDI_SERVER_HOST}:${NDI_SERVER_PORT}`;


class NDPiCommandServer_Client extends EventEmitter {
    constructor(fsData) {
        super();

        this.settings = fsData;
        this.port = fsData.get('local_port_number_api') || process.env.PORT_API || 3080

        this.closing = false;

        this.ws_serv_ndi_streams = null;
        this.ws_conn_ndi_streams = new Map();

        this.pythonBackendUrl = 'http://127.0.0.1:5000';

        /**
         *  NDI Source Discovery WebSocket ( /ws/sources )
         *  ------------------------------------------------
         *  Long-running `ndpi_discover` subprocess (same binary Client
         *  devices use — Client__v3_1_0/service/client_api_server.js
         *  `startDiscovery()`) that pushes the live NDI source list to
         *  connected browser clients as it changes, rather than polling.
         *  The current list itself is NOT kept here — it's written straight
         *  through to `this.settings` (hub_fs.js, `discovered-ndi-sources.json`)
         *  on every change, and every reader (this socket's initial send,
         *  `getNDISources()`, `/api/ndi-sources`) reads it back from there.
         */
        this.discoveryExec = null;
        this.ws_serv_sources = null;
        this.ws_conn_sources = null;

        /**
         *  GUI WebSocket ( /ws )
         *  ---------------------
         *  Used by the Hub's own web dashboard (public/) for real-time
         *  updates: devices-update, groups-update, discovered-devices-update,
         *  ndi-sources, active-viewers, system-stats, heartbeat.
         */
        this.ws_serv_gui = null;
        this.ws_conn_gui = new Map(); // ws -> { accountId, accountName, connectedAt }
        this.activeViewers = new Map(); // accountId -> { name, username, connectedAt }

        /**
         *  NDPi Client Device WebSocket ( /ws/client )
         *  --------------------------------------------
         *  NDPi Client devices connect OUT to the Hub on this endpoint
         *  (see Client__v3_1_0/service/clientServer_websocket.js). The Hub
         *  uses the same persistent connection to push commands back down
         *  to the device (set-source, show-overlay, shutdown-device, etc).
         */
        this.ws_serv_devices = null;
        this.deviceConnections = new Map(); // deviceId -> ws

        this.bonjourBrowser = null;

        this.heartbeatInterval = null;
        this.ndiSourceInterval = null;
        this.systemStatsInterval = null;
        this.deviceTimeoutInterval = null;

        this.App = null;    // express()
        this.Server = null; // http.createServer()
        this.Routes = null; // express.Router()

        // Broadcast collection changes from the Hub's data layer to GUI clients.
        fsData.on('clients-update', () => { this.broadcastDevices(`hub_fs.js( 'clients-update' )`); });
        fsData.on('groups-update', () => { this.broadcastToGUI({ type: 'groups-update', origin: `hub_fs.js( 'groups-update' )`, groups: this.settings.getGroups() }); });
        fsData.on('discovered-clients-update', () => { this.broadcastToGUI({ type: 'discovered-devices-update', origin: `hub_fs.js( 'discovered-clients-update' )`, devices: this.settings.getDiscoveredClients() }); });

        this.start();
    }

    start() {
        this.App = express();
        this.App.use(express.json());
        this.App.use(
            express.static(path.join(__dirname, '..', 'public'), {
                setHeaders: (res, path) => {
                    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
                }
            })
        );
        this.App.use(
            '/assets',
            express.static(path.join(__dirname, '..', 'assets'), {
                setHeaders: (res, path) => {
                    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private')
                }
            })
        );
        this.App.use(
            '/scripts',
            express.static(path.join(__dirname, '..', 'public', '01-scripts'), {
                setHeaders: (res, path) => {
                    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private')
                }
            })
        );
        this.App.use(
            '/media',
            express.static(path.join(__dirname, '..', 'assets', 'gui', 'media'), {
                setHeaders: (res, path) => {
                    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private')
                }
            })
        );

        this.__ws_NDIStreams();
        this.__ws_Sources();
        this.__ws_Gui();
        this.__ws_Devices();
        this.__Routers();
        this.startMdnsDiscovery();
        this.startBroadcastIntervals();
        this.startDeviceTimeoutMonitor();
    }

    /**
     *      NDI Streams - WebSocket Connection Handler
     */
    __ws_NDIStreams() {
        this.ws_serv_ndi_streams = new WebSocket.Server({ noServer: true });
        this.ws_serv_ndi_streams.on('connection', (ws, request) =>{
            const streamId = request.url.split('/').pop();
            console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, `NDI Stream [${streamId}] WebSocket connection ADDED.`);

            let stream = this.ws_conn_ndi_streams.get(streamId);

            if (!stream) {
                console.error(`[ ${path.basename(__filename).split('.')[0]} ]`, `Stream ${streamId} not found`);
                ws.close(1008, 'Stream not found');
                return;
            }

            stream.addClient(ws);

            ws.onmessage = (event) => {
                // No commands expected from browser - stream is managed via REST API
                // This handler is here for future extensibility
            };

            ws.onerror = (error) => {
                console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, `NDI Stream [${streamId}] WebSocket Server`, error);
            };

            ws.onclose = () => {
                stream.removeClient(ws);
                console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, `NDI Stream [${streamId}] WebSocket connection REMOVED.`);
            };
        });
    }

    /**
     *      NDI Source - WebSocket Connection Handler ( /ws/sources )
     */
    __ws_Sources() {
        this.ws_serv_sources = new WebSocket.Server({ noServer: true });
        this.ws_conn_sources = new Set();

        this.ws_serv_sources.on('connection', (ws) =>{
            console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'NDI Source WebSocket connection ADDED.');

            this.ws_conn_sources.add(ws);

            const knownSources = this.settings.getDiscoveredSources();
            if (Array.isArray(knownSources) && knownSources.length > 0)
            { ws.send(JSON.stringify(knownSources)); }

            if (!this.discoveryExec)
            { this.startDiscovery(); }

            ws.onerror = (error) => {
                console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, `NDI Source WebSocket Server`, error);
            };

            ws.onclose = async () => {
                this.ws_conn_sources.delete(ws);
                console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'NDI Source WebSocket connection REMOVED.');
            };
        });
    }

    /**
     *      NDI Source Discovery — spawns the long-running `ndpi_discover`
     *      binary (same one Client__v3_1_0's `client_api_server.js`
     *      `startDiscovery()` uses) and streams updates to `/ws/sources`
     *      clients as they arrive.
     */
    startDiscovery() {
        const discoveryPath = path.join(__dirname, '..', 'ndi_receiver_v3__NDI6');
        const programName = './ndpi_discover';

        console.info(`[ ${path.basename(__filename).split('.')[0]} ] Starting NDI Source Discovery.`);

        this.discoveryExec = null;

        // A missing/wrong-arch/non-executable binary makes spawn() throw
        // *synchronously* (not just an async 'error' event). Since
        // getNDISources() calls this from inside an async function, an
        // uncaught synchronous throw here rejects that promise; Express 4
        // does not catch async route-handler rejections, so it would reach
        // process.on('unhandledRejection') and take the whole Hub down.
        // Guard it so a broken discovery binary only disables source
        // discovery, not the entire Hub.
        try
        {
            this.discoveryExec = spawn(programName, {
                cwd: discoveryPath
            });
        }
        catch (error)
        {
            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] NDI Discovery ('${programName}') failed to start.`, error.message);
            this.discoveryExec = null;
            return;
        }

        this.discoveryExec.on('error', (error) => {
            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] NDI Discovery ('${programName}') failed to start.`, error.message);
            this.discoveryExec = null;
        });

        this.discoveryExec.stdout.on('data', (data) => {
            const output = data.toString() || '[]';
            try
            {
                const sources = JSON.parse(output);
                if (Array.isArray(sources))
                {
                    this.settings.setDiscoveredSources(sources);
                    this.ws_conn_sources.forEach((ws) => {
                        ws.send(JSON.stringify(sources));
                    });
                }
            }
            catch {}
        });
    }

    async _tryCloseDiscovery() {
        return new Promise((resolve) => {
            if (!this.discoveryExec)
            {
                console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ] NDPi NDI® Discovery - Never Started`);
                resolve();
                return;
            }

            if (!this.discoveryExec.killed)
            {
                this.discoveryExec.once('exit', () => {
                    console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ] NDPi NDI® Discovery`);
                    resolve();
                });

                console.info(`[ CLOSING ][ ${path.basename(__filename).split('.')[0]} ] NDPi NDI® Discovery`);
                this.discoveryExec.kill('SIGTERM');

                setTimeout(() => {
                    if (!this.discoveryExec.killed)
                    {
                        console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ] NDPi NDI® Discovery`);
                        resolve();
                    }
                }, 2000);
            }
            else
            {
                console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ] NDPi NDI® Discovery`);
                resolve();
            }
        });
    }

    /**
     *      Hub Dashboard GUI - WebSocket Connection Handler ( /ws )
     *      Used by the Hub's web dashboard for real-time device/group updates.
     */
    __ws_Gui() {
        this.ws_serv_gui = new WebSocket.Server({ noServer: true });

        this.ws_serv_gui.on('connection', (ws) => {
            console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'GUI WebSocket connection ADDED.');

            const clientInfo = { accountId: null, accountName: 'Anonymous', connectedAt: Date.now() };
            this.ws_conn_gui.set(ws, clientInfo);

            try
            {
                ws.send(JSON.stringify({ type: 'connected', message: 'Connected to NDPi Monitor Hub' }));
            }
            catch {}

            ws.onmessage = (event) => {
                let message;
                try { message = JSON.parse(event.data); }
                catch (error) { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, 'GUI WebSocket message', error); return; }

                if (message.type === 'viewer-join')
                {
                    clientInfo.accountId = message.accountId;
                    clientInfo.accountName = message.accountName;

                    this.activeViewers.set(message.accountId, {
                        name: message.accountName,
                        username: message.username,
                        connectedAt: Date.now(),
                    });

                    this.broadcastViewers(`GUI ws message = 'viewer-join'`);
                }
                else if (message.type === 'viewer-leave')
                {
                    if (clientInfo.accountId)
                    {
                        this.activeViewers.delete(clientInfo.accountId);
                        this.broadcastViewers(`GUI ws message = 'viewer-leave'`);
                    }
                }
            };

            ws.onerror = (error) => {
                console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, 'GUI WebSocket Server', error);
            };

            ws.onclose = () => {
                if (clientInfo.accountId)
                {
                    this.activeViewers.delete(clientInfo.accountId);
                    this.broadcastViewers('GUI ws close');
                }
                this.ws_conn_gui.delete(ws);
                console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'GUI WebSocket connection REMOVED.');
            };
        });
    }

    broadcastToGUI(message = {}) {
        const data = JSON.stringify(message);
        this.ws_conn_gui.forEach((info, ws) => {
            if (ws.readyState === WebSocket.OPEN)
            {
                try { ws.send(data); }
                catch {}
            }
        });
    }

    broadcastViewers(origin = '') {
        this.broadcastToGUI({
            type: 'active-viewers',
            origin,
            viewers: Array.from(this.activeViewers.values()),
        });
    }

    broadcastDevices(origin = '') {
        this.broadcastToGUI({
            type: 'devices-update',
            origin,
            devices: this.settings.getClients(),
        });
    }

    /**
     *      NDPi Client Devices - WebSocket Connection Handler ( /ws/client )
     *      Client__v3_1_0/service/clientServer_websocket.js connects here.
     *      The Client pushes periodic 'client-status' messages, and the Hub
     *      uses the same open connection to push commands back down.
     */
    __ws_Devices() {
        this.ws_serv_devices = new WebSocket.Server({ noServer: true });

        this.ws_serv_devices.on('connection', (ws) => {
            console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'NDPi Client device connection ADDED.');

            let deviceId = null;

            ws.onmessage = (event) => {
                let message;
                try { message = JSON.parse(event.data); }
                catch (error) { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, 'Device WebSocket message', error); return; }

                if (message.type === 'client-status')
                {
                    deviceId = message.deviceId;
                    if (!deviceId) return;

                    this.deviceConnections.set(deviceId, ws);

                    this.settings.upsertClient(deviceId, {
                        deviceName: message.deviceName || this.settings.getClient(deviceId)?.deviceName || deviceId,
                        ip: message.ip || this.settings.getClient(deviceId)?.ip,
                        status: 'online',
                        currentSource: message.currentSource || 'None',
                        displayMode: message.displayMode || 'overlay',
                        streamStatus: message.streamStatus || 'unknown',
                        ndiInfo: message.ndiInfo || null,
                        systemStats: message.systemStats || null,
                        // Full remote-settings snapshot (mirrors what Client__v3_1_0's
                        // own local `/ws/system` UI receives) so the Hub dashboard can
                        // offer the same per-device controls (settings editor, overlay
                        // upload, update checks, etc).
                        settings: Array.isArray(message.settings) ? message.settings : (this.settings.getClient(deviceId)?.settings || null),
                        lastSeen: new Date().toISOString(),
                        lastStatusUpdate: new Date().toISOString(),
                    });

                    // The device is no longer merely "discovered" once it starts reporting status.
                    this.settings.removeDiscoveredClient(deviceId);
                }
                else if (message.type === 'ping')
                {
                    try { ws.send(JSON.stringify({ type: 'pong' })); }
                    catch {}
                }
            };

            ws.onerror = (error) => {
                console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, 'NDPi Client device connection', error);
            };

            ws.onclose = () => {
                console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, `NDPi Client device connection REMOVED. ${deviceId ? `(${deviceId})` : ''}`);
                if (deviceId)
                {
                    this.deviceConnections.delete(deviceId);
                    const client = this.settings.getClient(deviceId);
                    if (client)
                    {
                        client.status = 'offline';
                        this.settings.upsertClient(deviceId, client);
                    }
                }
            };
        });
    }

    /**
     * Send a command to a connected NDPi Client device over its persistent
     * `/ws/client` connection. Command 'type' values must match what
     * Client__v3_1_0/service/functions.js `processCommand()` understands
     * (e.g. 'set-source', 'show-overlay', 'show-blank', 'shutdown-device',
     * 'reboot-device', 'rename-device', 'send-cec', 'set-setting').
     */
    sendCommandToClient(deviceId, command = {}) {
        return new Promise((resolve, reject) => {
            const ws = this.deviceConnections.get(deviceId);

            if (!ws || ws.readyState !== WebSocket.OPEN)
            { return reject(new Error('Device not connected')); }

            try
            {
                ws.send(JSON.stringify(command));
                resolve({ success: true, message: 'Command sent' });
            }
            catch (error)
            { reject(error); }
        });
    }

    /**
     *      mDNS Discovery of NDPi Client devices on the network
     */
    startMdnsDiscovery() {
        console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'Starting NDPi Client device discovery (mDNS).');

        this.bonjourBrowser = bonjour.find({ type: 'ndpi-monitor-client' });

        this.bonjourBrowser.on('up', (service) => {
            const deviceId = service.txt?.deviceId || service.txt?.deviceid;
            const deviceName = service.txt?.deviceName || service.txt?.devicename || 'NDPi Client';
            const ip = service.txt?.ip || service.addresses?.[0] || service.host;
            const commandPort = service.txt?.commandPort || service.txt?.commandport || service.port;

            if (!deviceId)
            {
                console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'Discovered NDPi Client without a device ID.');
                return;
            }

            console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, `Discovered: ${deviceName} (${deviceId}) at ${ip}:${commandPort}`);

            this.settings.upsertDiscoveredClient(deviceId, {
                deviceName,
                ip,
                commandPort,
                lastSeen: new Date().toISOString(),
            });

            // Update IP/status of already-saved devices too.
            const existingClient = this.settings.getClient(deviceId);
            if (existingClient)
            {
                this.settings.upsertClient(deviceId, {
                    ip,
                    status: 'online',
                    lastSeen: new Date().toISOString(),
                });
            }
        });

        this.bonjourBrowser.on('down', (service) => {
            const deviceId = service.txt?.deviceId || service.txt?.deviceid;
            if (!deviceId) return;

            const existingClient = this.settings.getClient(deviceId);
            if (existingClient)
            {
                this.settings.upsertClient(deviceId, {
                    status: 'offline',
                    lastSeen: new Date().toISOString(),
                });
            }
        });
    }

    stopMdnsDiscovery() {
        if (this.bonjourBrowser)
        {
            try { this.bonjourBrowser.stop(); }
            catch {}
            this.bonjourBrowser = null;
        }
    }

    /**
     *      Periodic broadcasts to the Hub Dashboard GUI
     */
    startBroadcastIntervals() {
        this.heartbeatInterval = setInterval(() => {
            this.broadcastToGUI({ type: 'heartbeat', origin: 'interval 10s', timestamp: Date.now() });
        }, 10000);

        this.ndiSourceInterval = setInterval(async () => {
            try
            {
                const sources = await this.getNDISources();
                this.broadcastToGUI({ type: 'ndi-sources', origin: 'interval 10s', sources });
            }
            catch (error)
            { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, 'NDI source discovery', error); }
        }, 10000);

        this.systemStatsInterval = setInterval(() => {
            this.broadcastToGUI({ type: 'system-stats', origin: 'interval 5s', stats: this.hubSystemStats() });
        }, 5000);
    }

    /**
     *      Mark devices offline if they haven't reported status in a while.
     */
    startDeviceTimeoutMonitor(minutesInactive = 1) {
        this.deviceTimeoutInterval = setInterval(() => {
            const now = new Date();
            this.settings.getClients().forEach((client) => {
                if (!client.lastSeen) return;
                const minutesSinceLastSeen = (now - new Date(client.lastSeen)) / 1000 / 60;
                if (minutesSinceLastSeen > minutesInactive && client.status !== 'offline')
                { this.settings.upsertClient(client.deviceId, { status: 'offline' }); }
            });
        }, 20000);
    }

    /**
     *      NDI Source Discovery, merged with the Hub's favorited-sources
     *      list. Reads the last-known source list straight from hub_fs.js
     *      (`discovered-ndi-sources.json`), which the long-running
     *      `ndpi_discover` process (`startDiscovery()`) keeps up to date —
     *      no per-request exec. The old `./ndi-discover` binary this used
     *      to shell out to is no longer functional.
     */
    async getNDISources() {
        if (!this.discoveryExec)
        { this.startDiscovery(); }

        const knownSources = this.settings.getDiscoveredSources();
        const sources = Array.isArray(knownSources)
            ? knownSources.map((src) => ({ ...src }))
            : [];

        const favoritedSources = this.settings.getFavoritedSources();
        sources.forEach((src) => { src.favorite = false; });

        const mergedSources = [];
        const usedFavoritedIndices = new Set();

        for (const discoveredSource of sources)
        {
            const exactMatchIndex = favoritedSources.findIndex((fav) => fav.name === discoveredSource.name && fav.url === discoveredSource.url);

            if (exactMatchIndex !== -1)
            {
                mergedSources.push({ ...favoritedSources[exactMatchIndex], favorite: true });
                usedFavoritedIndices.add(exactMatchIndex);
            }
            else
            {
                const partialMatchIndex = favoritedSources.findIndex((fav) => fav.name === discoveredSource.name || fav.url === discoveredSource.url);
                if (partialMatchIndex !== -1)
                {
                    discoveredSource.favorite = true;
                    mergedSources.push(discoveredSource);
                    usedFavoritedIndices.add(partialMatchIndex);
                }
                else
                { mergedSources.push(discoveredSource); }
            }
        }

        favoritedSources.forEach((fav, index) => {
            if (!usedFavoritedIndices.has(index))
            { mergedSources.push({ ...fav, favorite: true }); }
        });

        mergedSources.sort((a, b) => (b.favorite - a.favorite));

        return mergedSources;
    }

    /**
     *      The Hub machine's own system stats (distinct from each Client
     *      device's `systemStats`, which arrives via `client-status`).
     */
    hubSystemStats() {
        try
        {
            const load = os.loadavg();
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMem = totalMem - freeMem;

            let cpuTemp = 0;
            const tempFile = '/sys/class/thermal/thermal_zone0/temp';
            if (fs.existsSync(tempFile))
            { cpuTemp = parseInt(fs.readFileSync(tempFile, 'utf8')) / 1000; }

            return {
                cpuUsage: Math.round(Math.min(load[0] / os.cpus().length, 1) * 1000) / 10,
                cpuTemp,
                memoryUsage: Math.round((usedMem / totalMem) * 100),
                memoryTotal: Math.round((totalMem / 1024 / 1024 / 1024) * 10) / 10,
                memoryUsed: Math.round((usedMem / 1024 / 1024 / 1024) * 10) / 10,
                diskUsage: 0,
                loadAverage: load,
                uptime: os.uptime(),
            };
        }
        catch (error)
        {
            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, 'hubSystemStats', error);
            return { cpuUsage: 0, cpuTemp: 0, memoryUsage: 0, memoryTotal: 0, memoryUsed: 0, diskUsage: 0, loadAverage: [0, 0, 0], uptime: 0 };
        }
    }

    getServerIP() {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces))
        {
            for (const iface of interfaces[name])
            {
                const isIPv4 = iface.family === 'IPv4' || iface.family === 4;
                if (isIPv4 && !iface.internal)
                { return iface.address; }
            }
        }
        return 'localhost';
    }

    __Routers() {
        this.Routes = express.Router();
        this.App.use(this.Routes);
        this.startServer();

        /**
         *  NDI Stream API (v1)
         *      WebRTC streaming for NDI sources via Python backend
         */
        this.Routes
        .route('/api/v1/ndi-sources')
        .get(async (req, res) => {
            console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'GET /api/v1/ndi-sources');
            try
            {
                const sources = await this._getPythonNDISources();
                res.status(200).json(sources);
            } 
            catch (error) 
            {
                console.error('Error discovering NDI sources:', error);
                res.status(500).json({ error: error.message });
            }
        });

        this.Routes
        .route('/api/v1/ndi-streams')
        .get(async (req, res) => {
            console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'GET /api/v1/ndi-streams');
            try
            {
                const activeStreams = Array.from(this.ws_conn_ndi_streams.values()).map(s => s.getStats());
                res.status(200).json(activeStreams);
            }
            catch (error)
            {
                console.error('Error getting NDI streams:', error);
                res.status(500).json({ error: error.message });
            }
        });

        this.Routes
        .route('/api/v1/ndi-stream/start')
        .post(async (req, res) => {
            console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'POST /api/v1/ndi-stream/start');
            try
            {
                const { ndiSource } = req.body;
                
                if (!ndiSource) {
                    return res.status(400).json({ error: 'NDI source name required' });
                }

                const streamId = uuidv4().substring(0, 8);
                const NDIStreamManager = require('./NDIStreamManager');
                const manager = new NDIStreamManager(streamId, this.pythonBackendUrl);
                
                // Start streaming from Python backend
                await manager.start(ndiSource);
                
                // Store manager in map for WebSocket handler to find it
                this.ws_conn_ndi_streams.set(streamId, manager);
                
                console.info(`[ ${path.basename(__filename).split('.')[0]} ] Stream started: ${streamId} (${ndiSource})`);
                res.status(200).json({ streamId, status: 'started', source: ndiSource });
            }
            catch (error)
            {
                console.error('Error starting NDI stream:', error);
                res.status(500).json({ error: error.message });
            }
        });

        this.Routes
        .route('/api/v1/ndi-stream/stop')
        .post(async (req, res) => {
            console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'POST /api/v1/ndi-stream/stop');
            try
            {
                const { streamId } = req.body;
                const stream = this.ws_conn_ndi_streams.get(streamId);
                
                if (!stream)
                { return res.status(404).json({ error: 'Stream not found' }); }

                stream.stop();
                this.ws_conn_ndi_streams.delete(streamId);
                res.status(200).json({ status: 'stopped' });
            }
            catch (error)
            {
                console.error('Error stopping NDI stream:', error);
                res.status(500).json({ error: error.message });
            }
        });

        this.Routes
        .route('/api/v1/ndi-stream/:streamId/mjpeg')
        .get(async (req, res) => {
            console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, `GET /api/v1/ndi-stream/${req.params.streamId}/mjpeg`);
            try
            {
                const streamId = req.params.streamId;
                const stream = this.ws_conn_ndi_streams.get(streamId);
                
                if (!stream)
                { return res.status(404).json({ error: 'Stream not found' }); }

                // Set MJPEG headers
                res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('Pragma', 'no-cache');

                // Proxy directly to Python backend MJPEG
                const http = require('http');
                const options = {
                    hostname: 'localhost',
                    port: 5000,
                    path: '/mjpeg',
                    method: 'GET'
                };

                const backendReq = http.request(options, (backendRes) => {
                    console.log(`[${streamId}] MJPEG proxy connected: ${backendRes.statusCode}`);
                    
                    backendRes.on('data', (chunk) => { res.write(chunk); });

                    backendRes.on('end', () => {
                        console.log(`[${streamId}] MJPEG proxy ended`);
                        res.end();
                    });

                    backendRes.on('error', (error) => {
                        console.error(`[${streamId}] MJPEG proxy error:`, error);
                        res.end();
                    });
                });

                backendReq.on('error', (error) => {
                    console.error(`[${streamId}] MJPEG proxy connection failed:`, error);
                    res.status(500).json({ error: error.message });
                });

                backendReq.end();

                // Clean up on disconnect
                req.on('close', () => {
                    console.log(`[${streamId}] MJPEG client disconnected`);
                    backendReq.destroy();
                });
            }
            catch (error)
            {
                console.error('Error proxying MJPEG stream:', error);
                res.status(500).json({ error: error.message });
            }
        });

        this.__RoutesAccounts();
        this.__RoutesDevices();
        this.__RoutesGroups();
        this.__RoutesRoku();
        this.__RoutesSystem();

        /**
         *  Generic page-serving routes. These MUST be registered after every
         *  specific /api/* route above — Express matches routes in
         *  registration order, and `/:page/:ext/` (two path segments) would
         *  otherwise shadow any two-segment API path (e.g. `/api/devices`,
         *  `/api/groups`, `/api/account`, `/api/resolution`) before it ever
         *  reaches its real handler.
         */
        this.Routes.route('/test-page').get((req, res) => {
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
            res.sendFile(path.join(__dirname, '..', 'ndi-webrtc-example.html'))
        });

        this.Routes
        .route('/')
        .get((req, res) => {
              // DEV
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
              // PROD
            // res.set('Cache-Control', 'public, max-age=86400, immutable');
            res.sendFile(path.join(__dirname, '..', 'public', 'dashboard', 'dashboard.html'));
        });

        this.Routes
        .route('/:page/:ext/')
        .get((req, res) => {
              // DEV
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
              // PROD
            // res.set('Cache-Control', 'public, max-age=86400, immutable');
            const page = req.params.page.toLowerCase() || 'dashboard';
            const ext = req.params.ext.toLowerCase() || 'html';
            res.sendFile(path.join(__dirname, '..', 'public', page, `${page}.${ext}`));
        });

        /**
         *  Every page in public/ links internally as `/<page>.html`
         *  (e.g. `window.location.href = '/devices.html'`), not the
         *  `/<page>/<ext>/` form above. Serve that shape directly so
         *  in-app navigation actually resolves.
         */
        this.Routes
        .route('/:page.html')
        .get((req, res) => {
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
            const page = req.params.page.toLowerCase() || 'dashboard';
            res.sendFile(path.join(__dirname, '..', 'public', page, `${page}.html`), (err) => {
                if (err) { res.status(404).sendFile(path.join(__dirname, '..', 'public', 'not-found', 'not-found.html')); }
            });
        });

        // Catch-all: anything else unmatched falls here.
        this.Routes.use((req, res) => {
            if (req.path.startsWith('/api/'))
            { return res.status(404).json({ error: 'Not found' }); }
            res.status(404).sendFile(path.join(__dirname, '..', 'public', 'not-found', 'not-found.html'));
        });
    }

    /**
     *  Account (User) Management API
     */
    __RoutesAccounts() {
        this.Routes
        .route('/api/account/create')
        .post((req, res) => {
            const { firstName, lastName, username, pin, isAdmin } = req.body;

            if (!firstName || !lastName || !username || !pin)
            { return res.status(400).json({ error: 'All fields required' }); }

            if (!/^\d{4}$|^\d{6}$/.test(pin))
            { return res.status(400).json({ error: 'PIN must be 4 or 6 digits' }); }

            if (this.settings.findAccountByUsername(username))
            { return res.status(400).json({ error: 'Username already exists' }); }

            const account = this.settings.createAccount({ firstName, lastName, username, pin, isAdmin: !!isAdmin });
            res.json({ success: true, accountId: account.id, message: 'Account created successfully' });
        });

        this.Routes
        .route('/api/account/signin')
        .post((req, res) => {
            const { pin } = req.body;
            if (!pin)
            { return res.status(400).json({ error: 'PIN required' }); }

            const account = this.settings.findAccountByPinHash(this.settings.hashPin(pin));
            if (!account)
            { return res.status(401).json({ error: 'Invalid PIN' }); }

            res.json({
                success: true,
                account: {
                    token: account.pinHash,
                    id: account.id,
                    firstName: account.firstName,
                    lastName: account.lastName,
                    username: account.username,
                    isAdmin: account.isAdmin || false,
                    firstTimeLogin: account.firstTimeLogin || false,
                },
            });
        });

        this.Routes
        .route('/api/account')
        .post((req, res) => {
            // Verify a token (used by auth.js `loadUserAccount()`)...
            if (req.body && req.body.token && !req.body.firstName)
            {
                const account = this.settings.findAccountByPinHash(req.body.token);
                if (!account)
                { return res.status(401).json({ success: false, message: 'Invalid Token' }); }

                return res.json({
                    success: true,
                    account: {
                        id: account.id,
                        firstName: account.firstName,
                        lastName: account.lastName,
                        username: account.username,
                        isAdmin: account.isAdmin || false,
                        firstTimeLogin: account.firstTimeLogin || false,
                        lastLogOn: new Date().toISOString(),
                    },
                });
            }

            // ...otherwise treat as an account creation request (used by users.html).
            const { firstName, lastName, username, pin, isAdmin } = req.body;

            if (!firstName || !lastName || !username || !pin)
            { return res.status(400).json({ error: 'All fields required' }); }

            if (!/^\d{4}$|^\d{6}$/.test(pin))
            { return res.status(400).json({ error: 'PIN must be 4 or 6 digits' }); }

            if (this.settings.findAccountByUsername(username))
            { return res.status(400).json({ error: 'Username already exists' }); }

            const account = this.settings.createAccount({ firstName, lastName, username, pin, isAdmin: !!isAdmin });
            res.json({ success: true, accountId: account.id, message: 'Account created successfully' });
        });

        this.Routes
        .route('/api/admin/accounts')
        .get((req, res) => {
            const accountList = this.settings.getAccounts().map((acc) => ({
                id: acc.id,
                firstName: acc.firstName,
                lastName: acc.lastName,
                username: acc.username,
                isAdmin: acc.isAdmin || false,
                createdAt: acc.createdAt,
            }));
            res.json({ accounts: accountList });
        });

        const handleAccountUpdate = (req, res) => {
            const account = this.settings.getAccount(req.params.id);
            if (!account)
            { return res.status(404).json({ error: 'Account not found' }); }

            const updates = req.body || {};

            if (updates.username && updates.username !== account.username && this.settings.findAccountByUsername(updates.username))
            { return res.status(400).json({ error: 'Username already taken' }); }

            if (updates.pin && !/^\d{4}$|^\d{5}$|^\d{6}$/.test(updates.pin))
            { return res.status(400).json({ error: 'PIN must be 4-6 digits' }); }

            if ('isAdmin' in updates)
            {
                const requestorId = updates.requestorId || req.headers['x-requestor-id'];
                const requestorAccount = this.settings.getAccount(requestorId);
                if (!requestorAccount || !requestorAccount.isAdmin)
                { return res.status(403).json({ error: 'Only admin users can manage admin privileges' }); }
                if (req.params.id === requestorId && updates.isAdmin === false)
                { return res.status(400).json({ error: 'Cannot remove your own admin privileges' }); }
            }

            const updated = this.settings.updateAccount(req.params.id, updates);

            res.json({
                success: true,
                message: 'Account updated successfully',
                account: {
                    id: updated.id,
                    firstName: updated.firstName,
                    lastName: updated.lastName,
                    username: updated.username,
                    isAdmin: updated.isAdmin || false,
                    createdAt: updated.createdAt,
                },
            });
        };

        this.Routes
        .route('/api/account/:id')
        .get((req, res) => {
            const account = this.settings.getAccount(req.params.id);
            if (!account)
            { return res.status(404).json({ error: 'Account not found' }); }
            res.json({
                id: account.id,
                firstName: account.firstName,
                lastName: account.lastName,
                username: account.username,
                isAdmin: account.isAdmin || false,
                createdAt: account.createdAt,
            });
        })
        .put(handleAccountUpdate)
        .delete((req, res) => {
            const account = this.settings.getAccount(req.params.id);
            if (!account)
            { return res.status(404).json({ error: 'Account not found' }); }

            const adminAccounts = this.settings.getAccounts().filter((acc) => acc.isAdmin);
            if (account.isAdmin && adminAccounts.length === 1)
            { return res.status(400).json({ error: 'Cannot delete the last admin account' }); }

            this.settings.deleteAccount(req.params.id);
            res.json({ success: true });
        });

        this.Routes
        .route('/api/account/:id/update')
        .post(handleAccountUpdate);
    }

    /**
     *  Device (NDPi Client) Management API
     */
    __RoutesDevices() {
        const deviceOut = (client) => ({
            id: client.deviceId,
            deviceId: client.deviceId,
            name: client.deviceName,
            ip: client.ip,
            status: client.status,
            currentSource: client.currentSource || 'None',
            displayMode: client.displayMode || 'overlay',
            streamStatus: client.streamStatus || 'unknown',
            ndiInfo: client.ndiInfo || null,
            systemStats: client.systemStats || null,
            lastSeen: client.lastSeen,
            lastStatusUpdate: client.lastStatusUpdate,
            group: client.groupName || client.group || 'Ungrouped',
            groupId: client.groupId || null,
            groupName: client.groupName || null,
            settings: client.settings || null,
        });

        this.Routes
        .route('/api/devices')
        .get((req, res) => {
            res.json({ devices: this.settings.getClients().map(deviceOut) });
        });

        this.Routes
        .route('/api/discovered-devices')
        .get((req, res) => {
            res.json({ devices: this.settings.getDiscoveredClients() });
        });

        this.Routes
        .route('/api/devices/forget-all')
        .post((req, res) => {
            const count = this.settings.deleteAllClients();
            res.json({ success: true, message: `Forgot ${count} device(s)` });
        });

        this.Routes
        .route('/api/device/:id?')
        .post((req, res) => {
            const deviceId = req.params.id || req.body.deviceId || req.body.id;
            const { deviceName, ip, name } = req.body;

            if (!deviceId)
            { return res.status(400).json({ error: 'Device ID required' }); }

            const existing = this.settings.getClient(deviceId) || {};
            const client = this.settings.upsertClient(deviceId, {
                deviceName: deviceName || name || existing.deviceName || deviceId,
                ip: ip || existing.ip,
                status: existing.status || 'offline',
                lastSeen: new Date().toISOString(),
            });

            res.json({ success: true, device: client });
        });

        this.Routes
        .route('/api/device/:deviceId')
        .put(async (req, res) => {
            const { deviceId } = req.params;
            const client = this.settings.getClient(deviceId);
            if (!client)
            { return res.status(404).json({ error: 'Device not found' }); }

            const updates = req.body || {};
            const allowedFields = ['deviceName', 'ip', 'currentSource', 'group', 'status'];
            const clientCommands = [];

            for (const [key, value] of Object.entries(updates))
            {
                if (!allowedFields.includes(key)) continue;

                if (key === 'deviceName' && value !== client.deviceName)
                { clientCommands.push({ type: 'rename-device', data: value }); }
                else if (key === 'currentSource' && value !== client.currentSource)
                { clientCommands.push({ type: 'set-source', data: value }); }

                client[key] = value;
            }

            client.lastSeen = new Date().toISOString();
            this.settings.upsertClient(deviceId, client);

            if (clientCommands.length > 0)
            {
                Promise.allSettled(clientCommands.map((cmd) => this.sendCommandToClient(deviceId, cmd)))
                .then((results) => {
                    const failures = results.filter((r) => r.status === 'rejected');
                    if (failures.length > 0)
                    { console.warn(`Some commands failed for device ${deviceId}:`, failures); }
                });
            }

            res.json({ success: true, message: 'Device updated successfully', device: deviceOut(this.settings.getClient(deviceId)) });
        })
        .delete((req, res) => {
            const { deviceId } = req.params;
            if (!this.settings.getClient(deviceId))
            { return res.status(404).json({ error: 'Device not found' }); }

            const name = this.settings.getClient(deviceId).deviceName;
            this.settings.deleteClient(deviceId);
            res.json({ success: true, message: `Forgot device ${name}` });
        });

        const deviceCommandRoute = (subPath, buildCommand) => {
            this.Routes
            .route(`/api/device/:deviceId/${subPath}`)
            .post(async (req, res) => {
                const { deviceId } = req.params;
                if (!this.settings.getClient(deviceId))
                { return res.status(404).json({ error: 'Device not found' }); }

                try
                {
                    await this.sendCommandToClient(deviceId, buildCommand(req));
                    res.json({ success: true, message: `${subPath} command sent` });
                }
                catch (error)
                { res.status(500).json({ error: error.message }); }
            });
        };

        deviceCommandRoute('shutdown', () => ({ type: 'shutdown-device' }));
        deviceCommandRoute('reboot', () => ({ type: 'reboot-device' }));
        // NOTE: Client's 'show-overlay'/'show-blank' command types also
        // re-apply `data` as the NDI source target (and reset it to 'none'
        // when `data` is omitted). Client's own local UI toggles this mode
        // via 'set-setting' on 'ndpi_status_no_source_display_mode' instead
        // — mirror that here so the source isn't clobbered.
        deviceCommandRoute('overlay', () => ({ type: 'set-setting', data: { name: 'ndpi_status_no_source_display_mode', value: 'overlay' } }));
        deviceCommandRoute('blank', () => ({ type: 'set-setting', data: { name: 'ndpi_status_no_source_display_mode', value: 'blank' } }));
        deviceCommandRoute('rename', (req) => ({ type: 'rename-device', data: req.body.newName }));
        deviceCommandRoute('cec', (req) => ({ type: 'send-cec', data: req.body.command }));

        // Remote settings editor — mirrors every `allowEditExternal` field
        // exposed by Client__v3_1_0/public/system.js (device_volume, output
        // resolution/framerate preference, NDI receiver bandwidth/color
        // format/scale method, AirPlay PIN, Hub hostname/port, etc).
        deviceCommandRoute('setting', (req) => ({ type: 'set-setting', data: { name: req.body.name, value: req.body.value } }));

        // Overlay image upload (base64 image data URI + metadata), matching
        // the file-upload flow in Client__v3_1_0/public/system.js.
        deviceCommandRoute('overlay-image', (req) => ({
            type: 'set-overlay',
            data: {
                name: req.body.name || '',
                type: req.body.type || '',
                size: req.body.size || 0,
                dateLastModified: req.body.dateLastModified || '',
                dateUploaded: req.body.dateUploaded || Date.now(),
                src: req.body.src || '',
            },
        }));

        // Software update checks/installs.
        deviceCommandRoute('check-for-update', () => ({ type: 'check-for-update' }));
        deviceCommandRoute('install-update', () => ({ type: 'install-update' }));

        this.Routes
        .route('/api/device/:deviceId/network')
        .post((req, res) => {
            // NDPi Client v3 does not currently support remote network
            // reconfiguration over the command channel.
            res.status(501).json({ error: 'Network configuration is not supported by NDPi Client v3 devices.' });
        });
    }

    /**
     *  Group Management API
     */
    __RoutesGroups() {
        const groupOut = (group) => ({
            id: group.id,
            name: group.name,
            devices: group.devices || [],
            currentSource: group.currentSource || 'None',
        });

        this.Routes
        .route('/api/groups')
        .get((req, res) => {
            res.json({ groups: this.settings.getGroups().map(groupOut) });
        });

        this.Routes
        .route('/api/group')
        .post((req, res) => {
            const { name, devices } = req.body;
            if (!name)
            { return res.status(400).json({ error: 'Group name required' }); }

            const group = this.settings.createGroup({ name, devices: devices || [] });
            res.json({ success: true, group: groupOut(group) });
        });

        this.Routes
        .route('/api/group/:groupId')
        .put(async (req, res) => {
            const { groupId } = req.params;
            const group = this.settings.getGroup(groupId);
            if (!group)
            { return res.status(404).json({ error: 'Group not found' }); }

            const sourceChanged = req.body.currentSource !== undefined && req.body.currentSource !== group.currentSource;
            const updated = this.settings.updateGroup(groupId, req.body);

            if (sourceChanged && updated.devices && updated.devices.length > 0)
            {
                const sourceName = req.body.currentSource || '';
                await Promise.allSettled(
                    updated.devices.map((d) => this.sendCommandToClient(d.id || d.deviceId, { type: 'set-source', data: sourceName }))
                );
            }

            res.json({ success: true, message: 'Group updated successfully', group: groupOut(updated) });
        })
        .delete((req, res) => {
            const { groupId } = req.params;
            const group = this.settings.getGroup(groupId);
            if (!group)
            { return res.status(404).json({ error: 'Group not found' }); }

            this.settings.deleteGroup(groupId);
            res.json({ success: true, message: `Group "${group.name}" deleted` });
        });

        this.Routes
        .route('/api/group/:groupId/assign-source')
        .post((req, res) => {
            const { groupId } = req.params;
            const { sourceName } = req.body;
            const group = this.settings.getGroup(groupId);
            if (!group)
            { return res.status(404).json({ error: 'Group not found' }); }

            const updated = this.settings.updateGroup(groupId, { currentSource: sourceName });
            Promise.allSettled((updated.devices || []).map((d) => this.sendCommandToClient(d.id || d.deviceId, { type: 'set-source', data: sourceName })));

            res.json({ success: true, message: `Source "${sourceName}" assigned to group "${group.name}"` });
        });

        const groupCommandRoute = (subPath, buildCommand) => {
            this.Routes
            .route(`/api/group/:groupId/${subPath}`)
            .post(async (req, res) => {
                const { groupId } = req.params;
                const group = this.settings.getGroup(groupId);
                if (!group)
                { return res.status(404).json({ error: 'Group not found' }); }

                await Promise.allSettled((group.devices || []).map((d) => this.sendCommandToClient(d.id || d.deviceId, buildCommand(req)).catch(() => {})));
                res.json({ success: true, message: `${subPath} command sent to ${group.devices.length} devices` });
            });
        };

        groupCommandRoute('shutdown', () => ({ type: 'shutdown-device' }));
        groupCommandRoute('reboot', () => ({ type: 'reboot-device' }));
        groupCommandRoute('overlay', () => ({ type: 'set-setting', data: { name: 'ndpi_status_no_source_display_mode', value: 'overlay' } }));
        groupCommandRoute('blank', () => ({ type: 'set-setting', data: { name: 'ndpi_status_no_source_display_mode', value: 'blank' } }));

        this.Routes
        .route('/api/group/:groupId/add-device')
        .post((req, res) => {
            const { groupId } = req.params;
            const { deviceId } = req.body;

            if (!this.settings.getGroup(groupId))
            { return res.status(404).json({ error: 'Group not found' }); }
            if (!this.settings.getClient(deviceId))
            { return res.status(404).json({ error: 'Device not found' }); }

            const group = this.settings.addDeviceToGroup(groupId, deviceId);
            const device = this.settings.getClient(deviceId);
            res.json({ success: true, message: `Device "${device.deviceName}" added to group "${group.name}"` });
        });

        this.Routes
        .route('/api/group/:groupId/remove-device')
        .post((req, res) => {
            const { groupId } = req.params;
            const { deviceId } = req.body;

            if (!this.settings.getGroup(groupId))
            { return res.status(404).json({ error: 'Group not found' }); }

            const before = this.settings.getGroup(groupId).devices.length;
            const group = this.settings.removeDeviceFromGroup(groupId, deviceId);

            if (group.devices.length === before)
            { return res.status(404).json({ error: 'Device not found in group' }); }

            res.json({ success: true, message: 'Device removed from group' });
        });
    }

    /**
     *  Roku TV, NDI Source, Resolution & System Control API
     */
    __RoutesRoku() {
        this.Routes
        .route('/api/roku-tvs')
        .get((req, res) => { res.json({ rokuTvs: this.settings.getRokuTvs() }); });

        this.Routes
        .route('/api/roku-tv')
        .post((req, res) => {
            const { displayName, ipAddress, model, manufacturer, deviceType, screenSize, groupId } = req.body;

            if (!ipAddress || !groupId)
            { return res.status(400).json({ error: 'IP address and group ID are required' }); }

            if (this.settings.getRokuTvs().find((tv) => tv.ipAddress === ipAddress))
            { return res.status(400).json({ error: 'Roku TV with this IP address already exists' }); }

            const rokuTv = this.settings.addRokuTv({
                displayName: displayName || 'Roku TV',
                ipAddress,
                model: model || '',
                manufacturer: manufacturer || 'Roku',
                deviceType: deviceType || 'TV',
                screenSize: screenSize || '',
                groupId,
            });

            res.json({ success: true, rokuTv });
        });

        this.Routes
        .route('/api/roku-tv/:id')
        .delete((req, res) => {
            if (!this.settings.deleteRokuTv(req.params.id))
            { return res.status(404).json({ error: 'Roku TV not found' }); }
            res.json({ success: true });
        });

        this.Routes
        .route('/api/roku-info')
        .post(async (req, res) => {
            const { ipAddress } = req.body;
            if (!ipAddress)
            { return res.status(400).json({ error: `IP Address for RokuTv is missing. ${ipAddress}` }); }

            try
            {
                const response = await fetch(`http://${ipAddress}:8060/query/device-info`, {
                    method: 'GET',
                    headers: { 'Accept': 'application/xml' },
                });
                const text = await response.text();
                res.status(200).send(text);
            }
            catch (error)
            { res.status(500).send('Failed to reach Roku'); }
        });

        this.Routes
        .route('/api/ndi-sources')
        .get(async (req, res) => {
            const sources = await this.getNDISources();
            res.json(sources);
        });

        this.Routes
        .route('/api/favorite-ndi-sources')
        .get((req, res) => { res.json(this.settings.getFavoritedSources()); })
        .post((req, res) => {
            if (!Array.isArray(req.body))
            { return res.status(400).json({ error: 'Request body must be an array' }); }

            const updated = this.settings.setFavoritedSources(req.body);
            res.json({ success: true, message: 'Favorited sources updated', count: updated.length });
        });

        this.Routes
        .route('/api/active-viewers')
        .get((req, res) => { res.json({ viewers: Array.from(this.activeViewers.values()) }); });
    }

    /**
     *  Resolution & Hub System Control API
     */
    __RoutesSystem() {
        const CRLFArray = (string = '') => string.split(/\r?\n/);

        this.Routes
        .route('/api/resolution')
        .get((req, res) => {
            exec('DISPLAY=:0 xrandr', (error, stdout, stderr) => {
                if (error)
                { return res.status(500).json({ error: true, message: stderr }); }

                let resObj = { resolutionOptions: [] };
                const arr = CRLFArray(stdout);
                arr[0].split(', ').forEach((ln) => {
                    if (ln.includes('current'))
                    {
                        const splt = ln.trim().split(' ');
                        resObj.currentSize = `${splt[1]}x${splt[3]}`;
                    }
                });
                arr.forEach((ln) => {
                    const str = ln.trim();
                    if (/^[1-9]/.test(str))
                    { resObj.resolutionOptions.push(str.split(' ')[0]); }
                });
                res.json(resObj);
            });
        })
        .post((req, res) => {
            const { output, resolution, rate } = req.body;
            if (!resolution)
            { return res.status(400).json({ error: true, message: 'Missing resolution. (e.g. 1920x1080)' }); }

            exec(`DISPLAY=:0 xrandr --output ${output ? output : 'HDMI-1'} --mode ${resolution}${rate ? ` --rate ${rate}` : ''}`, (error, stdout, stderr) => {
                if (error)
                { res.status(400).json({ error: true, message: stderr }); }
                else
                { res.json({ error: false, message: `Resolution set: ${resolution}.` }); }
            });
        });

        this.Routes
        .route('/api/system-logs')
        .get((req, res) => {
            exec('sudo journalctl --no-pager -n 100', (error, stdout, stderr) => {
                if (error)
                { return res.status(500).json({ error: true, message: stderr }); }
                res.json(CRLFArray(stdout));
            });
        });

        this.Routes
        .route('/api/system/shutdown')
        .post((req, res) => {
            res.json({ success: true, message: 'System shutdown initiated' });
            this.broadcastToGUI({ type: 'server-shutdown', message: 'Hub is shutting down...' });
            setTimeout(() => { this.emit('shutdown-command'); }, 1000);
        });

        this.Routes
        .route('/api/system/restart')
        .post((req, res) => {
            res.json({ success: true, message: 'Server restart initiated' });
            this.broadcastToGUI({ type: 'server-restart', message: 'Hub server is restarting...' });
            setTimeout(() => { process.exit(0); }, 1000);
        });

        this.Routes
        .route('/api/system/reboot')
        .post((req, res) => {
            res.json({ success: true, message: 'System reboot initiated' });
            this.broadcastToGUI({ type: 'server-reboot', message: 'Hub is rebooting...' });
            setTimeout(() => { this.emit('reboot-command'); }, 1000);
        });

        this.Routes
        .route('/api/system/network')
        .post((req, res) => {
            res.status(501).json({ error: 'Hub network reconfiguration is not implemented.' });
        });
    }

    /**
     * Helper method to fetch from Python NDI server
     */
    async _getPythonNDISources() {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'localhost',
                port: 5000,
                path: '/api/sources',
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            };

            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error(`Failed to parse response: ${e.message}`));
                    }
                });
            });

            req.on('error', reject);
            req.end();
        });
    }

    _fetchFromPythonServer(endpoint, method = 'GET', body = null) {
        return new Promise((resolve, reject) => {
            const url = new URL(endpoint, NDI_SERVER_URL);
            
            const options = {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname + url.search,
                method: method,
                headers: {
                    'Content-Type': 'application/json'
                }
            };

            const req = http_lib.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            const parsed = data ? JSON.parse(data) : {};
                            resolve(parsed);
                        } else {
                            reject(new Error(`Python server returned ${res.statusCode}: ${data}`));
                        }
                    } catch (e) {
                        reject(new Error(`Failed to parse response: ${e.message}`));
                    }
                });
            });

            req.on('error', reject);

            if (body) {
                req.write(JSON.stringify(body));
            }

            req.end();
        });
    }

    startServer() {
        this.Server = http.createServer(this.App);

        this.Server.listen(this.port, '0.0.0.0', () => {
            console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, `API Server Online`);
            console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, `PORT: ${this.port}`);
            process.nextTick(() => { this.emit('online'); });
        });

        this.Server.on('upgrade', (request, socket, head) => {
            const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
            
            if (pathname.startsWith('/ws/ndi-stream/'))
            {
                this.ws_serv_ndi_streams.handleUpgrade(request, socket, head, (ws) => {
                    this.ws_serv_ndi_streams.emit('connection', ws, request);
                });
            }
            else if (pathname === '/ws/sources')
            {
                this.ws_serv_sources.handleUpgrade(request, socket, head, (ws) => {
                    this.ws_serv_sources.emit('connection', ws, request);
                });
            }
            else if (pathname === '/ws/client')
            {
                this.ws_serv_devices.handleUpgrade(request, socket, head, (ws) => {
                    this.ws_serv_devices.emit('connection', ws, request);
                });
            }
            else if (pathname === '/ws')
            {
                this.ws_serv_gui.handleUpgrade(request, socket, head, (ws) => {
                    this.ws_serv_gui.emit('connection', ws, request);
                });
            }
            else { socket.destroy(); }
        });
    }

    async close() {
        this.closing = true;

        console.info(`[ CLOSING ][ ${path.basename(__filename).split('.')[0]} ]`);

        for (const timer of [this.heartbeatInterval, this.ndiSourceInterval, this.systemStatsInterval, this.deviceTimeoutInterval])
        { try { clearInterval(timer); } catch {} }
        this.heartbeatInterval = null;
        this.ndiSourceInterval = null;
        this.systemStatsInterval = null;
        this.deviceTimeoutInterval = null;

        this.stopMdnsDiscovery();

        try { this.ws_serv_gui?.close(); } catch {}
        try { this.ws_serv_devices?.close(); } catch {}
        try { this.ws_serv_sources?.close(); } catch {}

        await this._tryCloseDiscovery();

        // Close all NDI streams
        this.ws_conn_ndi_streams.forEach((stream) => {
            try {
                stream.stop();
            } catch (error) {
                console.error(`Error stopping NDI stream ${stream.id}:`, error);
            }
        });
        this.ws_conn_ndi_streams.clear();

        // Close NDI stream WebSocket server
        if (this.ws_serv_ndi_streams) {
            this.ws_serv_ndi_streams.close((err) => {
                if (err) {
                    console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR CLOSING ] NDI Stream WebSocket`, err);
                } else {
                    console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ] NDI Stream WebSocket`);
                }
            });
        }
        
        return new Promise((resolve) => {
            try { this.Server.closeAllConnections(); }
            catch {}

            // try {
            this.Server.close((err) => {
                console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ]`);
                resolve();
            });
            // }
            // catch {}
            // finally { 
            //     console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ]`);
            //     resolve();
            // }
        });
    }
}

module.exports = NDPiCommandServer_Client;