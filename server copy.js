/**
 *  NDPi - Monitor v3 (SERVER)
 *      Created By: Evan Smith
 *      On Behalf of: New Life Church COGOP - Atlantic
 * 
 *  This service is used for:
 *  -   Managing Client NDPi - Monitor Devices within the local network.
 *  -   Serve the Web Graphical User Interface
 *  -   Serve Html overlays for OBS
 */

const express               = require('express');
const http                  = require('http');
const WebSocket             = require('ws');
const path                  = require('path');
const os                    = require('os');
const bonjour               = require('bonjour')();
const fs                    = require('fs');
const crypto                = require('crypto');
const { spawn, exec }       = require('child_process');
const { stdout, stderr }    = require('process');
const { DOMParser }         = require('@xmldom/xmldom');
const { json }              = require('stream/consumers');
const { clearTimeout, setTimeout }      = require('timers');

const ACCOUNTS_FILE             = path.join(__dirname, 'accounts.json');
let accounts                    = new Map(); 
const ROKU_TVS_FILE             = path.join(__dirname, 'rokuTvs.json');
let rokuTvs                     = [];
const FAVORITED_SOURCES_FILE    = path.join(__dirname, 'favorited-sources.json');
const CLIENTS_FILE              = path.join(__dirname, 'clients.json');
const GROUPS_FILE               = path.join(__dirname, 'groups.json');

/**
 *  VERSION CONTROL
 */
const versionCurrent  = path.join(__dirname, 'version', 'current');
const versionStable   = path.join(__dirname, 'version', 'stable');
const versionIsStable = versionCurrent === versionStable;
/** END of - VERSION CONTROL **/
function startupConsoleLog() {
    console.log(`
════════════════════════════════════════════════════════════════
  ⌈▔∖ ⌈▔⌈▔▔▔▔∖⌈▔▔▔▔∖(-)   ⌈▔▔∖/▔▔|           (-) ▔▏           
  ⏐  ∖⏐ ⏐ ⌈▔| ⏐ ⌈-) ⌈▔|   ⏐ ⌈∖/| ⏐/▔▔▔∖⌈▔'▔▔∖⌈▔|▏ ▔/▔▔▔∖⌈▔'▔▔|
  ⏐ ⌈∖  ⏐ ⌊_| ⏐  __/⏐ ⏐▔▔▔⏐ ⏐  ⏐ ⏐ (-) ⏐ ⌈▔⏐ ⏐ ⏐▏ ⎡▏(-) ⏐ ⌈▔▔             
  ⌊_| ∖_⌊____/⌊_|   ⌊_|▔▔▔⌊_|  ⌊_|∖___/⌊_| ⌊_⌊_|∖__∖___/⌊_|              𓀡

  N D P i - M O N I T O R            𝘝𝘦𝕣𝕤𝕚𝕠𝕟   ⸻      ${versionCurrent}${versionIsStable ? ' (Stable)' : ''}
════════════════════════════════════════════════════════════════
`);
}
startupConsoleLog();
const CRLFArray = (string = '') => { return string.split(/\r?\n/); }
let localIp = getServerIP();
/** Begin Heartbeat to all Web GUI sessions.
 *  @param {number} heartbeatInterval - Time in ms between WebSocket heartbeats (10000 = 10sec).
 *  @function broadcastToGUI() - Function used to send WebSocket message.
 */
const heartbeatInterval = 10000;
setInterval(() => {
    broadcastToGUI({
        type: 'heartbeat',
        origin: `Server Interval (${localIp})`,
        timestamp: Date.now()
    });
}, heartbeatInterval);
/** Begin Roku Status Updates to all Web GUI sessions.
 *  @constant {number} rokuStatusUpdateInterval - Time in ms between updates (20000 = 20sec).
 *  @function getRokuTvInfo() - Function used to retrieve all Roku device status update.
 *  @function broadcastToGUI() - Function used to send WebSocket message.
 */
const rokuStatusUpdateInterval = 20000;
setInterval(async () => {
    const rokuTvData = await getRokuTvInfo();
    broadcastToGUI({
        type: 'roku-update',
        origin: `Server Interval (${localIp})`,
        data: rokuTvData
    });
}, rokuStatusUpdateInterval);
/** Begin NDI Source Updates to all Web GUI sessions.
 *  @constant {number} ndiSourceUpdateInterval - Time in ms between updates (10000 = 10sec).
 *  @function getNDISources() - Function used to retrieve active NDI sources.
 *  @function broadcastToGUI() - Function used to send WebSocket message.
 */
const ndiSourceUpdateInterval = 10000;
setInterval(async () => {
    sources = await getNDISources();
    broadcastToGUI({
        type: 'ndi-sources',
        origin: `Server Interval (${localIp})`,
        sources: sources
    });
}, ndiSourceUpdateInterval);
/** Begin NDI Source Updates to all Web GUI sessions.
 *  @constant {number} systemStatsUpdateInterval - Time in ms between updates (10000 = 10sec).
 *  @function getNDISources() - Function used to retrieve active NDI sources.
 *  @function broadcastToGUI() - Function used to send WebSocket message.
 */
const systemStatsUpdateInterval = 5000;
setInterval(async () => {
    try {
        const stats = await getSystemStats();
        broadcastToGUI({
            type: 'system-stats',
            origin: `Server Interval (${localIp})`,
            stats: stats
        });
    } catch (error) {
        console.error('Error getting system stats:', error);
    }
}, systemStatsUpdateInterval); 

/** WebSocket Servers:
 *  - Web GUI
 *  - Client Devices
 */
const wsDevice = new WebSocket.Server({ noServer: true });
const wsGUI = new WebSocket.Server({ noServer: true });
const wsConsole = new WebSocket.Server({ noServer: true });
/** WebSocket Server active connections.
 *      For @const wsDevice - Server ⮂ Device
 *      @const clientDevices @implements {
 *          deviceId:string { ws:WebSocket, status:Object, lastUpdate:Date }
 *      }
 * 
 *      For @const wsGUI - Server ⮂ Web GUI
 *      @const guiClients @implements {
 *          ws:WebSocket { accountId, accountName, connectedAt }
 *      }
 *      @const activeViewers @implements {
 *          accountId:string { name, username, connectedAt }
 *      }
 */
