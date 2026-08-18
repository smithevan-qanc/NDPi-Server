const fs = require('fs');
const path = require('path');
const func = require('./service/functions.js');
const { exec, spawn } = require('node:child_process');
const { exit } = require('node:process');

const VERSION_DIR = path.join(__dirname, 'version');
const NDPi_VERSION = (
    fs.existsSync(`${VERSION_DIR}/current`) ?
    fs.readFileSync(`${VERSION_DIR}/current`, 'utf8') :
    '3.1.0'
);
const NDPi_VERSION_DATE = (
    fs.existsSync(`${VERSION_DIR}/current-date`) ?
    fs.readFileSync(`${VERSION_DIR}/current-date`, 'utf8') :
    '2026-02-04'
);


class NDPi {
    constructor() {
        this.isInitialized = false;

        // this.settings = null;
        this.server_api = null;
        this.service_bonjour = null;
        this.service_chromium = null;
        this.controller_cec = null;
        this.ndiReceiver = null;

        this.pythonBackend = null;

        this.lcdDisplayRestartTimer = null;
        this.lcdDisplay = null;

        this.wsConnection_ndpiServer = null;
        this.ndpiServerStatusUpdate = null; // Interval Timer

        this.timerRestartNdi = null;
        this.targetSource = 'none';

        this.compMgr = null;

        this.shutdown = false;

        this.airPlay = null;
        this.airplayPin = 7584;

        this.initiate();
    }

    /** INITIATE */
    initiate() {
        const execStartup = async () => {
            const startup = exec(`./sh/startup`);
            startup.stdout.on('data', (data) => {
                data
                    .toString()
                    .split(/\r?\n/)
                    .forEach((line) => { console.info(line) });
            });
            startup.once('exit', () => {
                console.info(process.env);
                this.startFsData();
            });
        };
        execStartup();
    }

    /**
     * START FILE SYSTEM WATCHER
     */
    startFsData() {
        this.settings = new (require('./service/hub_fs.js'))(NDPi_VERSION, NDPi_VERSION_DATE);

        //  FS System Ready
        this.settings.on('ready', () => {
            this.targetSource = this.settings.get('ndpi_status_ndi_source_target') || 'none';
            func.setDisplayResolution();
            // this.startAirPlay();
            // this.startLcdDisplay();
            // this.startMdns();
            // this.startPythonBackend();
            this.startApi();
        });

        // //  NDI Source Target
        // this.settings.on('ndpi_status_ndi_source_target', (data) => {
        //     const output = String(data || 'none');
        //     this.startNdiReceiver(output);
        // });

        // //  NDPi Hub Server IP
        // this.settings.on('ndpi_command_server_host', (data) => {
        //     const output = String(data || '').trim() || null;

        //     if (!output)
        //     { return; }

        //     if (this.wsConnection_ndpiServer)
        //     {
        //         if (output !== this.wsConnection_ndpiServer.ndpiServerIp)
        //         {
        //             this.wsConnection_ndpiServer.ndpiServerIp = output;
        //             this.wsConnection_ndpiServer.close();
        //             this.wsConnection_ndpiServer.connect();
        //         }
        //     }
        // });

        // //  NDPi Hub Server Port
        // this.settings.on('ndpi_command_server_port', (data) => {
        //     const output = String(data || '').trim() || null;
        //     if (!output)
        //     { return; }

        //     try
        //     {
        //         if (output !== this.wsConnection_ndpiServer.ndpiServerIp)
        //         {
        //             this.wsConnection_ndpiServer.ndpiServerIp = output;
        //             this.wsConnection_ndpiServer.close();
        //             this.wsConnection_ndpiServer.connect();
        //         }
        //     }
        //     catch {}
        // });

        //  Device Name
        this.settings.on('device_name', (data) => {
            const output = String(data.toString().trim() || '') || null;
            if (!output)
            {
                fs.writeFileSync(path.join(process.env.DATA_NDPI_PATH, 'device_name'), this.settings.defaultDeviceName, 'utf8');
                return;
            }

            // if (this.controller_cec)
            // { this.controller_cec.updateDeviceName(output); }

            // this.restartAirPlay();
        });

        //  Device IP
        this.settings.on('device_ip', (data) => {
            const output = String(data || '').trim() || null;
            if (!output)
            { return; }
        });

        //  API Port Number
        this.settings.on('local_port_number_api', async (data) => {
            const output = String(data || '').trim() || null;

            if (!output) { return; }

            // if (this.service_chromium) { await this.service_chromium.close(); }
            if (this.server_api) { this.server_api.close(); }

            console.info(`[ ${path.basename(__filename).split('.')[0]} ] Updated API Server PORT.`);
            console.info(`[ ${path.basename(__filename).split('.')[0]} ] Restarting API Server.`);

            setTimeout(() => {
                this.startApi();
            }, 1000);
        });

        //  HDMI Port
        this.settings.on('output_display_port', async (data) => {
            const output = String(data || '').trim() || null;
            if (output) { await func.setDisplayResolution(); }
        });

        //  HDMI Resolution
        this.settings.on('output_display_resolution_preference', (data) => {
            func.setDisplayResolution();
        });

        // //  ApirPlay PIN
        // this.settings.on('ndpi_airplay_server_pin', () => {
        //     this.restartAirPlay();
        // });
    }

