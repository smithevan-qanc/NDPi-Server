const { EventEmitter } = require('events');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { setInterval, clearInterval } = require('timers');
const func = require('./functions.js');
const { exec, spawn } = require('node:child_process');
const { setTimeout } = require('node:timers');

class FileSystemMonitor extends EventEmitter {
#pgmVersion;
    #pgmVersionDate;
    #ipPoll;
    #updatePoll;
    #updatePollInterval;
    constructor(version = '1.0.0', versionDate = '1970-01-01') {
        super();

        this.watcherEnable = true;
        this.watcher = null;
        this.setMaxListeners(100)

        this.defaultDeviceName = 'NDPi';

        this.#ipPoll = null;
        this.ipPollInterval = 1000;
        this.ipPollEnable = true;

        this.#updatePoll = null;
        this.#updatePollInterval = (10 * 60) * 1000;
        this.updatePollEnable = true;

        this.dataDir = process.env.DATA_NDPI_PATH;
        this.fileMap = null;

        this.debounceMap = new Map();
        this.queue = [];

        this.#pgmVersion = version;
        this.#pgmVersionDate = new Date(versionDate).toISOString().split('T')[0];

        this.serverCommunicationWebSocket = null;

        this.drmMonitor = null;
        this.debounceTimerDrmEvents = null;

        /**
         *  Hub Data Collections
         *  ---------------------
         *  Unlike the per-key settings above (mirrored from the NDPi Client's
         *  FileSystemMonitor), the Hub also needs to persist *collections* of
         *  data: user accounts, known/managed NDPi Client devices, device
         *  groups, Roku TVs, and favorited NDI sources. These are each stored
         *  as a single JSON file inside `dataDir` (matching the pattern used
         *  by the legacy tmp/server.js prototype).
         */
        this.accountsFile          = null;
        this.clientsFile           = null;
        this.groupsFile            = null;
        this.rokuTvsFile           = null;
        this.favoritedSourcesFile  = null;

        this.accounts           = new Map();   // accountId    -> account record
        this.clients             = new Map();   // deviceId     -> saved/managed NDPi Client device
        this.discoveredClients   = new Map();   // deviceId     -> mDNS-discovered device (in-memory only, not persisted)
        this.groups              = new Map();   // groupId      -> device group
        this.rokuTvs             = [];          // array of Roku TV records
        this.favoritedSources    = [];          // array of favorited NDI source records

        process.nextTick(() => { this.init(); });
    }