const clientDevices = new Map();
const guiClients = new Map();
const activeViewers = new Map();
const guiConsoleUsers = new Map();
wsDevice.on('connection', (_ws) => {
    console.log('Client device connected | WebSocket');
    let deviceId = null;
    _ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            
            if (message.type === 'client-status') {
                deviceId = message.deviceId;
                
                clientDevices.set(deviceId, {
                    ws: _ws,
                    status: message,
                    lastUpdate: Date.now()
                });
                
                if (clients.has(deviceId)) {
                    const client = clients.get(deviceId);
                    client.currentSource = message.currentSource;
                    client.displayMode = message.displayMode;
                    client.ndiInfo = message.ndiInfo;
                    client.systemStats = message.systemStats;
                    client.streamStatus = message.status;
                    client.lastStatusUpdate = new Date().toISOString();
                    clients.set(deviceId, client);
                    saveClients();
                }

                ///
                ///     Try the following for the above 'if' statement
                ///

                const savedClient = clients.get(deviceId);
                const updateClient = message;
                patchObject(savedClient, updateClient);
                clients.set(deviceId, savedClient);
                saveClients();

                function patchObject(target, update) {
                    Object.entries(update).forEach(([key, value]) => {
                        if (value !== undefined) {
                            target[key] = value;
                        }
                    });
                    return target;
                }

                ///
                /// 
                ///                 
                
            } else if (message.type === 'pong') {
                // Heartbeat response
                if (clientDevices.has(message.deviceId)) {
                    const device = clientDevices.get(message.deviceId);
                    device.lastUpdate = Date.now();
                }
            }
        } catch (error) {
            console.error('Client WebSocket message error:', error);
        }
    });
    _ws.on('close', () => {
        console.log(`Client device disconnected: ${deviceId || 'unknown'}`);
        if (deviceId) {
            clientDevices.delete(deviceId);
            if (clients.has(deviceId)) {
                const client = clients.get(deviceId);
                client.streamStatus = 'disconnected';
                clients.set(deviceId, client);
                saveClients();
            }
        }
    });
    _ws.on('error', (error) => {
        console.error('Client WebSocket error:', error);
        if (deviceId) {
            clientDevices.delete(deviceId);
        }
    });
});
wsGUI.on('connection', (_ws) => {
    let clientInfo = {
        accountId: null,
        accountName: 'Anonymous',
        connectedAt: Date.now()
    };
    guiClients.set(_ws, clientInfo);

    _ws.send(JSON.stringify({ 
        type: 'connected',
        message: 'Connected to NDPi Monitor Server'
    }));
    _ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            
            if (message.type === 'viewer-join') {
                // User has signed in and is viewing
                clientInfo.accountId = message.accountId;
                clientInfo.accountName = message.accountName;
                
                activeViewers.set(message.accountId, {
                    name: message.accountName,
                    username: message.username,
                    connectedAt: Date.now()
                });

                // Broadcast updated viewer list
                broadcastViewers(`wsGUI message = 'viewer-join'`);
            }
            else if (message.type === 'viewer-leave') {
                // User is leaving
                if (clientInfo.accountId) {
                    activeViewers.delete(clientInfo.accountId);
                    broadcastViewers(`wsGUI message = 'viewer-leave'`);
                }
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });
    _ws.on('close', () => {
        if (clientInfo.accountId) {
            activeViewers.delete(clientInfo.accountId);
            broadcastViewers('wsGUI close');
        }
        //guiClients.delete(wsGUI);
        guiClients.delete(_ws);
    });
    _ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        if (clientInfo.accountId) {
            activeViewers.delete(clientInfo.accountId);
            broadcastViewers('wsGUI error');
        }
    });
});
wsConsole.on('connection', async (_ws) => {

    const CRLFArray = string => string.split(/\r?\n/);
    const socketID = crypto.randomUUID();
    let child = null;
    let workingDir = await __printWorkingDirectory();
    guiConsoleUsers.set(socketID, _ws);
    
    // Get the current working directory upon initial connection.
    async function __printWorkingDirectory() {
        console.log('Printing Working Directory');
        let response = '';
        await new Promise((resolve) => {
            child = exec('pwd', {
                env: {
                    ...process.env,
                    DISPLAY: ':0',
                    XAUTHORITY: `${process.env.HOME}/.Xauthority`
                },
                stdio: ['ignore', 'pipe', 'pipe']
            });
            child.stdout.on('data', (data) => {
                const output = data.toString().trim();
                console.log('New GUI Terminal Em: ', `PWD: ${output}`);
                response = output;
            });
            child.stderr.on('data', (data) => {
                const output = data.toString().trim();
                console.log('PWD Error: ', output);
                response = output;
            });
            child.on('exit', () => {
                child = null;
            });
            child.on('close', () => {
                resolve();
            });
        });
        return response;
    }

    // Session function reference used to send responses back to client GUI
    // data: Array of command response lines.
    // Send 'keepOpen' as false to allow the browser terminal to re-enable.
    function __respond(data, keepOpen = true) {
        _ws.send(JSON.stringify({
            type: 'response',
            data: data,
            keepOpen: keepOpen,
            pwd: workingDir,
        }));
    }

    function __killChildProcess() {
        if (child) {
            const procID = Math.floor(child.pid + 1);
            console.log('GUI Console Kill Command Received.', 'PID:', procID);
            if (procID > 10) {
                try {
                    process.kill(procID, 'SIGTERM');
                } catch (e) {
                    console.log("Error: Attempted to kill a process that doesn't exist:", procID);
                }
            }
        }
    }

    // Send an initial connection message.
    _ws.send(JSON.stringify({ 
        type: 'connected',
        data: [{
            message: `Connected to NDPi Monitor Server - Session: ${socketID}` ,
        }],
        pwd: workingDir,
        hostname: os.hostname()
    }));

    _ws.on('message', (data) => {
        const message = JSON.parse(data);

        // Messages received by this WebSocket only handle message.type 'command'
        if (!String(message.type).includes('command')) return;

        if (message.type === 'command-kill') {
            __killChildProcess();
            __respond([{
                message: null,
                font: {
                    color: '#e1e1e1',
                    weight: '400',
                },
            }], false);
            return;
        }

        // exec() options
        let options = {
            detached: true,
            env: {
                ...process.env,
                DISPLAY: ':0',
                XAUTHORITY: `${process.env.HOME}/.Xauthority`
            },
            cwd: workingDir
        };

        let commandAmpParse = [];
        if (`${message.command}`.includes(' && ')) {
            commandAmpParse = `${message.command}`.split(' && ');
        } else {
            commandAmpParse = [ `${message.command}` ];
        }

        ___processCommands(commandAmpParse);

        async function ___processCommands(commands = []) {
            let promptID = crypto.randomUUID();
            let loopError = false;
            let currentCount = 0;
            let totalCount = commands.length;
            console.log('Processing Command Batch: ');
            console.log(`${promptID}:`.toUpperCase(), JSON.stringify(commandAmpParse));

            for (const command of commands) {

                if (loopError) break;

                currentCount++
                console.log(`Running Command ${currentCount} of ${totalCount} from GUI: [${command}]`);

                await new Promise((resolve) => {
                    child = exec(command, options);
                    child.stdout.on('data', (data) => {
                        const output = data.toString().trim();
                        const outputArry = [];
                        CRLFArray(output).forEach((line) => {
                            outputArry.push({
                                message: String(line),
                                font: {
                                    color: '#e1e1e1',
                                    weight: String(line).includes('*') ? '600' : '400',
                                },
                            });
                        });
                        __respond(outputArry);
                    });
                    child.stderr.on('data', (data) => {
                        loopError = true;
                        const output = data.toString().trim();
                        const outputArry = [];
                        CRLFArray(output).forEach((line) => {
                            outputArry.push({
                                message: String(line),
                                font: {
                                    color: '#ff0000',
                                    weight: String(line).includes('*') ? '600' : '400',
                                },
                            });
                        });
                        console.log('stderr.on data:', outputArry);
                        __respond(outputArry);
                    });
                    child.on('error', (err) => {
                        loopError = true;
                        const output = err.toString().trim();
                        __respond([{
                            message: output,
                            font: {
                                color: '#b00000',
                                weight: '400',
                            },
                        }]);
                    });
                    child.on('exit', () => {
                        // Handle changing directories.
                        if (!loopError && command.startsWith('cd ')) {
                            const parseCmdArgs = command.split(' ');
                            if (parseCmdArgs[1].startsWith('../')) {
                                let dirTree = workingDir.split('/');
                                dirTree.pop();
                                workingDir = dirTree.join('/');
                            } else if (parseCmdArgs[1].startsWith('/')) {
                                workingDir = parseCmdArgs[1];
                            } else {
                                workingDir += `/${parseCmdArgs[1]}`;
                            }
                            if (`${workingDir}`.includes('//')) {
                                `${workingDir}`.replaceAll('//', '/');
                            }
                            options.cwd = workingDir;
                            console.log('Session Directory Update: ', workingDir);
                        }
                        child = null;
                        resolve();
                    });
                    child.on('close', () => {
                        if (currentCount === totalCount || loopError) {
                            __respond([{
                                message: null,
                                font: {
                                    color: '#e1e1e1',
                                    weight: '400',
                                },
                            }], false);
                        }
                    });
                });
            }
            console.log('Batch ', `${promptID}`.toUpperCase(), ` ${loopError ? 'ERROR. EXIT' : 'COMPLETE'}`);
        }
    });

    _ws.on('error', (error) => {
        console.error('Console WebSocket Error:', error);
    });
    
    _ws.on('close', () => {
        __killChildProcess();
        guiConsoleUsers.delete(socketID);
    });
});
setInterval(() => {
    console.log('Active GUI Console Count:', guiConsoleUsers.size);
}, 5000);
/** HTTP Server Application
 *  @param PORT 3000
 *  @const _api @function express() - Server Application Framework
 */