    async _closeFsData() {
        return new Promise(async (resolve) => {
            if (this.settings)
            {
                await this.settings.close();
                resolve();
            }
            else
            {
                console.error(`FsData wasn't running...`, this.settings);
                resolve();
            }
        });
    }

    /**
     * START API
     */
    startApi() {
        this.server_api = new (require('./service/hub_api_server.js'))(this.settings);

        this.server_api.on('online', () => {
            if (!this.isInitialized)
            {
                this.isInitialized = true;
                // this.openCecController();
                // this.connectToNDPiServer();
                // this.startChromium();
            }
            // else 
            // {
            //     this.startChromium();
            // }
        });

        this.server_api.on('shutdown-command', () => {
            setTimeout(() => { shutdownDevice(); }, 1000);
        });

        this.server_api.on('reboot-command', () => {
            setTimeout(() => { rebootDevice(); }, 1000);
        });

        this.server_api.on('restart-command', () => {
            setTimeout(() => { process.kill(process.pid, 'SIGTERM') }, 1000);
        });
    }

    async _closeApi() {
        if (this.server_api)
        {
            console.log('*** SHUTDOWN ⎯ 8 (1 of 2) [ Start [_closeApi] ]');
            await this.server_api.close();
            console.log('*** SHUTDOWN ⎯ 8 (2 of 2) [ End   [_closeApi] ]');
            this.server_api = null;
        }
    }

    /**
     * START PYTHON BACKEND (NDI)
     */
    startPythonBackend() {
        try {
            const startupScript = path.join(__dirname, 'ndi-backend', 'startup.sh');
            const pythonProcess = spawn('bash', [startupScript], {
                cwd: path.join(__dirname, 'ndi-backend'),
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: false
            });

            pythonProcess.stdout.on('data', (data) => {
                console.log(`[Python Backend] ${data.toString().trim()}`);
            });

            pythonProcess.stderr.on('data', (data) => {
                console.error(`[Python Backend Error] ${data.toString().trim()}`);
            });

            pythonProcess.on('error', (err) => {
                console.error(`Failed to start Python backend: ${err.message}`);
                this.pythonBackend = null;
            });

            pythonProcess.on('exit', (code) => {
                console.warn(`Python backend exited with code ${code}`);
                this.pythonBackend = null;
            });

            this.pythonBackend = pythonProcess;
            console.info(`[ ${path.basename(__filename).split('.')[0]} ] Python Backend (NDI) started successfully`);
        } catch (err) {
            console.error(`[ ${path.basename(__filename).split('.')[0]} ] Failed to start Python Backend: ${err.message}`);
        }
    }

    async _closePythonBackend() {
        return new Promise((resolve) => {
            if (this.pythonBackend) {
                console.log('*** SHUTDOWN ⎯ 7.5 (1 of 2) [ Start [_closePythonBackend] ]');
                
                const timeout = setTimeout(() => {
                    console.warn('Python backend did not exit gracefully, forcing kill');
                    this.pythonBackend.kill('SIGKILL');
                    this.pythonBackend = null;
                    console.log('*** SHUTDOWN ⎯ 7.5 (2 of 2) [ End   [_closePythonBackend] (forced) ]');
                    resolve();
                }, 3000);

                this.pythonBackend.once('exit', () => {
                    clearTimeout(timeout);
                    this.pythonBackend = null;
                    console.log('*** SHUTDOWN ⎯ 7.5 (2 of 2) [ End   [_closePythonBackend] ]');
                    resolve();
                });

                this.pythonBackend.kill('SIGTERM');
            } else {
                resolve();
            }
        });
    }
}