    async init() {
        console.info(`[ ${path.basename(__filename).split('.')[0]} ][ -INITIATE ] NDPi Data Management Module - v${this.#pgmVersion} - ${this.#pgmVersionDate}`);

        // Create directory if it doesn't exist.
        if (!fs.existsSync(this.dataDir))
        { fs.mkdirSync(this.dataDir, { recursive: true }) }

        // Set the deviceId from either serial-number or machine-id
        let deviceId = '';

        const deviceIdPaths = [
            path.join('/sys','firmware','devicetree','base','serial-number'),
            path.join('/etc','machine-id'),
        ];

        if (fs.existsSync(deviceIdPaths[0]) || fs.existsSync(deviceIdPaths[1]))
        {
            try
            {
                deviceId = fs.readFileSync(deviceIdPaths[0], 'utf8').replace(/\0/g, '').trim().toUpperCase();
                console.info(`[ ${path.basename(__filename).split('.')[0]} ][ DEVICE ID ] ${deviceId}`);
            }
            catch 
            {
                deviceId = fs.readFileSync(deviceIdPaths[1], 'utf8').replace(/\0/g, '').trim().toUpperCase();
                console.info(`[ ${path.basename(__filename).split('.')[0]} ][ FALLBACK DEVICE ID ] ${deviceId}`);
            }
        }
        else // MacOS Compatability
        {
            await new Promise((resolve) => {
                exec(`ioreg -l | grep IOPlatformSerialNumber | awk '{print $4}' | tr -d '"'`, (error, stdout) => {
                    if (!error)
                    { deviceId = stdout.trim().toUpperCase(); }
                    resolve();
                });
            })
        }

        // Map file names and values with to standard defaults.
        this.fileMap = new Map();
        const files = [
            { 
                key: "device_name",
                value: `${this.defaultDeviceName}`,
                group: `Device`,
                allowEditInternal: true,
                allowEditExternal: true,
            },
            {
                key: "device_type",
                value: `NDPi Monitor Hub`,
                group: `Device`,
                allowEditInternal: false,
                allowEditExternal: false,
            },
            {
                key: "device_id",
                value: `${deviceId}`,
                group: `Device`,
                allowEditInternal: false,
                allowEditExternal: false,
            },
            {
                key: "device_ip",
                value: ``,
                group: `Device`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "local_port_number_api",
                value: `${process.env.PORT_API || 3080}`,
                group: `Backend`,
                allowEditInternal: true,
                allowEditExternal: true,
            },
            {
                key: "local_port_number_bonjour",
                value: `${process.env.PORT_MDNS || 3053}`,
                group: `Backend`,
                allowEditInternal: true,
                allowEditExternal: true,
            },
            {
                key: "ndpi_version_update_available",
                value: `false`,
                group: `Backend`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "ndpi_version_update_version",
                value: ``,
                group: `Backend`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "ndpi_version",
                value: this.#pgmVersion,
                group: `Backend`,
                allowEditInternal: false,
                allowEditExternal: false,
            },
            {
                key: "ndpi_version_date",
                value: this.#pgmVersionDate,
                group: `Backend`,
                allowEditInternal: false,
                allowEditExternal: false,
            },
            {
                key: "output_display_resolution_preference",
                value: `1920x1080`,
                group: `Display_Resolution`,
                options: [],
                allowEditInternal: true,
                allowEditExternal: true,
            },
            {
                key: "output_display_resolution_current",
                value: ``,
                group: `Display_Resolution`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "output_display_framerate_current",
                value: ``,
                group: `Display_Resolution`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "output_display_resolution_preferred",
                value: ``,
                group: `Display_Resolution`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "output_display_framerate_preferred",
                value: ``,
                group: `Display_Resolution`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "output_display_port",
                value: ``,
                group: `Display_Resolution`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "output_display_manufacturer",
                value: ``,
                group: `Display_Resolution`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "output_display_model",
                value: ``,
                group: `Display_Resolution`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
        ];
        // Files that will NOT initialize with the previously stored value.
        const retainDefaultValue = [
            'ndpi_version',
            'ndpi_version_date',
            'ndpi_version_update_available',
            'ndpi_version_update_version',
            'device_id',
            'device_type',
            'device_ip',
            'local_port_number_bonjour',
            'local_port_number_api',
        ];

        for (const file of files)
        {
            let setting = file;
            let getValueFromFile = true;

            const filePath = path.join(this.dataDir, setting.key);

            if (retainDefaultValue.includes(setting.key))
            { getValueFromFile = false }

            try
            {
                if (fs.existsSync(filePath) && getValueFromFile)
                {
                    const currentValue = fs.readFileSync(filePath, 'utf8').replace(/\0/g, '').trim();
                    setting.value = currentValue;
                    this.fileMap.set(setting.key, setting);
                }
                else
                {
                    fs.writeFileSync(filePath, setting.value, 'utf8');
                    this.fileMap.set(setting.key, setting);
                }
            }
            catch (err)
            { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] Saving File: Name:${setting.key}, Value: ${setting.value}`, err) }
        };

        // Hub Data Collections (accounts / devices / groups / roku / favorites)
        this.accountsFile         = path.join(this.dataDir, 'accounts.json');
        this.clientsFile          = path.join(this.dataDir, 'clients.json');
        this.groupsFile           = path.join(this.dataDir, 'groups.json');
        this.rokuTvsFile          = path.join(this.dataDir, 'roku-tvs.json');
        this.favoritedSourcesFile = path.join(this.dataDir, 'favorited-sources.json');

        this.loadAccounts();
        this.loadClients();
        this.loadGroups();
        this.loadRokuTvs();
        this.loadFavoritedSources();

        this.start();
    }

    async start() {
        this.startWatcher();
        this.startDrmMonitor();
        this.pollUpdate();
        this.emit('ready');
        await func.waitForNetwork();
        this.pollIp();
    }

    startWatcher() {
        this.watcher = fs.watch(this.dataDir);
        this.watcher.on('change', (eventType, filename) => {
            if (this.fileMap.has(filename))
            { this._fsEvent(filename); }
        });
    }
    
    _fsEvent(name, debounceMs = 500) {
        const last = this.debounceMap.get(name) || 0;
        const now = Date.now();

        if (now - last < debounceMs)
        { return; }

        this.debounceMap.set(name, now);
        this.queue.push({ name });

        setTimeout(() => { this.__flushQueue(); }, debounceMs);
    }

    async __flushQueue() {
        let updated = false;

        while (this.queue.length > 0)
        {
            const { name } = this.queue.shift();

            let currentValue = this.fileMap.get(name);
            const fsValue = fs.readFileSync(path.join(this.dataDir, name), 'utf8').replace(/\0/g, '').trim();
            
            if (currentValue.value !== fsValue)
            {
                currentValue.value = fsValue;
                this.fileMap.set(name, currentValue);

                if (name === 'media_overlay_image')
                { console.info(`[ ${path.basename(__filename).split('.')[0]} ][ UPDATE ] '${name}'`); }
                else
                { console.info(`[ ${path.basename(__filename).split('.')[0]} ][ UPDATE ] '${name}' ==> '${fsValue}'`); }

                this.emit(name, fsValue);
                updated = true;
            }
        }

        if (updated)
        { this.emit('update', JSON.stringify(Array.from(this.fileMap))); }

        return;
    }

    get(fileName) {
        if (!fileName || !this.fileMap.has(fileName))
        { return null; }
        return this.fileMap.get(fileName).value;
    }

    put(fileName, data = '') {
        if (!fileName || !this.fileMap.has(fileName))
        { return; }
        
        try
        { fs.writeFileSync(path.join(this.dataDir, fileName), data.trim(), 'utf8'); }
        catch (error)
        { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] Saving to FileSystem`); }
    }