const PORT = process.env.PORT || 3000;
const _api = express();
const server = http.createServer(_api);
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Web interface: http://${localIp}:${PORT}`);
});
server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    
    if (pathname === '/ws') {
        wsGUI.handleUpgrade(request, socket, head, (ws) => {
            wsGUI.emit('connection', ws, request);
        });
    } else if (pathname === '/ws/client') {
        wsDevice.handleUpgrade(request, socket, head, (ws) => {
            wsDevice.emit('connection', ws, request);
        });
    } else if (pathname === '/ws/console') {
        wsConsole.handleUpgrade(request, socket, head, (ws) => {
            wsConsole.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});
/** Send WebSocket Message
 *  @function broadcastToGUI() - Primary structured function for sending updates to Web GUI
 */
function broadcastToGUI(message) {
    const data = JSON.stringify(message);
    guiClients.forEach((clientInfo, client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}
function broadcastViewers(origin = '') {
    const viewers = Array.from(activeViewers.values());
    broadcastToGUI({
        type: 'active-viewers',
        origin: origin,
        viewers: viewers
    });
    console.log('Active Users Online:');
    console.log(viewers);
}

let clients = new Map(); // Saved/added clients
let discoveredClients = new Map(); // Clients seen via mDNS but not saved yet
let groups = new Map();

/**
 *  Server GUI
 */
_api.use(express.json());
_api.use('/media', express.static(path.join(__dirname, 'assets', 'gui', 'media')));
_api.use('/custom-media', express.static(path.join(__dirname, 'assets', 'gui', 'custom-media')));
_api.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, path) => {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    }
}));
// Start (Home) Page
_api.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.sendFile(path.join(__dirname, 'public', 'dashboard', 'dashboard.html'));
});
// Other Pages - Rendered At the End.

/**
 *  Server API
 */
const getOrigin = (req) => {
    return `${req.header('origin') || req.header('host') || 'origin/host not listed'}`;
}

_api.get('/api/resolution', (req, res) => {
    exec('xrandr', (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({ error: true, message: stderr });
        } else {
            let resObj = {};
            const arr = CRLFArray(stdout)
            arr[0].split(', ').forEach((ln) => {
                if (ln.includes('current')) {
                    const splt = ln.trim().split(' ');
                    resObj.currentSize = `${splt[1]}x${splt[3]}`;
                }
            });

            resObj.resolutionOptions = [];
            
            arr.forEach((ln) => {
                const str = ln.trim();
                if (
                    str.startsWith('1') || 
                    str.startsWith('2') || 
                    str.startsWith('3') || 
                    str.startsWith('4') || 
                    str.startsWith('5') || 
                    str.startsWith('6') || 
                    str.startsWith('7') || 
                    str.startsWith('8') || 
                    str.startsWith('9')
                ) {
                    resObj.resolutionOptions.push(str.split(' ')[0]);
                }
            });
            res.json(resObj);
        }
    });
});
_api.post('/api/resolution', express.json(), (req, res) => {
    const { output, resolution, rate } = req.body;
    console.log(req.body);
    if (!resolution) {
        return res.status(400).json({
            error: true,
            message: 'Missing resolution. (e.g. 1920x1080)',
        });
    }
    let cmdStr = ``;

    exec(`xrandr --output ${output ? output : 'HDMI-1'} --mode ${resolution}${rate ? ` --rate ${rate}` : ''}`, (error, stdout, stderr) => {
        if (error) {
            res.status(400).json({
                error: true,
                message: stderr
            });
        } else {
            res.json({
                error: false,
                message: `Resolution set: ${resolution}.`
            });
        }
    });
});

_api.get('/api/system-logs', (req, res) => {
    exec('sudo journalctl --no-pager -n 100', (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({ error: true, message: stderr });
        } else {
            const arr = CRLFArray(stdout)
            res.json(arr);
        }
    });
});

_api.get('/api/favorite-ndi-sources', (req, res) => {
    try {
        if (fs.existsSync(FAVORITED_SOURCES_FILE)) {
            const data = fs.readFileSync(FAVORITED_SOURCES_FILE, 'utf8');
            const favoritedSources = JSON.parse(data);
            res.json(Array.isArray(favoritedSources) ? favoritedSources : []);
        } else {
            res.json([]);
        }
    } catch (error) {
        console.error('Error reading favorited sources:', error);
        res.json([]);
    }
});
_api.post('/api/favorite-ndi-sources', express.json(), (req, res) => {
    const updateArray = req.body;
    
    if (!Array.isArray(updateArray)) {
        return res.status(400).json({ error: 'Request body must be an array' });
    }
    
    try {
        fs.writeFileSync(FAVORITED_SOURCES_FILE, JSON.stringify(updateArray, null, 2));
        res.json({ success: true, message: 'Favorited sources updated', count: updateArray.length });
    } catch (error) {
        console.error('Failed to save favorited sources:', error);
        res.status(500).json({ error: 'Failed to save favorited sources' });
    }
});
_api.get('/api/ndi-sources/:favorite?', async (req, res) => {
    const { favorite } = req.params;
    let sources = [];
    if (favorite) {
        try {
            if (fs.existsSync(FAVORITED_SOURCES_FILE)) {
                const data = fs.readFileSync(FAVORITED_SOURCES_FILE, 'utf8');
                sources = JSON.parse(data);
            }
        } catch (error) {
            console.error('Error reading favorited sources:', error);
        }
    } else {
        sources = await getNDISources();
    }
    res.json(sources);
});

