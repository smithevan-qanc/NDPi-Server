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
const func = require('./functions.js');


// Python NDI server configuration
const NDI_SERVER_HOST = process.env.NDI_SERVER_HOST || '127.0.0.1';
const NDI_SERVER_PORT = process.env.NDI_SERVER_PORT || 3081;
const NDI_SERVER_URL = `http://${NDI_SERVER_HOST}:${NDI_SERVER_PORT}`;

// Network error codes that just mean "the device isn't reachable right now"
// (powered off, unplugged, sleeping, etc) -- expected/routine on a 5s relay
// reconnect loop, not worth logging as an error every retry.
const DEVICE_OFFLINE_ERROR_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET']);


class NDPiCommandServer_Client extends EventEmitter {
    constructor(fsData) {
        super();

        this.settings = fsData;
        this.port = fsData.get('local_port_number_api') || process.env.PORT_API || 3080

        this.closing = false;

        this.ws_serv_ndi_streams = null;
        this.ws_conn_ndi_streams = new Map();
        // 'development'
        this.cacheControl = String(process.env.NODE_ENV || 'development').toLowerCase() === 'production' ?
                            'public, max-age=86400, immutable' :
                            'no-store, no-cache, must-revalidate, private';

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
         *  ndi-sources, system-stats, heartbeat.
         */
        this.ws_serv_gui = null;
        this.ws_conn_gui = new Set();

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

        /**
         *  Hub's own live feeds ( /ws/system, /ws/stats )
         *  ------------------------------------------------
         *  Mirrors Client__v3_1_0/service/client_api_server.js's local
         *  __ws_System()/__ws_Stats() — this Hub's OWN settings (fileMap)
         *  and OWN machine stats, for the Hub's own dashboard/settings UI.
         */
        this.ws_serv_hub_system = null;
        this.ws_conn_hub_system = new Set();
        this.ws_serv_hub_stats = null;
        this.ws_conn_hub_stats = new Set();
        this.hubStatsSendInterval = null;

        // Broadcast this Hub's own settings changes to /ws/system clients
        // (raw JSON.stringify(Array.from(fileMap)) string, same shape
        // Client__v3_1_0's own /ws/system pushes).
        fsData.on('update', (data) => {
            this.ws_conn_hub_system.forEach((ws) => { try { ws.send(data); } catch {} });
        });

        /**
         *  Device system/stats relay ( /ws/devices/system, /ws/devices/stats )
         *  ---------------------------------------------------------------------
         *  The Hub opens its OWN outbound connections to every adopted
         *  device's local /ws/system and /ws/stats
         *  (Client__v3_1_0/service/client_api_server.js), caches the latest
         *  message per device (so a browser connecting mid-stream isn't
         *  blank), and rebroadcasts every update to browsers connected to
         *  these two Hub-hosted endpoints — one Hub-side connection per
         *  device, instead of every open browser tab connecting to every
         *  device directly.
         */
        this.deviceSystemSockets = new Map(); // deviceId -> { ws, ip, port, reconnectTimer }
        this.deviceSystemCache = new Map();   // deviceId -> latest raw /ws/system message
        this.deviceStatsSockets = new Map();  // deviceId -> { ws, ip, port, reconnectTimer }
        this.deviceStatsCache = new Map();    // deviceId -> latest raw /ws/stats message

        this.ws_serv_devices_system = null;
        this.ws_conn_devices_system = new Set();
        this.ws_serv_devices_stats = null;
        this.ws_conn_devices_stats = new Set();

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
        // Default express.json() caps bodies at 100kb, too small for a
        // base64-encoded image upload (logo, device overlay image) -- 5mb
        // covers those comfortably without opening this LAN-only admin app
        // up to any meaningfully larger risk.
        this.App.use(express.json({ limit: '5mb' }));
        this.App.use(
            express.static(path.join(__dirname, '..', 'public'), {
                setHeaders: (res, path) => {
                    res.set('Cache-Control', this.cacheControl);;
                }
            })
        );
        this.App.use(
            '/assets',
            express.static(path.join(__dirname, '..', 'assets'), {
                setHeaders: (res, path) => {
                    res.set('Cache-Control', 'public, max-age=86400, immutable');
                }
            })
        );
        this.App.use(
            '/scripts',
            express.static(path.join(__dirname, '..', 'public', '01-scripts'), {
                setHeaders: (res, path) => {
                    res.set('Cache-Control', this.cacheControl);
                }
            })
        );
        this.App.use(
            '/media',
            express.static(path.join(__dirname, '..', 'assets', 'gui', 'media'), {
                setHeaders: (res, path) => {
                    res.set('Cache-Control', 'public, max-age=86400, immutable');
                }
            })
        );

        this.__ws_NDIStreams();
        this.__ws_Sources();
        this.__ws_Gui();
        this.__ws_Devices();
        this.__ws_HubSystem();
        this.__ws_HubStats();
        this.__ws_DevicesSystemRelay();
        this.__ws_DevicesStatsRelay();
        this.__Routers();
        this.startMdnsDiscovery();
        this.startBroadcastIntervals();
        this.startDeviceTimeoutMonitor();
        this.reconnectAllDeviceRelays();
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

            this.ws_conn_gui.add(ws);

            try
            {
                ws.send(JSON.stringify({ type: 'connected', message: 'Connected to NDPi Monitor Hub' }));
                ws.send(JSON.stringify({
                    type: 'devices-update',
                    origin: `hub_api_server.js( '__ws_Gui' connection snapshot )`,
                    devices: this.settings.getClients().map((client) => this.deviceOut(client)),
                }));
            }
            catch {}

            ws.onerror = (error) => {
                console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, 'GUI WebSocket Server', error);
            };