// ******************************************************
// *                                                    *
// *                START NDPi PROCESS                  *
// *                                                    *
// ******************************************************
let quitAttempts = 0;
const index = new NDPi();

async function shutdownDevice() {
    await quitNDPi('SIGTERM');
    await new Promise((resolve) => { setTimeout(() => { resolve(); }, 1000); });
    exec('sudo shutdown now');
}

async function rebootDevice() {
    await quitNDPi('SIGTERM');
    await new Promise((resolve) => { setTimeout(() => { resolve(); }, 1000); });
    exec('sudo reboot');
}

async function quitNDPi(signal) {
    const sig = signal ? `[ ${signal} ]` : '';
    console.info(`[ ${path.basename(__filename).split('.')[0]} ]${sig} Exiting NDPi`);
    
    index.shutdown = true;

    // index.airPlay.once('close', () => {
    //     console.log('AIRPLAY CLOSED');
    // });
    // index.airPlay.kill('SIGINT');

    return new Promise(async (resolve) => {
        const timeout = setTimeout(() => {
            console.error('GRACEFUL SHUTDOWN TIMEOUT EXPIRED. FORCING EXIT');
            resolve();
        }, 10000);

        // console.log('*** SHUTDOWN ⎯ 1');
        // await index._killNdiReceiver();

        // console.log('*** SHUTDOWN ⎯ 2');
        // try {
        //     console.log('*** SHUTDOWN ⎯ 2 (1 of 2) [ Start [ndpiServerStatusUpdate]: clearInterval ]');
        //     clearInterval(index.ndpiServerStatusUpdate);
        //     console.log('*** SHUTDOWN ⎯ 2 (2 of 2) [ End   [ndpiServerStatusUpdate]: clearInterval ]');
        // }
        // catch {}
        // finally { index.ndpiServerStatusUpdate = null; }

        // console.log('*** SHUTDOWN ⎯ 3');
        // try {
        //     console.log('*** SHUTDOWN ⎯ 3 (1 of 2) [ Start [lcdDisplayRestartTimer]: clearInterval ]');
        //     clearTimeout(index.lcdDisplayRestartTimer);
        //     console.log('*** SHUTDOWN ⎯ 3 (2 of 2) [ End   [lcdDisplayRestartTimer]: clearInterval ]');
        // }
        // catch {}
        // finally { index.lcdDisplayRestartTimer = null; }

        // console.log('*** SHUTDOWN ⎯ 4');
        // await index._closeLcdDisplay().catch();

        // console.log('*** SHUTDOWN ⎯ 5');
        // await index._closeCecController().catch();

        // console.log('*** SHUTDOWN ⎯ 6');
        // await index._closeMdns().catch();

        // console.log('*** SHUTDOWN ⎯ 7');
        // try { index.wsConnection_ndpiServer.close(); }
        // catch {}
        // finally {}

        console.log('*** SHUTDOWN ⎯ 7.5');
        await index._closePythonBackend().catch();

        console.log('*** SHUTDOWN ⎯ 8');
        await index._closeApi().catch();

        console.log('*** SHUTDOWN ⎯ 9');
        index._closeFsData();

        clearTimeout(timeout);
        resolve();
    });
}

process.on('uncaughtException', (err) => {
    console.error(' ');
    console.error('🔴🔴🔴');
    console.error('Uncaught Exception');
    console.error('------------------');
    console.error(err);
    console.error('------------------');
    console.error('🔴🔴🔴');
    console.error(' ');
});

process.on('unhandledRejection', async (reason) => {
    console.error(' ');
    console.error('🔴');
    console.error('🔴🔴');
    console.error('🔴🔴🔴');
    console.error('Unhandled REJECTION');
    console.error('-------------------');
    console.error(reason);
    console.error('-------------------');
    console.error('  Restarting NDPi  ');
    console.error('🔴🔴🔴');
    console.error('🔴🔴');
    console.error('🔴');
    console.error(' ');
    exit(1);
    // if (quitAttempts < 10)
    // {
    //     quitAttempts++;
    //     await quitNDPi('unhandledRejection');
    //     exit(0);
    // }
    // else
    // { exit(1); }
});

process.on('SIGTERM', async () => {
    await quitNDPi('SIGTERM');
    exit(0);
});

process.on('SIGINT', async () => {
    await quitNDPi('SIGINT');
    exit(0);
});

process.on('exit', (code) => {
    console.info(`[ EXIT CODE: ${code} ]`);
    console.info('══════════════════════════════════════════  N D P i - M O N I T O R  ═══');
});