_api.post('/api/account/create', express.json(), (req, res) => {
    const { firstName, lastName, username, pin } = req.body;
    /**
     *  Validate
     *  Required fields
     */
    if (!firstName || !lastName || !username || !pin) {
        return res.status(400).json({ error: 'All fields required' });
    }
    /**
     *  Validate
     *  PIN Length
     */
    if (!/^\d{4}$|^\d{5}$|^\d{6}$/.test(pin)) {
        return res.status(400).json({ error: 'PIN must be 4-6 digits' });
    }
    /**
     *  Validate
     *  No Duplicate Usernames
     */
    for (const account of accounts.values()) {
        if (account.username.toLowerCase() === username.toLowerCase()) {
            return res.status(400).json({ error: 'Username already exists' });
        }
    }
    const accountId = crypto.randomUUID();
    accounts.set(accountId, {
        id: accountId,
        firstName,
        lastName,
        username,
        pinHash: hashPIN(pin),
        createdAt: new Date().toISOString(),
        isAdmin: false,
        firstTimeLogin: true,
    });
    
    saveAccounts();
    
    res.json({ 
        success: true, 
        accountId,
        message: 'Account created successfully.'
    });
});
_api.post('/api/account/signin', express.json(), (req, res) => {

    const host = req.get('host');
    
    if (host.includes(`localhost:${PORT}`)) {
        for (const account of accounts.values()) {
            if (account.isSystemAccount) {
                return res.json({
                    success: true,
                    account: {
                        token: account.pinHash,
                        id: account.id,
                        firstName: account.firstName,
                        lastName: account.lastName,
                        username: account.username,
                        isAdmin: account.isAdmin,
                        firstTimeLogin: account.firstTimeLogin || false
                    }
                });
            }
        }
    }

    const { pin } = req.body;
    
    if (!pin) {
        return res.status(400).json({ error: 'PIN required' });
    }
    
    const pinHash = hashPIN(pin);
    
    for (const account of accounts.values()) {
        if (account.pinHash === pinHash) {
            return res.json({
                success: true,
                account: {
                    token: account.pinHash,
                    id: account.id,
                    firstName: account.firstName,
                    lastName: account.lastName,
                    username: account.username,
                    isAdmin: account.isAdmin || false,
                    firstTimeLogin: account.firstTimeLogin || false
                }
            });
        }
    }
    res.status(401).json({ error: 'Invalid PIN' });
});
_api.post('/api/account', express.json(), (req, res) => {
    const { token } = req.body;
    
    if (!token) {
        return res.status(400).json({ success: false, message: 'Invalid Request' });
    }
    
    // Find account matching pinHash to token
    for (const account of accounts.values()) {
        if (account.pinHash === token) {
            return res.json({
                success: true,
                account: {
                    id: account.id,
                    firstName: account.firstName,
                    lastName: account.lastName,
                    username: account.username,
                    isAdmin: account.isAdmin || false,
                    lastLogOn: new Date().toISOString()
                }
            });
        }
    }
    res.status(401).json({ success: false, message: 'Invalid Token' });
});
_api.get('/api/account/:id', (req, res) => {
    const account = accounts.get(req.params.id);
    if (!account) {
        return res.status(404).json({ error: 'Account not found' });
    }
    res.json({
        id: account.id,
        firstName: account.firstName,
        lastName: account.lastName,
        username: account.username,
        isAdmin: account.isAdmin || false,
        createdAt: account.createdAt
    });
});
_api.put('/api/account/:id', express.json(), (req, res) => {
    const account = accounts.get(req.params.id);
    
    if (!account) {
        return res.status(404).json({ error: 'Account not found' });
    }
    
    const updates = req.body;
    const allowedFields = ['firstName', 'lastName', 'username', 'pin', 'isAdmin'];
    const adminFields = ['isAdmin'];
    
    // Check if username is being changed and if it's taken
    if (updates.username && updates.username !== account.username) {
        const existingAccount = Array.from(accounts.values()).find(
            acc => acc.username === updates.username && acc.id !== req.params.id
        );
        if (existingAccount) {
            return res.status(400).json({ error: 'Username already taken' });
        }
    }
    
    // Check if trying to update admin fields
    const isUpdatingAdminFields = adminFields.some(field => field in updates);
    if (isUpdatingAdminFields) {
        const requestorId = updates.requestorId || req.headers['x-requestor-id'];
        const requestorAccount = accounts.get(requestorId);
        
        if (!requestorAccount || !requestorAccount.isAdmin) {
            return res.status(403).json({ error: 'Only admin users can manage admin privileges' });
        }
        
        // Prevent admin from removing their own admin privileges
        if (req.params.id === requestorId && updates.isAdmin === false) {
            return res.status(400).json({ error: 'Cannot remove your own admin privileges' });
        }
    }
    
    // Apply updates
    for (const [key, value] of Object.entries(updates)) {
        if (!allowedFields.includes(key)) continue;
        
        if (key === 'pin') {
            if (!/^\d{4}$|^\d{5}$|^\d{6}$/.test(value)) {
                return res.status(400).json({ error: 'PIN must be 4-6 digits' });
            }
            account.pinHash = hashPIN(value);
        } else {
            account[key] = value;
        }
    }
    
    // Clear first time login flag if PIN was updated
    if ('pin' in updates) {
        account.firstTimeLogin = false;
    }
    
    accounts.set(req.params.id, account);
    saveAccounts();
    
    // Log admin privilege changes
    if ('isAdmin' in updates) {
        const requestorAccount = accounts.get(updates.requestorId);
        console.log(`Admin privileges ${updates.isAdmin ? 'granted to' : 'revoked from'} ${account.firstName} ${account.lastName}${requestorAccount ? ` by ${requestorAccount.firstName} ${requestorAccount.lastName}` : ''}`);
    }
    
    res.json({ 
        success: true, 
        message: 'Account updated successfully',
        account: {
            id: account.id,
            firstName: account.firstName,
            lastName: account.lastName,
            username: account.username,
            isAdmin: account.isAdmin || false,
            createdAt: account.createdAt
        }
    });
});
_api.delete('/api/account/:id', (req, res) => {
    const account = accounts.get(req.params.id);
    
    if (!account) {
        return res.status(404).json({ error: 'Account not found' });
    }
    
    // Prevent deleting the last admin account
    const adminAccounts = Array.from(accounts.values()).filter(acc => acc.isAdmin);
    if (account.isAdmin && adminAccounts.length === 1) {
        return res.status(400).json({ error: 'Cannot delete the last admin account' });
    }
    
    accounts.delete(req.params.id);
    saveAccounts();
    
    res.json({ success: true });
});
_api.get('/api/admin/accounts', (req, res) => {
    // TODO: Add admin authentication middleware
    const accountList = Array.from(accounts.values()).map(acc => ({
        id: acc.id,
        firstName: acc.firstName,
        lastName: acc.lastName,
        username: acc.username,
        isAdmin: acc.isAdmin || false,
        createdAt: acc.createdAt
    }));
    
    res.json({ accounts: accountList });
});
_api.get('/api/active-viewers', (req, res) => {
    const viewers = Array.from(activeViewers.values());
    res.json({ viewers });
});

_api.get('/api/discovered-devices', (req, res) => {
    const discovered = Array.from(discoveredClients.values())
        .filter(device => !clients.has(device.deviceId)) // Only show ones not already added
        .map(device => ({
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            ip: device.ip,
            status: 'discovered'
        }));
    res.json({ devices: discovered });
});

_api.get('/api/roku-tvs', (req, res) => {
    res.json({ rokuTvs });
});
_api.post("/api/roku-info", express.json(), async (req, res) => {
    const { ipAddress } = req.body;
    if (!ipAddress) {
        return res.status(400).json({ error: `IP Address for RokuTv is required. ${ipAddress}` });
    }
    console.log(`Getting status from RokuTv: ${ipAddress}`);
    try {
        const response = await fetch(`http://${ipAddress}:8060/query/device-info`, {
			method: 'GET',
			headers: { 'Accept': 'application/xml' }
		});
        const text = await response.text();
        res.status(200).send(text)
    } catch (err) {
        res.status(500).send("Failed to reach Roku");
    }
});
_api.post('/api/roku-tv', express.json(), (req, res) => {
    const { displayName, ipAddress, model, manufacturer, deviceType, screenSize, groupId } = req.body;
    
    if (!ipAddress || !groupId) {
        return res.status(400).json({ error: 'IP address and group ID are required' });
    }
    
    // Check if IP already exists
    const existing = rokuTvs.find(tv => tv.ipAddress === ipAddress);
    if (existing) {
        return res.status(400).json({ error: 'Roku TV with this IP address already exists' });
    }
    
    const newRokuTv = {
        id: crypto.randomUUID(),
        displayName: displayName || 'Roku TV',
        ipAddress,
        model: model || '',
        manufacturer: manufacturer || 'Roku',
        deviceType: deviceType || 'TV',
        screenSize: screenSize || '',
        groupId,
        createdAt: new Date().toISOString()
    };
    
    rokuTvs.push(newRokuTv);
    saveRokuTvs();
    
    res.json({ success: true, rokuTv: newRokuTv });
});
_api.delete('/api/roku-tv/:id', (req, res) => {
    const index = rokuTvs.findIndex(tv => tv.id === req.params.id);
    if (index === -1) {
        return res.status(404).json({ error: 'Roku TV not found' });
    }
    rokuTvs.splice(index, 1);
    saveRokuTvs();
    res.json({ success: true });
});