    startDrmMonitor() {
        try
        { exec('killall -s SIGKILL udevadm'); }
        catch {}
        finally
        { this.drmMonitor = null;}

        console.info(`[ ${path.basename(__filename).split('.')[0]} ] Starting DRM Event Monitor`);

        this.drmMonitor = spawn('udevadm', ['monitor', '--subsystem-match=drm', '--kernel']);

        this.drmMonitor.stdout.on('data', (data) => {
            this.drmEvent();
        });

        this.drmMonitor.stderr.on('data', (data) => {

        });
        this.drmMonitor.on('error', (error) => {
            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] 'udevadm' DRM monitor disabled`, error.toString());
        });

        this.drmMonitor.once('close', () => {
            try { clearTimeout(this.debounceTimerDrmEvents) }
            catch {}
            // finally { this.updateOutputDisplayFiles(); }
        });
    }

    drmEvent(debounceMs = 500) {
        if (this.debounceTimerDrmEvents)
        {
            clearTimeout(this.debounceTimerDrmEvents);
            this.debounceTimerDrmEvents = null;
        }
        this.debounceTimerDrmEvents = setTimeout(() => {
            this.updateOutputDisplayFiles();
            this.debounceTimerDrmEvents = null;
        }, debounceMs);
    }

    async close() {
        this.watcherEnable = false;
        this.ipPollEnable = false;
        this.updatePollEnable = false;

        console.info( `[ CLOSING ][ ${path.basename(__filename).split('.')[0]} ]`);

        try { clearTimeout(this.#ipPoll); } catch {}
        finally { this.#ipPoll = null; }

        try { clearTimeout(this.#updatePoll); } catch {}
        finally { this.#updatePoll = null; }

        if (this.watcher)
        {  this.watcher.close(); }

        if (this.debounceTimerDrmEvents)
        {
            clearTimeout(this.debounceTimerDrmEvents);
            this.debounceTimerDrmEvents = null;
        }

        return new Promise((resolve) => {
            exec('killall -s SIGKILL udevadm', async () => {
                console.info( `[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ]`);
                resolve();
            });
        })
    }



    /**
     *  Helper Functions
     */

    async pollIp() {
        try { await this.updateLocalIp(); }
        catch {}
        finally
        {
            if (this.ipPollEnable)
            {
                this.#ipPoll = null;
                this.#ipPoll = setTimeout(() => {
                    this.pollIp();
                }, this.ipPollInterval);
            }
        }
    }

    async pollUpdate() {
        try { await func.checkForUpdate(); }
        catch {}
        finally
        {
            if (this.updatePollEnable)
            {
                this.#updatePoll = null;
                this.#updatePoll = setTimeout(() => {
                    this.pollUpdate();
                }, this.#updatePollInterval);
            }
        }
    }

    async updateLocalIp() {
        let fileName = 'device_ip';
        let valueUpdate = null;

        await new Promise((resolve) => {
            exec('ip -j address', (error, stdout, stderr) => {
                if (error)
                {
                    console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ] Error Reading IP Address.`, stderr.toString());
                    resolve();
                }
                else
                {
                    try
                    {
                        let output = JSON.parse(String(stdout));
                        if (Array.isArray(output))
                        {
                            output = output
                                .filter(link => link.link_type == 'ether')
                                .filter(link => link.operstate == 'UP');

                            if (output.length >= 1)
                            {
                                const output_obj = output[0];
                                if (Array.isArray(output_obj.addr_info))
                                {
                                    let output_addr_info = output_obj.addr_info.filter(addr => addr.family == 'inet');
                                    if (output_addr_info.length === 1)
                                    { valueUpdate = output_addr_info[0].local; }
                                }
                            }
                        }
                    }
                    catch (error)
                    { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ] Error Reading IP Address.`, error); }
                    finally
                    { resolve(); }
                }
            });
        });

        if (valueUpdate)
        {
            const storedValue = this.fileMap.get(fileName).value;
            if (valueUpdate !== storedValue)
            {
                this.put(fileName, valueUpdate);
                this.ipPollInterval = 10000;
            }
        }
        else
        {
            this.put(fileName, '');
            this.ipPollInterval = 1000;
        }
        return;
    }

    async updateOutputDisplayFiles() {
        let HDMI_1;
        let HDMI_2;

        await new Promise((resolve) => {
            exec('cat /sys/class/drm/card*HDMI*/status', (error, stdout, stderr) => {
                if (error)
                { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ updateOutputDisplayFiles() ][ ERROR ]`, stderr.toString().trim()); }
                else
                {
                    const output = func.stdoutToArray(stdout);
                    HDMI_1 = output[0] || 'disconnected';
                    HDMI_2 = output[1] || 'disconnected';
                    resolve();
                }
            });
        });

        if (HDMI_1 === 'disconnected' && HDMI_2 === 'disconnected')
        {
            this.put('output_display_port', '');
            this.put('output_display_resolution_preferred', '');
            this.put('output_display_framerate_preferred', '');
            this.put('output_display_manufacturer', '');
            this.put('output_display_model', '');
            this.emit('drm');
        }
        else
        {
            const commandPath = path.join(__dirname, '..', 'sh', 'current-resolution');
            exec(commandPath, (error, stdout, stderr) => {
                if (error)
                { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ updateOutputDisplayFiles() ][ ERROR ] ${stderr.toString().trim()}`); }
                else
                {
                    let resolutionOptions = [];
                    func.stdoutToArray(stdout).forEach((line) => {
                        const output        = line.toString().trim();
                        const lineSplit_1   = output.split(' : ');
                        const splitKey      = String(lineSplit_1[0] || '').trim();
                        const splitValue    = String(lineSplit_1[1] || '').trim();
                        
                        let lineSplit_2 = null;
                        let splitOptKey = null;
                        let splitOptValue = null;

                        if (splitValue.includes(' :: '))
                        {
                            lineSplit_2   = splitValue.split(' :: ');
                            splitOptKey   = String(lineSplit_2[0] || '').trim();
                            splitOptValue = String(lineSplit_2[1] || '').trim();
                        }

                        switch(splitKey)
                        {
                            case 'current_output':
                                this.put('output_display_port', splitValue);
                                return;
                                break;
                            case 'current_resolution':
                                this.put('output_display_resolution_current', splitValue);
                                return;
                                break;
                            case 'current_framerate':
                                this.put('output_display_framerate_current', splitValue);
                                return;
                                break;
                            case 'preferred_resolution':
                                this.put('output_display_resolution_preferred', splitValue);
                                return;
                                break;
                            case 'preferred_framerate':
                                this.put('output_display_framerate_preferred', splitValue);
                                return;
                                break;
                            case 'manufacturer_hdmi0':
                                this.put('output_display_manufacturer', splitValue);
                                return;
                                break;
                            case 'manufacturer_hdmi1':
                                this.put('output_display_manufacturer', splitValue);
                                return;
                                break;
                            case 'model_hdmi0':
                                this.put('output_display_model', splitValue);
                                return;
                                break;
                            case 'model_hdmi1':
                                this.put('output_display_model', splitValue);
                                return;
                                break;
                            case 'list_resolutions':
                                if (splitOptKey && splitOptValue)
                                { resolutionOptions.push([splitOptKey, splitOptValue]); }
                                return;
                                break;
                        }
                    });
                    const fileMapCurrRes = this.fileMap.get('output_display_resolution_preference');
                    fileMapCurrRes.options = resolutionOptions;
                    this.fileMap.set('output_display_resolution_preference', fileMapCurrRes);
                    this.emit('drm');
                }
            });
        }
        return;
    }

    /* =====================================================================
     *  ACCOUNTS
     * ===================================================================== */

    hashPin(pin) {
        return crypto.createHash('sha256').update(String(pin)).digest('hex');
    }

    loadAccounts() {
        try
        {
            if (fs.existsSync(this.accountsFile))
            { this.accounts = new Map(Object.entries(JSON.parse(fs.readFileSync(this.accountsFile, 'utf8')))); }
        }
        catch (error)
        {
            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] Loading accounts.json`, error);
            this.accounts = new Map();
        }

        if (this.accounts.size === 0)
        { this.createDefaultAdminAccount(); }
    }

    createDefaultAdminAccount() {
        const id = crypto.randomUUID();
        this.accounts.set(id, {
            id,
            firstName: 'Admin',
            lastName: 'User',
            username: 'admin',
            pinHash: this.hashPin('0000'),
            isAdmin: true,
            firstTimeLogin: true,
            createdAt: new Date().toISOString(),
        });
        this.saveAccounts();
        console.info(`[ ${path.basename(__filename).split('.')[0]} ] Default admin account created — Username: admin, PIN: 0000`);
    }

    saveAccounts() {
        try
        { fs.writeFileSync(this.accountsFile, JSON.stringify(Object.fromEntries(this.accounts), null, 2)); }
        catch (error)
        { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] Saving accounts.json`, error); }
    }

    getAccounts() { return Array.from(this.accounts.values()); }
    getAccount(id) { return this.accounts.get(id) || null; }

    findAccountByPinHash(pinHash) {
        return Array.from(this.accounts.values()).find((acc) => acc.pinHash === pinHash) || null;
    }

    findAccountByUsername(username) {
        return Array.from(this.accounts.values()).find((acc) => acc.username.toLowerCase() === String(username || '').toLowerCase()) || null;
    }

    createAccount({ firstName, lastName, username, pin, isAdmin = false } = {}) {
        const id = crypto.randomUUID();
        const account = {
            id,
            firstName,
            lastName,
            username,
            pinHash: this.hashPin(pin),
            isAdmin: !!isAdmin,
            firstTimeLogin: true,
            createdAt: new Date().toISOString(),
        };
        this.accounts.set(id, account);
        this.saveAccounts();
        return account;
    }

    updateAccount(id, updates = {}) {
        const account = this.accounts.get(id);
        if (!account) return null;

        for (const key of ['firstName', 'lastName', 'username'])
        { if (key in updates) { account[key] = updates[key]; } }

        if ('isAdmin' in updates)
        { account.isAdmin = !!updates.isAdmin; }

        if (updates.pin)
        {
            account.pinHash = this.hashPin(updates.pin);
            account.firstTimeLogin = false;
        }

        if (updates.clearFirstTime)
        { account.firstTimeLogin = false; }

        this.accounts.set(id, account);
        this.saveAccounts();
        return account;
    }

    deleteAccount(id) {
        const existed = this.accounts.delete(id);
        if (existed) { this.saveAccounts(); }
        return existed;
    }

    /* =====================================================================
     *  NDPi CLIENT DEVICES ("clients")
     * ===================================================================== */

    loadClients() {
        try
        {
            if (fs.existsSync(this.clientsFile))
            { this.clients = new Map(Object.entries(JSON.parse(fs.readFileSync(this.clientsFile, 'utf8')))); }
        }
        catch (error)
        {
            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] Loading clients.json`, error);
            this.clients = new Map();
        }
    }

    saveClients() {
        try
        { fs.writeFileSync(this.clientsFile, JSON.stringify(Object.fromEntries(this.clients), null, 2)); }
        catch (error)
        { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] Saving clients.json`, error); }
        this.emit('clients-update');
    }

    getClients() { return Array.from(this.clients.values()); }
    getClient(deviceId) { return this.clients.get(deviceId) || null; }

    upsertClient(deviceId, data = {}) {
        const existing = this.clients.get(deviceId) || {};
        const merged = { ...existing, ...data, deviceId };
        this.clients.set(deviceId, merged);
        this.saveClients();
        return merged;
    }

    deleteClient(deviceId) {
        const existed = this.clients.delete(deviceId);
        if (existed) { this.saveClients(); }
        return existed;
    }

    deleteAllClients() {
        const count = this.clients.size;
        this.clients.clear();
        this.saveClients();
        return count;
    }

    /* ---- mDNS Discovered (not-yet-added) devices — in-memory only ---- */

    upsertDiscoveredClient(deviceId, data = {}) {
        this.discoveredClients.set(deviceId, { ...(this.discoveredClients.get(deviceId) || {}), ...data, deviceId });
        this.emit('discovered-clients-update');
    }

    removeDiscoveredClient(deviceId) {
        if (this.discoveredClients.delete(deviceId))
        { this.emit('discovered-clients-update'); }
    }

    getDiscoveredClients() {
        return Array.from(this.discoveredClients.values()).filter((d) => !this.clients.has(d.deviceId));
    }

    /* =====================================================================
     *  GROUPS
     * ===================================================================== */

    loadGroups() {
        try
        {
            if (fs.existsSync(this.groupsFile))
            { this.groups = new Map(Object.entries(JSON.parse(fs.readFileSync(this.groupsFile, 'utf8')))); }
        }
        catch (error)
        {
            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] Loading groups.json`, error);
            this.groups = new Map();
        }
    }

    saveGroups() {
        try
        { fs.writeFileSync(this.groupsFile, JSON.stringify(Object.fromEntries(this.groups), null, 2)); }
        catch (error)
        { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] Saving groups.json`, error); }
        this.emit('groups-update');
    }

    getGroups() { return Array.from(this.groups.values()); }
    getGroup(groupId) { return this.groups.get(groupId) || null; }

    createGroup({ name, devices = [] } = {}) {
        const id = `group-${Date.now()}`;
        const group = { id, name, devices, currentSource: null, createdAt: new Date().toISOString() };
        this.groups.set(id, group);
        this.saveGroups();
        return group;
    }

    updateGroup(groupId, updates = {}) {
        const group = this.groups.get(groupId);
        if (!group) return null;

        for (const key of ['name', 'currentSource', 'devices'])
        { if (key in updates) { group[key] = updates[key]; } }

        this.groups.set(groupId, group);
        this.saveGroups();
        return group;
    }

    deleteGroup(groupId) {
        const existed = this.groups.delete(groupId);
        if (existed)
        {
            // Clear the group assignment from any devices that referenced it.
            this.clients.forEach((client, deviceId) => {
                if (client.groupId === groupId)
                {
                    client.groupId = null;
                    client.groupName = null;
                    this.clients.set(deviceId, client);
                }
            });
            this.saveClients();
            this.saveGroups();
        }
        return existed;
    }

    addDeviceToGroup(groupId, deviceId) {
        const group = this.groups.get(groupId);
        const client = this.clients.get(deviceId);
        if (!group || !client) return null;

        const alreadyInGroup = group.devices.some((d) => (d.id || d.deviceId) === deviceId);
        if (!alreadyInGroup)
        {
            group.devices.push({
                id: client.deviceId,
                deviceId: client.deviceId,
                name: client.deviceName,
                ip: client.ip,
                status: client.status,
            });
        }

        client.groupId = groupId;
        client.groupName = group.name;

        this.clients.set(deviceId, client);
        this.groups.set(groupId, group);

        this.saveClients();
        this.saveGroups();
        return group;
    }

    removeDeviceFromGroup(groupId, deviceId) {
        const group = this.groups.get(groupId);
        if (!group) return null;

        const before = group.devices.length;
        group.devices = group.devices.filter((d) => (d.id || d.deviceId) !== deviceId);

        if (group.devices.length === before)
        { return group; }

        const client = this.clients.get(deviceId);
        if (client)
        {
            client.groupId = null;
            client.groupName = null;
            this.clients.set(deviceId, client);
            this.saveClients();
        }

        this.groups.set(groupId, group);
        this.saveGroups();
        return group;
    }

    /* =====================================================================
     *  ROKU TVs
     * ===================================================================== */

    loadRokuTvs() {
        try
        { this.rokuTvs = fs.existsSync(this.rokuTvsFile) ? JSON.parse(fs.readFileSync(this.rokuTvsFile, 'utf8')) : []; }
        catch (error)
        {
            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] Loading roku-tvs.json`, error);
            this.rokuTvs = [];
        }
        if (!Array.isArray(this.rokuTvs))
        { this.rokuTvs = []; }
    }

    saveRokuTvs() {
        try
        { fs.writeFileSync(this.rokuTvsFile, JSON.stringify(this.rokuTvs, null, 2)); }
        catch (error)
        { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] Saving roku-tvs.json`, error); }
        this.emit('roku-tvs-update');
    }

    getRokuTvs() { return this.rokuTvs; }

    addRokuTv(data = {}) {
        const tv = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...data };
        this.rokuTvs.push(tv);
        this.saveRokuTvs();
        return tv;
    }

    deleteRokuTv(id) {
        const index = this.rokuTvs.findIndex((tv) => tv.id === id);
        if (index === -1) return false;
        this.rokuTvs.splice(index, 1);
        this.saveRokuTvs();
        return true;
    }

    /* =====================================================================
     *  FAVORITED NDI SOURCES
     * ===================================================================== */

    loadFavoritedSources() {
        try
        { this.favoritedSources = fs.existsSync(this.favoritedSourcesFile) ? JSON.parse(fs.readFileSync(this.favoritedSourcesFile, 'utf8')) : []; }
        catch (error)
        {
            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] Loading favorited-sources.json`, error);
            this.favoritedSources = [];
        }
        if (!Array.isArray(this.favoritedSources))
        { this.favoritedSources = []; }
    }

    getFavoritedSources() { return this.favoritedSources; }

    setFavoritedSources(list = []) {
        this.favoritedSources = Array.isArray(list) ? list : [];
        try
        { fs.writeFileSync(this.favoritedSourcesFile, JSON.stringify(this.favoritedSources, null, 2)); }
        catch (error)
        { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] Saving favorited-sources.json`, error); }
        return this.favoritedSources;
    }
}

module.exports = FileSystemMonitor;