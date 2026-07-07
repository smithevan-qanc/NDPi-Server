const { EventEmitter } = require('events');
const os = require('os');
const fs = require('fs');
const path = require('path');
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
                value: `NDPi Monitor Server`,
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
                key: "device_volume",
                value: `255`,
                options: [
                    [ '255', '255' ],
                    [ '254', '254' ],
                    [ '253', '253' ],
                    [ '252', '252' ],
                    [ '251', '251' ],
                    [ '250', '250' ],
                    [ '249', '249' ],
                    [ '248', '248' ],
                    [ '247', '247' ],
                    [ '246', '246' ],
                    [ '245', '245' ],
                    [ '244', '244' ],
                    [ '243', '243' ],
                    [ '242', '242' ],
                    [ '241', '241' ],
                    [ '240', '240' ],
                    [ '239', '239' ],
                    [ '238', '238' ],
                    [ '237', '237' ],
                    [ '236', '236' ],
                    [ '235', '235' ],
                    [ '234', '234' ],
                    [ '233', '233' ],
                    [ '232', '232' ],
                    [ '231', '231' ],
                    [ '230', '230' ],
                    [ '229', '229' ],
                    [ '228', '228' ],
                    [ '227', '227' ],
                    [ '226', '226' ],
                    [ '225', '225' ],
                    [ '224', '224' ],
                    [ '223', '223' ],
                    [ '222', '222' ],
                    [ '221', '221' ],
                    [ '220', '220' ],
                    [ '219', '219' ],
                    [ '218', '218' ],
                    [ '217', '217' ],
                    [ '216', '216' ],
                    [ '215', '215' ],
                    [ '214', '214' ],
                    [ '213', '213' ],
                    [ '212', '212' ],
                    [ '211', '211' ],
                    [ '210', '210' ],
                    [ '209', '209' ],
                    [ '208', '208' ],
                    [ '207', '207' ],
                    [ '206', '206' ],
                    [ '205', '205' ],
                    [ '204', '204' ],
                    [ '203', '203' ],
                    [ '202', '202' ],
                    [ '201', '201' ],
                    [ '200', '200' ],
                    [ '199', '199' ],
                    [ '198', '198' ],
                    [ '197', '197' ],
                    [ '196', '196' ],
                    [ '195', '195' ],
                    [ '194', '194' ],
                    [ '193', '193' ],
                    [ '192', '192' ],
                    [ '191', '191' ],
                    [ '190', '190' ],
                    [ '189', '189' ],
                    [ '188', '188' ],
                    [ '187', '187' ],
                    [ '186', '186' ],
                    [ '185', '185' ],
                    [ '184', '184' ],
                    [ '183', '183' ],
                    [ '182', '182' ],
                    [ '181', '181' ],
                    [ '180', '180' ],
                    [ '179', '179' ],
                    [ '178', '178' ],
                    [ '177', '177' ],
                    [ '176', '176' ],
                    [ '175', '175' ],
                    [ '174', '174' ],
                    [ '173', '173' ],
                    [ '172', '172' ],
                    [ '171', '171' ],
                    [ '170', '170' ],
                    [ '169', '169' ],
                    [ '168', '168' ],
                    [ '167', '167' ],
                    [ '166', '166' ],
                    [ '165', '165' ],
                    [ '164', '164' ],
                    [ '163', '163' ],
                    [ '162', '162' ],
                    [ '161', '161' ],
                    [ '160', '160' ],
                    [ '159', '159' ],
                    [ '158', '158' ],
                    [ '157', '157' ],
                    [ '156', '156' ],
                    [ '155', '155' ],
                    [ '154', '154' ],
                    [ '153', '153' ],
                    [ '152', '152' ],
                    [ '151', '151' ],
                    [ '150', '150' ],
                    [ '149', '149' ],
                    [ '148', '148' ],
                    [ '147', '147' ],
                    [ '146', '146' ],
                    [ '145', '145' ],
                    [ '144', '144' ],
                    [ '143', '143' ],
                    [ '142', '142' ],
                    [ '141', '141' ],
                    [ '140', '140' ],
                    [ '139', '139' ],
                    [ '138', '138' ],
                    [ '137', '137' ],
                    [ '136', '136' ],
                    [ '135', '135' ],
                    [ '134', '134' ],
                    [ '133', '133' ],
                    [ '132', '132' ],
                    [ '131', '131' ],
                    [ '130', '130' ],
                    [ '129', '129' ],
                    [ '128', '128' ],
                    [ '127', '127' ],
                    [ '126', '126' ],
                    [ '125', '125' ],
                    [ '124', '124' ],
                    [ '123', '123' ],
                    [ '122', '122' ],
                    [ '121', '121' ],
                    [ '120', '120' ],
                    [ '119', '119' ],
                    [ '118', '118' ],
                    [ '117', '117' ],
                    [ '116', '116' ],
                    [ '115', '115' ],
                    [ '114', '114' ],
                    [ '113', '113' ],
                    [ '112', '112' ],
                    [ '111', '111' ],
                    [ '110', '110' ],
                    [ '109', '109' ],
                    [ '108', '108' ],
                    [ '107', '107' ],
                    [ '106', '106' ],
                    [ '105', '105' ],
                    [ '104', '104' ],
                    [ '103', '103' ],
                    [ '102', '102' ],
                    [ '101', '101' ],
                    [ '100', '100' ],
                    [ '99', '99' ],
                    [ '98', '98' ],
                    [ '97', '97' ],
                    [ '96', '96' ],
                    [ '95', '95' ],
                    [ '94', '94' ],
                    [ '93', '93' ],
                    [ '92', '92' ],
                    [ '91', '91' ],
                    [ '90', '90' ],
                    [ '89', '89' ],
                    [ '88', '88' ],
                    [ '87', '87' ],
                    [ '86', '86' ],
                    [ '85', '85' ],
                    [ '84', '84' ],
                    [ '83', '83' ],
                    [ '82', '82' ],
                    [ '81', '81' ],
                    [ '80', '80' ],
                    [ '79', '79' ],
                    [ '78', '78' ],
                    [ '77', '77' ],
                    [ '76', '76' ],
                    [ '75', '75' ],
                    [ '74', '74' ],
                    [ '73', '73' ],
                    [ '72', '72' ],
                    [ '71', '71' ],
                    [ '70', '70' ],
                    [ '69', '69' ],
                    [ '68', '68' ],
                    [ '67', '67' ],
                    [ '66', '66' ],
                    [ '65', '65' ],
                    [ '64', '64' ],
                    [ '63', '63' ],
                    [ '62', '62' ],
                    [ '61', '61' ],
                    [ '60', '60' ],
                    [ '59', '59' ],
                    [ '58', '58' ],
                    [ '57', '57' ],
                    [ '56', '56' ],
                    [ '55', '55' ],
                    [ '54', '54' ],
                    [ '53', '53' ],
                    [ '52', '52' ],
                    [ '51', '51' ],
                    [ '50', '50' ],
                    [ '49', '49' ],
                    [ '48', '48' ],
                    [ '47', '47' ],
                    [ '46', '46' ],
                    [ '45', '45' ],
                    [ '44', '44' ],
                    [ '43', '43' ],
                    [ '42', '42' ],
                    [ '41', '41' ],
                    [ '40', '40' ],
                    [ '39', '39' ],
                    [ '38', '38' ],
                    [ '37', '37' ],
                    [ '36', '36' ],
                    [ '35', '35' ],
                    [ '34', '34' ],
                    [ '33', '33' ],
                    [ '32', '32' ],
                    [ '31', '31' ],
                    [ '30', '30' ],
                    [ '29', '29' ],
                    [ '28', '28' ],
                    [ '27', '27' ],
                    [ '26', '26' ],
                    [ '25', '25' ],
                    [ '24', '24' ],
                    [ '23', '23' ],
                    [ '22', '22' ],
                    [ '21', '21' ],
                    [ '20', '20' ],
                    [ '19', '19' ],
                    [ '18', '18' ],
                    [ '17', '17' ],
                    [ '16', '16' ],
                    [ '15', '15' ],
                    [ '14', '14' ],
                    [ '13', '13' ],
                    [ '12', '12' ],
                    [ '11', '11' ],
                    [ '10', '10' ],
                    [ '9', '9' ],
                    [ '8', '8' ],
                    [ '7', '7' ],
                    [ '6', '6' ],
                    [ '5', '5' ],
                    [ '4', '4' ],
                    [ '3', '3' ],
                    [ '2', '2' ],
                    [ '1', '1' ],
                    [ '0', '0' ],
                ],
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
                key: "ndpi_airplay_server_pin",
                value: ``,
                group: `Backend`,
                allowEditInternal: true,
                allowEditExternal: true,
            },
            {
                key: "ndpi_command_log",
                value: `System Initial Run: v${this.#pgmVersion} ${this.#pgmVersionDate}`,
                group: ``,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "ndi_source_discovery_exec",
                value: `ndi_discover_v2`,
                group: `Receiver`,
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
            {
                key: "media_overlay_image",
                value: ``,
                group: ``,
                allowEditInternal: true,
                allowEditExternal: true,
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
            
            if (this.sendToLCD.includes(setting.key))
            { fs.writeFileSync(path.join(__dirname, '..', 'python', 'script', setting.key), setting.value, 'utf8'); }
        };

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
            this.put('output_display_cec_enabled', 'false');
            this.put('output_display_cec_status_power', 'unknown');
            this.put('output_display_cec_this_source_active', 'false');
            this.put('output_display_cec_version', '');
            this.put('output_display_cec_address', '');
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
}

module.exports = FileSystemMonitor;