_api.get('/api/devices', (req, res) => {
    const devices = Array.from(clients.values()).map(client => ({
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
        groupName: client.groupName || null
    }));
    res.json({ devices });
});
_api.post('/api/device/:id?', express.json(), (req, res) => {
    const deviceId = req.params.id || req.body.deviceId || req.body.id;
    const { deviceName, ip, name } = req.body;
    
    if (!deviceId) {
        return res.status(400).json({ error: 'Device ID required' });
    }
    const client = clients.get(deviceId) || {};
    clients.set(deviceId, {
        ...client,
        deviceId,
        deviceName: deviceName || name || client.deviceName || deviceId,
        ip: ip || client.ip,
        status: client.status || 'offline',
        lastSeen: new Date().toISOString()
    });
    saveClients();

    res.json({ success: true, device: clients.get(deviceId) });
});
_api.delete('/api/device/:deviceId', (req, res) => {
    const { deviceId } = req.params;
    
    if (!clients.has(deviceId)) {
        return res.status(404).json({ error: 'Device not found' });
    }
    
    const deviceName = clients.get(deviceId).deviceName;
    clients.delete(deviceId);
    saveClients();
    
    res.json({ success: true, message: `Forgot device ${deviceName}` });
});
_api.post('/api/devices/forget-all', (req, res) => {
    const count = clients.size;
    clients.clear();
    saveClients();
    
    res.json({ success: true, message: `Forgot ${count} device(s)` });
});
_api.put('/api/device/:deviceId', express.json(), (req, res) => {
    const { deviceId } = req.params;
    const updates = req.body;
    
    if (!clients.has(deviceId)) {
        return res.status(404).json({ error: 'Device not found' });
    }
    
    const client = clients.get(deviceId);
    const allowedFields = ['deviceName', 'ip', 'currentSource', 'group', 'status'];
    const commandFields = ['deviceName', 'currentSource']; // Fields that require client commands
    
    let clientCommands = [];
    
    for (const [key, value] of Object.entries(updates)) {
        if (!allowedFields.includes(key)) continue;
        
        // Prepare client commands for fields that require them
        if (commandFields.includes(key) && value !== client[key]) {
            if (key === 'deviceName') {
                clientCommands.push({ type: 'rename', newName: value });
            } else if (key === 'currentSource') {
                clientCommands.push({ type: 'set-source', sourceName: value });
            }
        }
        
        client[key] = value;
    }
    clients.set(deviceId, client);
    saveClients();
    
    // Send commands to client if needed
    if (clientCommands.length > 0) {
        Promise.allSettled(clientCommands.map(cmd => sendCommandToClient(deviceId, cmd)))
            .then(results => {
                const failures = results.filter(r => r.status === 'rejected');
                if (failures.length > 0) {
                    console.warn(`Some commands failed for device ${deviceId}:`, failures);
                }
            });
    }
    
    res.json({ 
        success: true, 
        message: 'Device updated successfully',
        device: {
            id: client.deviceId,
            deviceId: client.deviceId,
            name: client.deviceName,
            ip: client.ip,
            status: client.status,
            currentSource: client.currentSource || 'None',
            lastSeen: client.lastSeen,
            lastStatusUpdate: client.lastStatusUpdate,
            group: client.group || 'Ungrouped'
        }
    });
});
_api.post('/api/device/:deviceId/shutdown', (req, res) => {
    const { deviceId } = req.params;
    
    if (!clients.has(deviceId)) {
        return res.status(404).json({ error: 'Device not found' });
    }

    sendCommandToClient(deviceId, { type: 'shutdown' })
        .then(() => res.json({ success: true, message: 'Shutdown command sent' }))
        .catch(error => res.status(404).json({ error: error.message }));
});
_api.post('/api/device/:deviceId/reboot', (req, res) => {
    const { deviceId } = req.params;
    
    if (!clients.has(deviceId)) {
        return res.status(404).json({ error: 'Device not found' });
    }

    sendCommandToClient(deviceId, { type: 'reboot' })
        .then(() => res.json({ success: true, message: 'Reboot command sent' }))
        .catch(error => res.status(404).json({ error: error.message }));
});
_api.post('/api/device/:deviceId/overlay', (req, res) => {
    const { deviceId } = req.params;
    
    if (!clients.has(deviceId)) {
        return res.status(404).json({ error: 'Device not found' });
    }

    sendCommandToClient(deviceId, { type: 'overlay' })
        .then(() => res.json({ success: true, message: 'Overlay command sent' }))
        .catch(error => res.status(404).json({ error: error.message }));
});
_api.post('/api/device/:deviceId/blank', (req, res) => {
    const { deviceId } = req.params;
    
    if (!clients.has(deviceId)) {
        return res.status(404).json({ error: 'Device not found' });
    }

    sendCommandToClient(deviceId, { type: 'blank' })
        .then(() => res.json({ success: true, message: 'Blank command sent' }))
        .catch(error => res.status(404).json({ error: error.message }));
});

_api.get('/api/groups', (req, res) => {
    const groupList = Array.from(groups.values()).map(group => ({
        id: group.id,
        name: group.name,
        devices: group.devices || [],
        currentSource: group.currentSource || 'None'
    }));
    res.json({ groups: groupList });
});
_api.post('/api/group', express.json(), (req, res) => {
    const { name, devices } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Group name required' });
    }
    
    const groupId = `group-${Date.now()}`;
    const newGroup = {
        id: groupId,
        name: name,
        devices: devices || [],
        currentSource: null,
        createdAt: new Date().toISOString()
    };
    
    groups.set(groupId, newGroup);
    saveGroups();
    
    res.json({ success: true, group: newGroup });
});
_api.delete('/api/group/:groupId', (req, res) => {
    const { groupId } = req.params;
    
    if (!groups.has(groupId)) {
        return res.status(404).json({ error: 'Group not found' });
    }
    
    const group = groups.get(groupId);
    groups.delete(groupId);
    saveGroups();
    
    res.json({ success: true, message: `Group "${group.name}" deleted` });
});
_api.put('/api/group/:groupId', express.json(), async (req, res) => {
    const { groupId } = req.params;
    const updates = req.body;
    
    if (!groups.has(groupId)) {
        return res.status(404).json({ error: 'Group not found' });
    }
    
    const group = groups.get(groupId);
    const allowedFields = ['name', 'currentSource', 'devices'];
    
    // Check if source is being changed
    const sourceChanged = updates.currentSource !== undefined && updates.currentSource !== group.currentSource;
    
    // Apply updates
    for (const [key, value] of Object.entries(updates)) {
        if (!allowedFields.includes(key)) continue;
        group[key] = value;
    }
    
    groups.set(groupId, group);
    saveGroups();
    
    // If source changed, send to all devices in group
    if (sourceChanged && group.devices && group.devices.length > 0) {
        const sourceName = updates.currentSource || '';
        const promises = group.devices.map(d => 
            sendCommandToClient(d.id || d.deviceId, { 
                type: 'set-source', 
                sourceName: sourceName 
            }).catch(() => {})
        );
        await Promise.all(promises);
    }
    
    res.json({ 
        success: true, 
        message: 'Group updated successfully',
        group: {
            id: group.id,
            name: group.name,
            devices: group.devices || [],
            currentSource: group.currentSource || 'None'
        }
    });
});
_api.post('/api/group/:groupId/shutdown', async (req, res) => {
    const { groupId } = req.params;
    const group = groups.get(groupId);
    
    if (!group) {
        return res.status(404).json({ error: 'Group not found' });
    }

    const promises = group.devices.map(d => 
        sendCommandToClient(d.id || d.deviceId, { type: 'shutdown' }).catch(() => {})
    );
    await Promise.all(promises);
    res.json({ success: true, message: `Shutdown command sent to ${group.devices.length} devices` });
});
_api.post('/api/group/:groupId/reboot', async (req, res) => {
    const { groupId } = req.params;
    const group = groups.get(groupId);
    
    if (!group) {
        return res.status(404).json({ error: 'Group not found' });
    }

    const promises = group.devices.map(d => 
        sendCommandToClient(d.id || d.deviceId, { type: 'reboot' }).catch(() => {})
    );
    await Promise.all(promises);
    res.json({ success: true, message: `Reboot command sent to ${group.devices.length} devices` });
});
_api.post('/api/group/:groupId/overlay', async (req, res) => {
    const { groupId } = req.params;
    const group = groups.get(groupId);
    
    if (!group) {
        return res.status(404).json({ error: 'Group not found' });
    }

    const promises = group.devices.map(d => 
        sendCommandToClient(d.id || d.deviceId, { type: 'overlay' }).catch(() => {})
    );
    await Promise.all(promises);
    res.json({ success: true, message: `Overlay command sent to ${group.devices.length} devices` });
});
_api.post('/api/group/:groupId/blank', async (req, res) => {
    const { groupId } = req.params;
    const group = groups.get(groupId);
    
    if (!group) {
        return res.status(404).json({ error: 'Group not found' });
    }

    const promises = group.devices.map(d => 
        sendCommandToClient(d.id || d.deviceId, { type: 'blank' }).catch(() => {})
    );
    await Promise.all(promises);
    res.json({ success: true, message: `Blank command sent to ${group.devices.length} devices` });
});
_api.post('/api/group/:groupId/add-device', express.json(), (req, res) => {
    const { groupId } = req.params;
    const { deviceId } = req.body;
    
    if (!groups.has(groupId)) {
        return res.status(404).json({ error: 'Group not found' });
    }
    
    if (!clients.has(deviceId)) {
        return res.status(404).json({ error: 'Device not found' });
    }
    
    const group = groups.get(groupId);
    const device = clients.get(deviceId);
    
    // Check if device is already in group
    const deviceExists = group.devices.some(d => (d.id || d.deviceId) === deviceId);
    if (deviceExists) {
        return res.status(400).json({ error: 'Device already in group' });
    }
    
    // Add device to group
    group.devices.push({
        id: device.deviceId,
        deviceId: device.deviceId,
        name: device.deviceName,
        ip: device.ip,
        status: device.status
    });
    
    // Update device's group assignment
    device.groupId = groupId;
    device.groupName = group.name;
    clients.set(deviceId, device);
    saveClients();
    
    groups.set(groupId, group);
    saveGroups();
    //updateDevicesToUI(`POST( '/api/group/:groupId/add-device' ) [ ${getOrigin(req)} ]`);
    
    res.json({ success: true, message: `Device "${device.deviceName}" added to group "${group.name}"` });
});
_api.post('/api/group/:groupId/remove-device', express.json(), (req, res) => {
    const { groupId } = req.params;
    const { deviceId } = req.body;
    
    if (!groups.has(groupId)) {
        return res.status(404).json({ error: 'Group not found' });
    }
    
    const group = groups.get(groupId);
    const initialLength = group.devices.length;
    
    group.devices = group.devices.filter(d => (d.id || d.deviceId) !== deviceId);
    
    if (group.devices.length === initialLength) {
        return res.status(404).json({ error: 'Device not found in group' });
    }
    
    // Clear device's group assignment
    if (clients.has(deviceId)) {
        const device = clients.get(deviceId);
        device.groupId = null;
        device.groupName = null;
        clients.set(deviceId, device);
        saveClients();
    }
    
    groups.set(groupId, group);
    saveGroups();
    //updateDevicesToUI(`POST( '/api/group/:groupId/remove-device' ) [ ${getOrigin(req)} ]`);
    
    res.json({ success: true, message: 'Device removed from group' });
});