            ws.onclose = () => {
                this.ws_conn_gui.delete(ws);
                console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'GUI WebSocket connection REMOVED.');
            };
        });
    }

    broadcastToGUI(message = {}) {
        const data = JSON.stringify(message);
        this.ws_conn_gui.forEach((ws) => {
            if (ws.readyState === WebSocket.OPEN)
            {
                try { ws.send(data); }
                catch {}
            }
        });
    }

    deviceOut(client) {
        return {
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
        };
    }

    broadcastDevices(origin = '') {
        this.broadcastToGUI({
            type: 'devices-update',
            origin,
            devices: this.settings.getClients().map((client) => this.deviceOut(client)),
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

                    const existingClient = this.settings.getClient(deviceId);
                    const settingsArray = Array.isArray(message.settings) ? message.settings : (existingClient?.settings || null);
                    const apiPortSetting = Array.isArray(settingsArray) ? settingsArray.find(([key]) => key === 'local_port_number_api') : null;
                    const apiPort = (apiPortSetting && apiPortSetting[1] && apiPortSetting[1].value) || existingClient?.apiPort || 3080;
                    const ip = message.ip || existingClient?.ip;

                    this.settings.upsertClient(deviceId, {
                        deviceName: message.deviceName || existingClient?.deviceName || deviceId,
                        ip,
                        // The device's own API port — not exposed over REST, only
                        // used internally to (re)connect the system/stats relay.
                        apiPort,
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
                        settings: settingsArray,
                        lastSeen: new Date().toISOString(),
                        lastStatusUpdate: new Date().toISOString(),
                    });

                    // The device is no longer merely "discovered" once it starts reporting status.
                    this.settings.removeDiscoveredClient(deviceId);

                    if (ip)
                    { this.ensureDeviceRelayConnections(deviceId, ip, apiPort); }
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
     *      Hub's own System Settings - WebSocket Connection Handler ( /ws/system )
     *      Mirrors Client__v3_1_0/service/client_api_server.js's local
     *      __ws_System(): sends this Hub's own fileMap on connect, then
     *      again in full any time a setting changes (see the
     *      fsData.on('update', ...) hookup in the constructor).
     */
    __ws_HubSystem() {
        this.ws_serv_hub_system = new WebSocket.Server({ noServer: true });

        this.ws_serv_hub_system.on('connection', (ws) => {
            console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'Hub System WebSocket connection ADDED.');

            this.ws_conn_hub_system.add(ws);
            ws.send(JSON.stringify(Array.from(this.settings.fileMap)));

            ws.onerror = (error) => {
                console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, 'Hub System WebSocket', error);
            };

            ws.onclose = () => {
                this.ws_conn_hub_system.delete(ws);
                console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'Hub System WebSocket connection REMOVED.');
            };
        });
    }

    /**
     *      This Hub machine's own stats, in the same raw os.*-derived shape
     *      Client__v3_1_0/service/client_api_server.js's getSystemStats()
     *      produces — distinct from hubSystemStats() (below), which is the
     *      pre-summarized shape used by the /ws GUI broadcast. Keeping this
     *      one in the raw shape means the Hub's own /ws/stats and every
     *      relayed device's /ws/stats deliver a consistent shape to the
     *      frontend.
     */
    getHubRawSystemStats() {
        let thermal_zone0 = 0;
        try
        {
            const tempFile = '/sys/class/thermal/thermal_zone0/temp';
            if (fs.existsSync(tempFile))
            { thermal_zone0 = Number(fs.readFileSync(tempFile, 'utf8').trim() || '0') / 1000; }
        }
        catch {}

        let fan1_input = 0;
        for (let i = 0; i <= 5; i++)
        {
            const fanFile = path.join('/sys', 'class', 'hwmon', `hwmon${i}`, 'fan1_input');
            if (fs.existsSync(fanFile))
            {
                try { fan1_input = Number(fs.readFileSync(fanFile, 'utf8').trim() || '0'); }
                catch {}
                break;
            }
        }

        return {
            systemTime: String(new Date()),
            osArchitecture: os.arch(),
            osUptime: os.uptime(),
            freemem: os.freemem(),
            totalmem: os.totalmem(),
            hostname: os.hostname(),
            loadavg: os.loadavg(),
            thermal: { thermal_zone0, fan1_input },
            osMachine: os.machine(),
            osPlatform: os.platform(),
            osRelease: os.release(),
            osVersion: os.version(),
            networkInterfaces: os.networkInterfaces(),
            cpus: os.cpus(),
        };
    }

    /**
     *      Hub's own System Stats - WebSocket Connection Handler ( /ws/stats )
     *      Mirrors Client__v3_1_0/service/client_api_server.js's local
     *      __ws_Stats(): sends current stats on connect, then every ~1s.
     */
    __ws_HubStats() {
        this.ws_serv_hub_stats = new WebSocket.Server({ noServer: true });

        this.ws_serv_hub_stats.on('connection', (ws) => {
            console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'Hub Stats WebSocket connection ADDED.');

            this.ws_conn_hub_stats.add(ws);
            ws.send(JSON.stringify(this.getHubRawSystemStats()));
            this.startHubStats();

            ws.onerror = (error) => {
                console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, 'Hub Stats WebSocket', error);
            };

            ws.onclose = () => {
                this.ws_conn_hub_stats.delete(ws);
                console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'Hub Stats WebSocket connection REMOVED.');
            };
        });
    }

    startHubStats() {
        if (this.hubStatsSendInterval) return;
        this.hubStatsSendInterval = setInterval(() => {
            if (this.ws_conn_hub_stats.size === 0)
            {
                clearInterval(this.hubStatsSendInterval);
                this.hubStatsSendInterval = null;
                return;
            }
            const stats = JSON.stringify(this.getHubRawSystemStats());
            this.ws_conn_hub_stats.forEach((ws) => {
                if (ws.readyState === WebSocket.OPEN)
                { try { ws.send(stats); } catch {} }
            });
        }, 1000);
    }

    /**
     *      Aggregated Device System Relay - WebSocket Connection Handler
     *      ( /ws/devices/system )
     *      One Hub-side outbound connection per adopted device to that
     *      device's own /ws/system (see connectDeviceSystemRelay()); every
     *      message received is cached (deviceSystemCache) and relayed here
     *      to every connected browser, tagged with the device it came
     *      from. A browser connecting here gets the full current cache
     *      immediately (a 'snapshot' message), so pages showing many
     *      devices' settings aren't blank waiting for the next per-device
     *      update — and only ever need ONE websocket connection to the Hub
     *      regardless of how many devices they display.
     */
    __ws_DevicesSystemRelay() {
        this.ws_serv_devices_system = new WebSocket.Server({ noServer: true });

        this.ws_serv_devices_system.on('connection', (ws) => {
            console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'Devices System Relay WebSocket connection ADDED.');

            this.ws_conn_devices_system.add(ws);

            const snapshot = {};
            this.deviceSystemCache.forEach((data, deviceId) => { snapshot[deviceId] = data; });
            try { ws.send(JSON.stringify({ type: 'snapshot', devices: snapshot })); }
            catch {}

            ws.onerror = (error) => {
                console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, 'Devices System Relay WebSocket', error);
            };

            ws.onclose = () => {
                this.ws_conn_devices_system.delete(ws);
                console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'Devices System Relay WebSocket connection REMOVED.');
            };
        });
    }

    /**
     *      Same idea as __ws_DevicesSystemRelay(), for /ws/devices/stats.
     */
    __ws_DevicesStatsRelay() {
        this.ws_serv_devices_stats = new WebSocket.Server({ noServer: true });

        this.ws_serv_devices_stats.on('connection', (ws) => {
            console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'Devices Stats Relay WebSocket connection ADDED.');

            this.ws_conn_devices_stats.add(ws);

            const snapshot = {};
            this.deviceStatsCache.forEach((data, deviceId) => { snapshot[deviceId] = data; });
            try { ws.send(JSON.stringify({ type: 'snapshot', devices: snapshot })); }
            catch {}

            ws.onerror = (error) => {
                console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, 'Devices Stats Relay WebSocket', error);
            };

            ws.onclose = () => {
                this.ws_conn_devices_stats.delete(ws);
                console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'Devices Stats Relay WebSocket connection REMOVED.');
            };
        });
    }

    broadcastDeviceSystemRelay(deviceId, data) {
        const message = JSON.stringify({ type: 'device-system', deviceId, data });
        this.ws_conn_devices_system.forEach((ws) => {
            if (ws.readyState === WebSocket.OPEN)
            { try { ws.send(message); } catch {} }
        });
    }

    broadcastDeviceStatsRelay(deviceId, data) {
        const message = JSON.stringify({ type: 'device-stats', deviceId, data });
        this.ws_conn_devices_stats.forEach((ws) => {
            if (ws.readyState === WebSocket.OPEN)
            { try { ws.send(message); } catch {} }
        });
    }

    /**
     *      Ensure the Hub has (or is retrying) outbound connections to a
     *      device's own /ws/system and /ws/stats, using the ip/port most
     *      recently known for it. Safe/cheap to call repeatedly — only
     *      (re)connects when there's no live connection yet or the ip/port
     *      changed since the last one was opened.
     */
    ensureDeviceRelayConnections(deviceId, ip, port) {
        if (!ip || !port) return;

        const currentSystem = this.deviceSystemSockets.get(deviceId);
        if (!currentSystem || currentSystem.ip !== ip || currentSystem.port !== port || currentSystem.ws.readyState > WebSocket.OPEN)
        { this.connectDeviceSystemRelay(deviceId, ip, port); }

        const currentStats = this.deviceStatsSockets.get(deviceId);
        if (!currentStats || currentStats.ip !== ip || currentStats.port !== port || currentStats.ws.readyState > WebSocket.OPEN)
        { this.connectDeviceStatsRelay(deviceId, ip, port); }
    }

    connectDeviceSystemRelay(deviceId, ip, port) {
        const previous = this.deviceSystemSockets.get(deviceId);
        if (previous)
        {
            clearTimeout(previous.reconnectTimer);
            try { previous.ws.removeAllListeners(); previous.ws.close(); } catch {}
        }

        const ws = new WebSocket(`ws://${ip}:${port}/ws/system`);
        const entry = { ws, ip, port, reconnectTimer: null };
        this.deviceSystemSockets.set(deviceId, entry);

        ws.on('message', (data) => {
            let parsed;
            try { parsed = JSON.parse(data); }
            catch { return; }
            this.deviceSystemCache.set(deviceId, parsed);
            this.broadcastDeviceSystemRelay(deviceId, parsed);
        });

        ws.on('error', (error) => {
            if (DEVICE_OFFLINE_ERROR_CODES.has(error.code)) return;
            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, `Device system relay (${deviceId} @ ${ip}:${port})`, error.message);
        });

        ws.on('close', () => {
            if (this.closing) return;
            // Only reconnect if this is still the current entry for this
            // device — a newer call to connectDeviceSystemRelay() (e.g. a
            // fresh client-status with a changed ip/port) may have already
            // superseded it.
            if (this.deviceSystemSockets.get(deviceId) === entry)
            { entry.reconnectTimer = setTimeout(() => { this.connectDeviceSystemRelay(deviceId, ip, port); }, 5000); }
        });
    }

    connectDeviceStatsRelay(deviceId, ip, port) {
        const previous = this.deviceStatsSockets.get(deviceId);
        if (previous)
        {
            clearTimeout(previous.reconnectTimer);
            try { previous.ws.removeAllListeners(); previous.ws.close(); } catch {}
        }

        const ws = new WebSocket(`ws://${ip}:${port}/ws/stats`);
        const entry = { ws, ip, port, reconnectTimer: null };
        this.deviceStatsSockets.set(deviceId, entry);

        ws.on('message', (data) => {
            let parsed;
            try { parsed = JSON.parse(data); }
            catch { return; }
            this.deviceStatsCache.set(deviceId, parsed);
            this.broadcastDeviceStatsRelay(deviceId, parsed);
        });

        ws.on('error', (error) => {
            if (DEVICE_OFFLINE_ERROR_CODES.has(error.code)) return;
            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, `Device stats relay (${deviceId} @ ${ip}:${port})`, error.message);
        });

        ws.on('close', () => {
            if (this.closing) return;
            if (this.deviceStatsSockets.get(deviceId) === entry)
            { entry.reconnectTimer = setTimeout(() => { this.connectDeviceStatsRelay(deviceId, ip, port); }, 5000); }
        });
    }

    /**
     *      Tear down relay connections + cached data for a device that's
     *      been forgotten/removed, so it stops being reconnected to and
     *      drops out of the relay snapshot.
     */
    closeDeviceRelayConnections(deviceId) {
        const system = this.deviceSystemSockets.get(deviceId);
        if (system)
        {
            clearTimeout(system.reconnectTimer);
            try { system.ws.removeAllListeners(); system.ws.close(); } catch {}
            this.deviceSystemSockets.delete(deviceId);
        }
        this.deviceSystemCache.delete(deviceId);

        const stats = this.deviceStatsSockets.get(deviceId);
        if (stats)
        {
            clearTimeout(stats.reconnectTimer);
            try { stats.ws.removeAllListeners(); stats.ws.close(); } catch {}
            this.deviceStatsSockets.delete(deviceId);
        }
        this.deviceStatsCache.delete(deviceId);
    }

    /**
     *      On Hub startup, (re)establish relay connections for every
     *      already-known device that has a stored ip/apiPort, instead of
     *      waiting for each one's next client-status report.
     */
    reconnectAllDeviceRelays() {
        this.settings.getClients().forEach((client) => {
            if (client.ip && client.apiPort)
            { this.ensureDeviceRelayConnections(client.deviceId, client.ip, client.apiPort); }
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
    /**
     *  The `bonjour`/`dns-txt` dependency chain this (and Client__v3_1_0)
     *  relies on has a known TXT-record decoding bug: instead of splitting
     *  the DNS TXT RDATA into its separate length-prefixed
     *  <character-string> entries, it can hand back a single field whose
     *  key/value still contains every entry concatenated together, with
     *  each entry's own length byte leaking through as a literal control
     *  character (0x00-0x1F) in place of the boundary between entries —
     *  e.g. `{ "deviceid": "F564BD8290C80176deviceName=HV Camp
     *  Entryway\rip=10.0.1.182..." }` (the leading control byte is 0x19 = 25
     *  decimal = the exact length of `"deviceId=F564BD8290C80176"`). The field names and `=` delimiters
     *  always survive intact even when this happens, so a value can be
     *  recovered by matching "the run of printable characters right after
     *  `key=`", regardless of which key it landed under.
     */
    _extractMdnsTxtField(service, key) {
        const raw = Object.entries(service.txt || {}).map(([k, v]) => `${k}=${v}`).join('');
        const match = new RegExp(`(?:^|[\\x00-\\x1f])${key}=([^\\x00-\\x1f]*)`, 'i').exec(raw);
        return match ? match[1] : null;
    }

    startMdnsDiscovery() {
        console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'Starting NDPi Client device discovery (mDNS).');

        this.bonjourBrowser = bonjour.find({ type: 'ndpi-monitor-client' });

        this.bonjourBrowser.on('up', (service) => {
            const deviceId = service.txt?.deviceId || service.txt?.deviceid || this._extractMdnsTxtField(service, 'deviceid');
            const deviceName = service.txt?.deviceName || service.txt?.devicename || this._extractMdnsTxtField(service, 'devicename') || 'NDPi Client';
            const ip = service.txt?.ip || this._extractMdnsTxtField(service, 'ip') || service.addresses?.[0] || service.host;
            const commandPort = service.txt?.commandPort || service.txt?.commandport || this._extractMdnsTxtField(service, 'commandport') || service.port;

            if (!deviceId)
            {
                // Client__v3_1_0/service/client_bonjour.js gates on deviceId
                // being set before it ever calls bonjour.publish(), and the
                // TXT-corruption fallback above recovers it even when the
                // library mangles the record (see _extractMdnsTxtField), so
                // reaching here means deviceId genuinely isn't in the TXT
                // data at all. Logged with enough detail to tell which
                // device it was.
                console.warn(`⚠️   [ ${path.basename(__filename).split('.')[0]} ] Discovered a service on 'ndpi-monitor-client' with no deviceId recoverable from its TXT record — name: '${service.name}', host: '${service.host}', fqdn: '${service.fqdn}', txt: ${JSON.stringify(service.txt || {})}`);
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
            const deviceId = service.txt?.deviceId || service.txt?.deviceid || this._extractMdnsTxtField(service, 'deviceid');
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

    /**
     *  Point a just-adopted device at this Hub, so it starts reporting
     *  over /ws/client on its own. Client__v3_1_0's clientServer_websocket.js
     *  only opens that connection once BOTH 'ndpi_hub_hostname' and
     *  'ndpi_hub_port' are set — until then a device can be fully visible
     *  via mDNS (name/ip/port) but never actually deliver its settings/
     *  status. Calls the device's own 'POST /api/v1/adopt' endpoint
     *  (Client__v3_1_0/service/client_api_server.js), via the
     *  ip/commandPort this Hub already learned from its mDNS TXT record.
     */
    async configureDeviceHubConnection(ip, commandPort) {
        if (!ip || !commandPort)
        { return { success: false, message: 'Missing device ip/commandPort' }; }

        const hubHostname = this.getServerIP();
        const hubPort = String(this.port);

        return new Promise((resolve) => {
            const postData = JSON.stringify({ hubHostname, hubPort });

            const req = http.request({
                hostname: ip,
                port: commandPort,
                path: '/api/v1/adopt',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
                timeout: 5000,
            }, (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => resolve({ success: res.statusCode === 200, hubHostname, hubPort, body }));
            });

            req.on('error', (error) => resolve({ success: false, hubHostname, hubPort, error: error.message }));
            req.on('timeout', () => { req.destroy(); resolve({ success: false, hubHostname, hubPort, error: 'timeout' }); });

            req.write(postData);
            req.end();
        });
    }

    /**
     *  Serves an HTML page with every local (root-relative) <script src>/
     *  <link href> reference cache-busted with a `?v=<app version>` query
     *  string. `this.cacheControl` only governs how the *next* response for
     *  a given URL gets cached -- it can't invalidate what a browser has
     *  already cached under that exact URL, which (thanks to
     *  `max-age=86400, immutable` whenever NODE_ENV=production) can mean a
     *  browser keeps serving a stale copy of e.g. 01-scripts/ws-devices.js
     *  for up to 24h after the file on disk changed, with no way for the
     *  server to tell it otherwise. Bumping the app version (already done
     *  on every release, see version/current) changes every busted URL at
     *  once, so the very next page load fetches everything fresh instead
     *  of requiring users to know to hard-refresh.
     */
    sendHtmlWithCacheBust(res, filePath, fallbackPath = null) {
        fs.readFile(filePath, 'utf8', (err, html) => {
            if (err)
            {
                if (fallbackPath) { this.sendHtmlWithCacheBust(res.status(404), fallbackPath); return; }
                res.status(404).end('Not found');
                return;
            }

            const version = (this.settings && this.settings.get('ndpi_version')) || Date.now();
            const busted = html.replace(
                /((?:src|href)=")(\/(?!\/)[^"?]+)(")/g,
                (match, prefix, url, suffix) => `${prefix}${url}?v=${encodeURIComponent(version)}${suffix}`
            );
            res.type('html').send(busted);
        });
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
         *  `/api/groups`, `/api/account`, `/api/setting`) before it ever
         *  reaches its real handler.
         */
        this.Routes.route('/test-page').get((req, res) => {
            res.set('Cache-Control', this.cacheControl);
            this.sendHtmlWithCacheBust(res, path.join(__dirname, '..', 'ndi-webrtc-example.html'));
        });

        this.Routes
        .route('/')
        .get((req, res) => {
            res.set('Cache-Control', this.cacheControl);
            this.sendHtmlWithCacheBust(res, path.join(__dirname, '..', 'public', 'dashboard', 'dashboard.html'));
        });

        this.Routes
        .route('/:page/:ext/')
        .get((req, res) => {
            res.set('Cache-Control', this.cacheControl);
            const page = req.params.page.toLowerCase() || 'dashboard';
            const ext = req.params.ext.toLowerCase() || 'html';
            const filePath = path.join(__dirname, '..', 'public', page, `${page}.${ext}`);
            if (ext === 'html') { this.sendHtmlWithCacheBust(res, filePath); }
            else { res.sendFile(filePath); }
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
            res.set('Cache-Control', this.cacheControl);
            const page = req.params.page.toLowerCase() || 'dashboard';
            this.sendHtmlWithCacheBust(
                res,
                path.join(__dirname, '..', 'public', page, `${page}.html`),
                path.join(__dirname, '..', 'public', 'not-found', 'not-found.html')
            );
        });

        // Catch-all: anything else unmatched falls here.
        this.Routes.use((req, res) => {
            if (req.path.startsWith('/api/'))
            { return res.status(404).json({ error: 'Not found' }); }
            this.sendHtmlWithCacheBust(res.status(404), path.join(__dirname, '..', 'public', 'not-found', 'not-found.html'));
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
        const deviceOut = (client) => this.deviceOut(client);

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
            const deviceIds = this.settings.getClients().map((c) => c.deviceId);
            const count = this.settings.deleteAllClients();
            deviceIds.forEach((id) => this.closeDeviceRelayConnections(id));
            res.json({ success: true, message: `Forgot ${count} device(s)` });
        });

        this.Routes
        .route('/api/device/:id?')
        .post(async (req, res) => {
            const deviceId = req.params.id || req.body.deviceId || req.body.id;
            const { deviceName, ip, name } = req.body;

            if (!deviceId)
            { return res.status(400).json({ error: 'Device ID required' }); }

            const existing = this.settings.getClient(deviceId) || {};
            const discovered = this.settings.getDiscoveredClient(deviceId);
            const resolvedIp = ip || existing.ip || discovered?.ip;

            const client = this.settings.upsertClient(deviceId, {
                deviceName: deviceName || name || existing.deviceName || deviceId,
                ip: resolvedIp,
                status: existing.status || 'offline',
                lastSeen: new Date().toISOString(),
            });

            // Adopting a device it only knows about via mDNS: point it at
            // this Hub so it starts reporting over /ws/client on its own.
            // Best-effort — the device may be briefly unreachable, and the
            // admin can already fix this by hand on the device's own page.
            let hubConfigured = false;
            if (resolvedIp && discovered?.commandPort)
            {
                const result = await this.configureDeviceHubConnection(resolvedIp, discovered.commandPort);
                hubConfigured = result.success;
                if (!result.success)
                { console.warn(`⚠️   [ ${path.basename(__filename).split('.')[0]} ] Could not configure Hub connection on device ${deviceId} (${resolvedIp}:${discovered.commandPort}) — it may need 'ndpi_hub_hostname'/'ndpi_hub_port' set manually on the device.`, result); }

                // Start relaying this device's /ws/system + /ws/stats right
                // away using the ip/port mDNS already gave us — its own
                // next client-status report will correct the port if the
                // device's real API port differs from the mDNS commandPort.
                this.ensureDeviceRelayConnections(deviceId, resolvedIp, discovered.commandPort);
            }

            res.json({ success: true, device: client, hubConfigured });
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
            this.closeDeviceRelayConnections(deviceId);
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
    }

    /**
     *  Resolution & Hub System Control API
     */
    __RoutesSystem() {
        const CRLFArray = (string = '') => string.split(/\r?\n/);

        // Liveness check for the frontend's offline-recovery loop (see
        // 01-scripts/ws-client.js) -- polled once/sec after the GUI
        // WebSocket drops, to detect the moment the Hub is reachable again
        // (vs. the WebSocket itself, which may take longer to notice).
        // Deliberately no dependency on any other subsystem: just confirms
        // the HTTP server itself is up and responding.
        this.Routes
        .route('/api/ping')
        .get((req, res) => {
            res.json({ success: true });
        });

        // Generic write path for the Hub's own settings (hub_fs.js's
        // fileMap) -- the Hub-side equivalent of Client__v3_1_0's remote
        // settings editor (`set-setting` command -> this.settings.put()).
        // Same shape as the per-device settings route
        // (deviceCommandRoute('setting', ...), body: {name, value}), and
        // deliberately just as permissive: like the Client's own
        // updateSetting(), this only checks that the key exists, it doesn't
        // enforce allowEditExternal server-side (that flag is UI-only).
        // Currently used for output_display_resolution_preference (Display
        // Resolution on settings.html) -- writing it triggers the existing
        // this.settings.on('output_display_resolution_preference', ...)
        // listener in server.js, which calls func.setDisplayResolution()
        // (xrandr + openbox restart), exactly mirroring how the Client
        // applies its own output_display_resolution_preference changes.
        // Single-setting read, mirroring the write route below. Lets a page
        // apply a Hub-wide setting (e.g. ui_theme_color) on load with one
        // small GET instead of opening /ws/system just to read one value.
        this.Routes
        .route('/api/setting/:name')
        .get((req, res) => {
            const value = this.settings.get(req.params.name);
            if (value === null)
            { return res.status(404).json({ error: true, message: `Unknown setting: ${req.params.name}` }); }

            res.json({ name: req.params.name, value });
        });

        this.Routes
        .route('/api/setting')
        .post((req, res) => {
            const { name, value } = req.body;
            if (!name)
            { return res.status(400).json({ error: true, message: 'Missing setting name' }); }
            if (this.settings.get(name) === null)
            { return res.status(404).json({ error: true, message: `Unknown setting: ${name}` }); }

            this.settings.put(name, String(value ?? ''));
            res.json({ success: true });
        });

        // Optional Hub-branding override for the sidebar/login logo
        // (hub_fs.js's custom-logo.json, uploaded from settings.html).
        // GET always succeeds -- serves the uploaded image if one exists,
        // otherwise redirects to the bundled default SVG -- so every page
        // can point at this single URL (styles.css's .topbar-logo
        // background-image, the auth-flow pages' <img>) without needing
        // any JS to pick between "custom" and "default".
        this.Routes
        .route('/api/logo')
        .get((req, res) => {
            const logo = this.settings.getCustomLogo();
            const match = logo && logo.dataUrl ? /^data:([^;]+);base64,(.+)$/s.exec(logo.dataUrl) : null;
            if (!match)
            { return res.redirect('/media/logo-page-header.svg'); }

            res.set('Cache-Control', 'no-cache');
            res.type(match[1]).send(Buffer.from(match[2], 'base64'));
        })
        .post((req, res) => {
            const { name, type, dataUrl } = req.body;
            if (!dataUrl || !/^data:image\/(png|jpe?g|svg\+xml|webp|gif);base64,/.test(dataUrl))
            { return res.status(400).json({ error: true, message: 'Upload must be a PNG, JPEG, WEBP, GIF, or SVG image' }); }
            // Base64 text runs ~4/3 the original byte size -- 2MB of
            // encoded text is a generous cap for a logo image.
            if (dataUrl.length > 2 * 1024 * 1024)
            { return res.status(400).json({ error: true, message: 'Image is too large (2MB max)' }); }

            this.settings.setCustomLogo({ name: name || 'logo', type: type || '', dataUrl, dateUploaded: new Date().toISOString() });
            res.json({ success: true });
        })
        .delete((req, res) => {
            this.settings.setCustomLogo(null);
            res.json({ success: true });
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

        // Software update for the Hub itself -- same sh/check-for-update and
        // sh/install-update scripts the Client uses on itself, just run
        // directly here instead of over a device command channel (there's
        // no "other machine" to relay to; the Hub is checking/updating its
        // own install). Result lands in the ndpi_version_update_available /
        // ndpi_version_update_version settings (hub_fs.js), which the
        // already-existing /ws/system feed pushes to the browser.
        this.Routes
        .route('/api/system/check-for-update')
        .post((req, res) => {
            res.json({ success: true, message: 'Checking for update...' });
            func.checkForUpdate().catch((error) => {
                console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, 'check-for-update', error.message);
            });
        });

        this.Routes
        .route('/api/system/install-update')
        .post((req, res) => {
            res.json({ success: true, message: 'Installing update...' });
            func.updateInstall().catch((error) => {
                console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, 'install-update', error.message);
            });
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
            else if (pathname === '/ws/system')
            {
                this.ws_serv_hub_system.handleUpgrade(request, socket, head, (ws) => {
                    this.ws_serv_hub_system.emit('connection', ws, request);
                });
            }
            else if (pathname === '/ws/stats')
            {
                this.ws_serv_hub_stats.handleUpgrade(request, socket, head, (ws) => {
                    this.ws_serv_hub_stats.emit('connection', ws, request);
                });
            }
            else if (pathname === '/ws/devices/system')
            {
                this.ws_serv_devices_system.handleUpgrade(request, socket, head, (ws) => {
                    this.ws_serv_devices_system.emit('connection', ws, request);
                });
            }
            else if (pathname === '/ws/devices/stats')
            {
                this.ws_serv_devices_stats.handleUpgrade(request, socket, head, (ws) => {
                    this.ws_serv_devices_stats.emit('connection', ws, request);
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
        try { this.ws_serv_hub_system?.close(); } catch {}
        try { this.ws_serv_hub_stats?.close(); } catch {}
        try { this.ws_serv_devices_system?.close(); } catch {}
        try { this.ws_serv_devices_stats?.close(); } catch {}

        // The wss.close() calls above only stop each server from accepting
        // *new* connections -- per the `ws` library (these all run in
        // `noServer` mode), close() does NOT close already-open client
        // connections, and it won't emit its own 'close' event until they
        // disconnect on their own. `this.Server.closeAllConnections()` /
        // `this.Server.close()` further below don't reach them either,
        // since ownership of the socket is handed off to `ws` during the
        // 'upgrade' event and Node's http server stops tracking it.
        // Confirmed empirically: without this, `this.Server.close()`'s
        // callback simply never fires while any browser tab or Client
        // device is still connected -- which is effectively always -- so
        // every graceful shutdown was silently falling through to the 10s
        // forced-exit watchdog in server.js's quitNDPi(). terminate() (not
        // close()) is used deliberately: we're forcing a shutdown, not
        // negotiating one, and terminate() doesn't wait on a close
        // handshake the other end may never complete.
        const terminate = (ws) => { try { ws.terminate(); } catch {} };
        this.ws_conn_gui.forEach(terminate);
        this.ws_conn_hub_system.forEach(terminate);
        this.ws_conn_hub_stats.forEach(terminate);
        this.ws_conn_devices_system.forEach(terminate);
        this.ws_conn_devices_stats.forEach(terminate);
        this.ws_conn_sources.forEach(terminate);
        this.deviceConnections.forEach(terminate);
        this.ws_conn_gui.clear();
        this.ws_conn_hub_system.clear();
        this.ws_conn_hub_stats.clear();
        this.ws_conn_devices_system.clear();
        this.ws_conn_devices_stats.clear();
        this.ws_conn_sources.clear();
        this.deviceConnections.clear();

        if (this.hubStatsSendInterval)
        {
            clearInterval(this.hubStatsSendInterval);
            this.hubStatsSendInterval = null;
        }

        // this.closing is already true at this point, so the 'close'
        // handlers in connectDeviceSystemRelay()/connectDeviceStatsRelay()
        // won't try to reconnect — clear/close explicitly too as a backstop.
        this.deviceSystemSockets.forEach((entry) => {
            clearTimeout(entry.reconnectTimer);
            try { entry.ws.removeAllListeners(); entry.ws.close(); } catch {}
        });
        this.deviceSystemSockets.clear();

        this.deviceStatsSockets.forEach((entry) => {
            clearTimeout(entry.reconnectTimer);
            try { entry.ws.removeAllListeners(); entry.ws.close(); } catch {}
        });
        this.deviceStatsSockets.clear();

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