_api.post('/api/system/shutdown', (req, res) => {
    res.json({ success: true, message: 'System shutdown initiated' });
    
    // Notify all GUI clients about shutdown
    broadcastToGUI({
        type: 'server-shutdown',
        origin: `POST( '/api/system/shutdown' ) [ ${getOrigin(req)} ]`,
        message: 'Server is shutting down...'
    });
    
    setTimeout(() => {
        const { exec } = require('child_process');
        exec('sudo shutdown now');
    }, 1000);
});
_api.post('/api/system/restart', (req, res) => {
    res.json({ success: true, message: 'Server restart initiated' });
    
    // Notify all GUI clients about restart
    broadcastToGUI({
        type: 'server-restart',
        origin: `POST( '/api/system/restart' ) [ ${getOrigin(req)} ]`,
        message: 'Server is restarting...'
    });
    
    setTimeout(() => {
        process.exit(0); // systemd will restart the service
    }, 1000);
});
_api.post('/api/system/reboot', (req, res) => {
    res.json({ success: true, message: 'System reboot initiated' });
    
    // Notify all GUI clients about reboot
    broadcastToGUI({
        type: 'server-reboot',
        origin: `POST( '/api/system/reboot' ) [ ${getOrigin(req)} ]`,
        message: 'Server is rebooting...'
    });
    
    setTimeout(() => {
        const { exec } = require('child_process');
        exec('sudo reboot');
    }, 1000);
});

/** 
 *  HTML Page Scripts
 */
_api.get('/scripts/:scriptName', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');

    const scriptName = req.params.scriptName;
    // File path for requested page script using request parameter.
    const fsPageScriptPath = path.join(__dirname, 'public', scriptName, `${scriptName}.js`);
    // Check if File exists
    const pageScriptExists = fs.existsSync(fsPageScriptPath);

    // File path for requested general script using request parameter.
    const fsGeneralScriptPath = path.join(__dirname, 'public', '01-scripts', `${scriptName}.js`);
    // Check if File exists
    const generalScriptExists = fs.existsSync(fsGeneralScriptPath);
    
    if (pageScriptExists) {
        res.sendFile(fsPageScriptPath);
    } else if (generalScriptExists) {
        res.sendFile(fsGeneralScriptPath);
    } else {
        res.sendStatus(404);
    }
});

/** 
 *  HTML Page Redirects
 *   -  MUST REMAIN BELOW ALL OTHER _app FUNCTIONS
 */
_api.get('/:pageName', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');

    const pageName = req.params.pageName;
    // File path for requested page using request parameter.
    const fsPagePath = path.join(__dirname, 'public', pageName, `${pageName}.html`);
    // Check if File exists
    const pageExists = fs.existsSync(fsPagePath);

    // File path for fallback page.
    const fsNotFoundPath = path.join(__dirname, 'public', 'not-found', `not-found.html`);
    // Check if File exists
    const notFoundExists = fs.existsSync(fsNotFoundPath);

    if (pageExists) {
        res.sendFile(fsPagePath);
    } else if (notFoundExists) {
        res.sendFile(fsNotFoundPath);
    } else {
        res.sendStatus(404);
    }
});


async function getRokuTvInfo() {
    let data = [];
    await Promise.all(rokuTvs.map(async (tv) => {
        try {
            const res = await fetch(`http://${tv.ipAddress}:8060/query/device-info`, {
                method: 'GET',
                headers: { 
                    'Accept': 'application/xml'
                }
            });
            if (!res.ok) {
                console.log(`Fetched Roku TV`);
            }
		    const xmlText = await res.text();
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(xmlText, 'application/xml');
            const tag = (tagName) => xmlDoc.getElementsByTagName(tagName)[0]?.textContent || '';
            /**
             * Device Type
             */
            let deviceType;
            if (tag('is-stick') === 'true') {
                deviceType = 'Stick';
            } else if (tag('is-tv') === 'true') {
                deviceType = 'TV';
            } else {
                deviceType = 'Unknown';
            }
            /**
             * Uptime
             */
            const totalSeconds = tag('uptime') ?? '0';
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = Math.floor(totalSeconds % 60);
            
            const pad2 = (num) => {
                return num.toString().padStart(2, '0');
            };
            const uptime = `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
            /**
             * MAC
             */
            let macAddress;
            if (tag('network-type') == 'wifi') {
                macAddress = tag('wifi-mac');
            } else if (tag('network-type') == 'ethernet') {
                macAddress = tag('ethernet-mac');
            }
            /**
             * Power Mode
             */
            const powerState = {
                displayValue: tag('power-mode'),
                isOn: false,
            };
            switch (tag('power-mode')) {
                case 'Ready':
                    powerState.isOn = false;
                    break;
                case 'DisplayOff':
                    powerState.isOn = false;
                    break;
                case 'PowerOn':
                    powerState.isOn = true;
                    break;
                default:
                    break;
            }
            /**
             * 
             */
            const deviceInfo = {
                deviceType: deviceType,
                name: tag('friendly-device-name') || tag('user-device-name') || 'Roku TV',
                room: tag('user-device-location'),
                screenSize: tag('screen-size'),
                mfr: tag('vendor-name') || '',
                id: tag('device-id'),
                sn: tag('serial-number'),
                fw: tag('software-version'),
                uptime: uptime,
                currentMode: powerState.displayValue,
                isOn: powerState.isOn,
                network: {
                    name: tag('network-name'),
                    connection: tag('network-type'),
                    mac: macAddress,
                },
                compatibility: {
                    ecp: tag('ecp-setting-mode') === 'enabled',
                }
            };
            data.push(deviceInfo);
        } catch(error) {
            console.log(error);
        }
    }));
    return data;
}
async function getNDISources() {
    return new Promise((resolve, reject) => {
        try {
            exec('LD_LIBRARY_PATH=/home/ndpi-server/ndpi ./ndi_discover 3', (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                    return;
                }
                const sources = JSON.parse(stdout.trim());
                // Set discovered sources 'favorite' to false first.
                sources.forEach(function (src) {
                    src.favorite = false;                    
                });
                let favoritedSources = [];
                let favoritedSourcesUpdated = false;
                try {
                    if (fs.existsSync(FAVORITED_SOURCES_FILE)) {
                        const data = fs.readFileSync(FAVORITED_SOURCES_FILE, 'utf8');
                        favoritedSources = JSON.parse(data);
                        
                        // set all favorited sources 'favorite' to true
                        favoritedSources.forEach(function (src) {
                            src.favorite = true;
                        });
                        
                        if (!Array.isArray(favoritedSources)) {
                            favoritedSources = [];
                        }
                    }
                } catch (fileError) {
                    console.error('Error reading favorited sources:', fileError);
                    favoritedSources = [];
                }
                const mergedSources = [];
                const usedFavoritedIndices = new Set();
                for (const discoveredSource of sources) {
                    /**
                     *  @const {number} exactMatchIndex
                     *  -   Evaluates each @const favoritedSources for matching @param name AND @param url to the @const discoveredSource
                     * 
                     *  If @const exactMatchIndex - is NOT equal to -1
                     *  -   Exact Match Found.
                     *  -   Add the @const discoveredSource to @const mergedSources
                     */
                    const exactMatchIndex = favoritedSources.findIndex(fav => 
                        fav.name === discoveredSource.name && fav.url === discoveredSource.url
                    );
                    if (exactMatchIndex !== -1) {
                        mergedSources.push(favoritedSources[exactMatchIndex]);
                        usedFavoritedIndices.add(exactMatchIndex);
                    } else {
                        /**
                         *  @const {number} partialMatchIndex
                         *  -   Evaluates each @const favoritedSources for matching @param name OR @param url to the @const discoveredSource
                         * 
                         *  If @const partialMatchIndex - is NOT equal to -1
                         *  -   Exact Match Found.
                         *  -   Add the @const discoveredSource to @const mergedSources
                         *  -   Update the @const favoritedSources with the @const discoveredSource
                         *  Else
                         *  -   Add the @const discoveredSource to @const mergedSources
                         */
                        const partialMatchIndex = favoritedSources.findIndex(fav =>
                            fav.name === discoveredSource.name || fav.url === discoveredSource.url
                        );
                        if (partialMatchIndex !== -1) {
                            discoveredSource.favorite = true;
                            mergedSources.push(discoveredSource);
                            favoritedSources[partialMatchIndex] = discoveredSource;
                            usedFavoritedIndices.add(partialMatchIndex);
                            favoritedSourcesUpdated = true;
                        } else {
                            mergedSources.push(discoveredSource);
                        }
                    }
                }
                /**
                 *  Add the remaining @const favoritedSources that werent discovered to @const mergedSources
                 */
                for (let i = 0; i < favoritedSources.length; i++) {
                    if (!usedFavoritedIndices.has(i)) {
                        mergedSources.push(favoritedSources[i]);
                    }
                }
                /**
                 *  If @const favoritedSources were updated, then save to fs
                 */
                if (favoritedSourcesUpdated) {
                    try {
                        fs.writeFileSync(FAVORITED_SOURCES_FILE, JSON.stringify(favoritedSources, null, 2));
                    } catch (saveError) {
                        console.error('Error saving favorited sources:', saveError);
                    }
                }
                /**
                 *  Parse IP Port for sorting.
                 *  @param {string} addr 
                 *  @returns Last Octet of IP Addr and Port Number w/o colon
                 */
                const  ipPortKey = (addr) => {
                    const match = addr.match(/\.([0-9]+):([0-9]+)/);
                    if (!match) return Infinity;
                    const lastOctet = match[1];
                    const port = match[2];
                    return Number(lastOctet + port);
                }
                mergedSources.sort((a,b) => {
                    if (a.favorite !== b.favorite) {
                        return b.favorite - a.favorite;
                    }
                    return ipPortKey(a.url) - ipPortKey(b.url);
                });
                resolve(mergedSources);
            });
        } catch (parseError) {
            console.error('NDI discovery error:', parseError);
            resolve([]); 
        }
    });
}
function hashPIN(pin) {
    return crypto.createHash('sha256').update(pin.toString()).digest('hex');
}
async function getSystemStats() {
    return new Promise((resolve, reject) => {
        exec('top -bn1 | head -5 && free -m && df -h /', (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            try {
                const lines = stdout.split('\n');
                // Parse load average
                const loadLine = lines.find(line => line.includes('load average'));
                const loadMatch = loadLine.match(/load average: ([^,]+), ([^,]+), ([^,]+)/);
                const load = loadMatch ? [parseFloat(loadMatch[1]), parseFloat(loadMatch[2]), parseFloat(loadMatch[3])] : [0, 0, 0];
                // Parse CPU usage
                const cpuLine = lines.find(line => line.includes('%Cpu'));
                const cpuMatch = cpuLine.match(/([0-9.]+) us.*?([0-9.]+) id/);
                const cpuUsage = cpuMatch ? parseFloat(cpuMatch[1]) : 0;
                // Parse memory
                const memLine = lines.find(line => line.includes('Mem:'));
                const memMatch = memLine.match(/Mem:\s+(\d+)\s+(\d+)\s+(\d+)/);
                const memTotal = memMatch ? parseInt(memMatch[1]) : 0;
                const memUsed = memMatch ? parseInt(memMatch[2]) : 0;
                // Parse disk
                const diskLine = lines.find(line => line.includes('/dev/'));
                const diskMatch = diskLine.match(/\s+(\d+)%/);
                const diskUsage = diskMatch ? parseInt(diskMatch[1]) : 0;
                // Temperature - read from thermal zone
                let temp;
                const tempFile = '/sys/class/thermal/thermal_zone0/temp';
                if (fs.existsSync(tempFile)) {
                    temp = parseInt(fs.readFileSync(tempFile, 'utf8')) / 1000;
                } else {
                    temp = 0
                }
                resolve({
                    cpuUsage: Math.round(cpuUsage * 10) / 10,
                    cpuTemp: temp,
                    memoryUsage: Math.round((memUsed / memTotal) * 100),
                    memoryTotal: Math.round(memTotal / 1024 * 10) / 10, // Convert to GB
                    memoryUsed: Math.round(memUsed / 1024 * 10) / 10,
                    diskUsage: diskUsage,
                    loadAverage: load,
                    uptime: os.uptime()
                });
            } catch (parseError) {
                reject(parseError);
            }
        });
    });
}
function loadAccounts() {
    try {
        if (fs.existsSync(ACCOUNTS_FILE)) {
            const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
            accounts = new Map(Object.entries(data));
            console.log(`Found ${accounts.size} user accounts`);
        } else {
            // Create default admin account
            createAdminAccount();
        }
    } catch (error) {
        console.log('Creating admin account');
        createAdminAccount();
    }
}
function createAdminAccount() {
    const adminId = crypto.randomUUID();
    accounts.set(adminId, {
        id: adminId,
        firstName: 'Admin',
        lastName: 'User',
        username: 'admin',
        pinHash: hashPIN('0000'),
        createdAt: new Date().toISOString(),
        isAdmin: true,
        isSystemAccount: true,
        firstTimeLogin: false,

    });
    saveAccounts();
    console.log('Admin account created - Username: admin, PIN: 0000');
}
function saveAccounts() {
    try {
        const data = Object.fromEntries(accounts);
        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Failed to save accounts:', error);
    }
}
function loadRokuTvs() {
    try {
        if (fs.existsSync(ROKU_TVS_FILE)) {
            const data = JSON.parse(fs.readFileSync(ROKU_TVS_FILE, 'utf8'));
            rokuTvs = Array.isArray(data) ? data : [];
            console.log(`Found ${rokuTvs.length} Saved Roku TVs`);
        } else {
            rokuTvs = [];
            saveRokuTvs();
        }
    } catch (error) {
        console.error('Failed to load Roku TVs:', error);
        rokuTvs = [];
    }
}
function saveRokuTvs() {
    try {
        fs.writeFileSync(ROKU_TVS_FILE, JSON.stringify(rokuTvs, null, 2));
    } catch (error) {
        console.error('Failed to save Roku TVs:', error);
    }
}
function loadClients() {
    try {
        if (fs.existsSync(CLIENTS_FILE)) {
            const data = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
            clients = new Map(Object.entries(data));
            console.log(`Found ${clients.size} NDPi Client Devices`);
        }
    } catch (error) {
        console.log('No NDPi Client Devices saved.');
    }
}
function updateDevicesToUI(origin = '') {
    broadcastToGUI({
        type: 'devices-update',
        origin: origin,
        devices: Array.from(clients.values()).map(client => ({
            id: client.deviceId,
            deviceId: client.deviceId,
            name: client.deviceName,
            ip: client.ip,
            port: client.port,
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
            groupName: client.groupName || null
        }))
    });
}
const updateUiDebounce = 5000;
let updateTimer = null;
function saveClients() {
    if (updateTimer) {
        clearTimeout(updateTimer);
        updateTimer = null;
    }
    updateTimer = setTimeout(() => {
        try {
            const data = Object.fromEntries(clients);
            fs.writeFileSync(CLIENTS_FILE, JSON.stringify(data, null, 2));
            updateDevicesToUI('function saveClients()');
        } catch (error) {
            console.error('Failed to save clients:', error);
        }
    }, updateUiDebounce);
}
function loadGroups() {
    try {
        if (fs.existsSync(GROUPS_FILE)) {
            const data = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
            groups = new Map(Object.entries(data));
            console.log(`Found ${groups.size} groups`);
        }
    } catch (error) {
        console.log('No saved groups');
    }
}
function saveGroups() {
    try {
        const data = Object.fromEntries(groups);
        fs.writeFileSync(GROUPS_FILE, JSON.stringify(data, null, 2));
        
        // Broadcast update to all GUI clients
        broadcastToGUI({
            type: 'groups-update',
            origin: 'function saveGroups()',
            groups: Array.from(groups.values())
        });
    } catch (error) {
        console.error('Failed to save groups:', error);
    }
}
function applyServerNetworkSettings(config, isServer = false) {
    const { exec } = require('child_process');
    const fs = require('fs');
    
    console.log('Applying network settings:', config);
    
    // Determine network interface (usually eth0 for wired, wlan0 for WiFi)
    const interface = config.wifiSSID ? 'wlan0' : 'eth0';
    
    // Build dhcpcd.conf content
    let dhcpcdConfig = '';
    
    if (config.mode === 'static' && config.staticIP) {
        dhcpcdConfig = `
interface ${interface}
static ip_address=${config.staticIP}/${config.subnet === '255.255.255.0' ? '24' : '16'}
static routers=${config.gateway || config.staticIP.replace(/\.\d+$/, '.1')}
static domain_name_servers=${config.dns || '8.8.8.8'}
`;
    }
    // Write dhcpcd configuration
    if (dhcpcdConfig) {
        fs.writeFileSync('/tmp/ndpi-network-config', dhcpcdConfig);
        exec('sudo tee -a /etc/dhcpcd.conf < /tmp/ndpi-network-config', (error) => {
            if (error) console.error('Error updating dhcpcd.conf:', error);
        });
    }
    // Configure WiFi if credentials provided
    if (config.wifiSSID && config.wifiPassword) {
        const wpaConfig = `
network={
    ssid="${config.wifiSSID}"
    psk="${config.wifiPassword}"
}
`;
        fs.writeFileSync('/tmp/ndpi-wifi-config', wpaConfig);
        exec('sudo tee -a /etc/wpa_supplicant/wpa_supplicant.conf < /tmp/ndpi-wifi-config', (error) => {
            if (error) console.error('Error updating wpa_supplicant.conf:', error);
        });
    }
    // Restart networking
    exec(`sudo systemctl restart dhcpcd`, (error) => {
        if (error) {
            console.error('Error restarting dhcpcd:', error);
        } else {
            console.log('Network settings applied successfully');
            if (config.wifiSSID) {
                exec('sudo wpa_cli -i wlan0 reconfigure');
            }
        }
    });
}
function getServerIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            const isIPv4 = iface.family === 'IPv4' || iface.family === 4;
            if (isIPv4 && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}
function sendCommandToClient(deviceId, command, userInfo = {}) {
    return new Promise((resolve, reject) => {
        const client = clients.get(deviceId);
        
        if (!client || !client.ip) {
            return reject(new Error('Client not found or no IP address'));
        }

        localIp = getServerIP();

        // Add server address and user info to command
        const enrichedCommand = {
            ...command,
            serverAddress: `${localIp}:${PORT}`,
            serverIp: String(localIp),
            serverPort: String(PORT),
            user: userInfo.user || 'system',
            timestamp: new Date().toISOString()
        };

        // First try to use existing WebSocket connection if available
        const existingDevice = clientDevices.get(deviceId);
        if (existingDevice && existingDevice.ws && existingDevice.ws.readyState === WebSocket.OPEN) {
            try {
                existingDevice.ws.send(JSON.stringify(enrichedCommand));
                return resolve({ success: true, message: 'Command sent via existing connection' });
            } catch (e) {
                console.log('Existing WebSocket failed, falling back to new connection');
            }
        }

        // Fall back to creating new WebSocket connection
        const ws = new WebSocket(`ws://${client.ip}:${client.port || 3001}`);

        ws.on('open', () => {
            ws.send(JSON.stringify(enrichedCommand));
        });

        ws.on('message', (data) => {
            const response = JSON.parse(data);
            ws.close();
            if (response.success) {
                resolve(response);
            } else {
                reject(new Error(response.error || 'Command failed'));
            }
        });

        ws.on('error', (error) => {
            reject(error);
        });

        // Timeout after 5 seconds
        setTimeout(() => {
            ws.close();
            reject(new Error('Command timeout'));
        }, 5000);
    });
}

/**
 *  mDNS Client Discovery Service
 *  Uses 'bonjour'
 */
console.log('Starting client discovery...');
const clientDeviceMDNS = bonjour.find({ type: 'ndpi-monitor-client' });
clientDeviceMDNS.on('up', (service) => {
    const deviceId = service.txt?.deviceid || service.txt?.deviceId;
    const deviceName = service.txt?.devicename || service.txt?.deviceName || 'NDPi Client';
    const ip = service.txt?.ip || service.addresses?.[0] || service.host;
    const commandPort = service.txt?.commandport || service.txt?.commandPort || '3001';

    if (!deviceId) {
        console.log(`[] Discovered client without device ID`);
        console.log(`Data: ${service.txt}`);
        return;
    }

    // Upsert discovered clients
    discoveredClients.set(deviceId, {
        deviceId,
        deviceName,
        ip,
        commandPort,
        lastSeen: new Date().toISOString()
    });
    
    broadcastToGUI({
        type: 'discovered-devices-update',
        devices: Array.from(discoveredClients.values())
    });

    if (clients.has(deviceId)) {
        const client = clients.get(deviceId);
        client.ip = ip;
        client.port = commandPort;
        client.status = 'online';
        client.lastSeen = new Date().toISOString();
        clients.set(deviceId, client);
        saveClients();
        console.log(`[] Update from client device:`);
    } else {
        console.log(`[] Discovered new client device:`);
    }
        console.log(`ID:   ${deviceId}`);
        console.log(`NAME: ${deviceName}`);
        console.log(`IP:   ${ip}`);
        console.log(`PORT: ${commandPort}`);
});
clientDeviceMDNS.on('down', (service) => {
    const deviceId = service.txt?.deviceid || service.txt?.deviceId;
    
    if (deviceId && clients.has(deviceId)) {
        const client = clients.get(deviceId);
        client.status = 'offline';
        client.lastSeen = new Date().toISOString();
        clients.set(deviceId, client);
        saveClients();
        console.log(`Client offline: ${client.deviceName} (${deviceId})`);
    }
});

// Start server
loadAccounts();
loadClients();
loadGroups();
loadRokuTvs();

process.on('uncaughtException', (err) => {
    console.log(' ');
    console.log(' ');
    console.log(`UNHANDLED REJECTION ${err}`);
    console.log(' ');
    console.log(' ');
});

process.on('unhandledRejection', (err) => {
    console.log(' ');
    console.log(' ');
    console.log(`UNHANDLED REJECTION ${err}`);
    console.log(' ');
    console.log(' ');
});

process.on('beforeExit', async (code) => {
    console.log(`Waiting to exit NDPi Server [CODE: ${code}]`);
    await new Promise((resolve) => { setTimeout(() => {resolve}, 1500) });
});

process.on('exit', (code) => {
    console.log(`NDPi Server exit with code: ${code}`);
    console.log('⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻ ')
    console.log(' GOOD BYE 👋');
    console.log('⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻ ');
    console.log('⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻ ');
});


process.on('SIGINT',  () => { killProcess('SIGINT'); });
process.on('SIGTERM', () => { killProcess('SIGTERM'); });


function killProcess(reason) {
    // Notify all GUI clients about shutdown
    broadcastToGUI({
        type: 'server-shutdown',
        origin: `${reason}`,
        message: 'Server is shutting down...'
    });
    process.exit()
}