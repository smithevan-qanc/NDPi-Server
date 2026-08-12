const net = require('net');
const fs = require('node:fs');
const path = require('path');
const { exec } = require('node:child_process');

/**
 * Convert exec() stdout into an array of lines.
 * @param {string} stdout
 * @returns {Array}
 */
function stdoutToArray(stdout) {
    let a = [];
    let stdin = stdout.trim() || '';
    stdin.split(/\r?\n/).forEach((line) => {
        a.push(line);
    });
    return a;
}

/**
 * Block until outbound network connectivity is available.
 * @param {object} [options]
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {number} [options.retryMs]
 */
async function waitForNetwork({ host = '8.8.8.8', port = 53, retryMs = 1000 } = {}) {
    return await new Promise((resolve) => {
        const tryConnect = () => {
            const socket = new net.Socket();
            socket.setTimeout(2000);
            socket.once('connect', () => {
                const localIP = socket.localAddress;
                socket.destroy();
                resolve(localIP);
            });
            socket.once('timeout', () => {
                socket.destroy();
                setTimeout(tryConnect, retryMs);
            });
            socket.once('error', () => {
                socket.destroy();
                setTimeout(tryConnect, retryMs);
            });
            socket.connect(port, host);
        };
        tryConnect();
    });
}

/**
 * Set the Hub's own attached-display (kiosk screen) output resolution via
 * xrandr, using the 'output_display_port' / 'output_display_resolution_preference'
 * settings. No-op if no display port is configured.
 */
async function setDisplayResolution() {
    let config = {
        displayPort: 'HDMI-1',
        resolution: null,
        framerate: null,
    };

    try { config.displayPort = fs.readFileSync(path.join(process.env.DATA_NDPI_PATH, 'output_display_port'), 'utf8').trim() }
    catch {}

    try { config.resolution = fs.readFileSync(path.join(process.env.DATA_NDPI_PATH, 'output_display_resolution_preference'), 'utf8').trim() }
    catch {}

    try { config.framerate = fs.readFileSync(path.join(process.env.DATA_NDPI_PATH, 'output_display_framerate_preference'), 'utf8').trim() }
    catch {}

    return await new Promise((resolve) => {
        if (config.displayPort == '')
        {
            resolve();
            return;
        }
        exec(`xrandr \
            --output ${config.displayPort} \
            ${config.resolution ? `--mode ${config.resolution}` : '--auto'} \
            ${config.framerate ? `--rate ${config.framerate}` : ''} \
        `, {
            env: { ...process.env }
        }, (error, stderr) => {
            if (error)
            {
                console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ setDisplayResolution() ][ ERROR ] Resolution Set:`, config, stderr);
                resolve();
                return;
            }
            else
            {
                exec('openbox --restart', {
                    env: { ...process.env }
                }, (error, stdout, stderr) => {
                    if (error)
                    {
                        console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ setDisplayResolution() ][ ERROR ] Openbox Restart: ${stderr.toString()}`);
                        resolve();
                        return;
                    }
                    resolve('');
                    return;
                });
            }
        });
    });
}

async function checkForUpdate() {
    return new Promise((resolve) => {
        exec(path.join(__dirname, '..', 'sh', 'check-for-update'), (error, stdout) => {
            if (error)
            {
                console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ checkForUpdate() ] Error when checking for update. {{ ./sh/check-for-update }}`);
                resolve();
            }
            else
            {
                const output = String(stdout.toString());
                try
                {
                    const update = JSON.parse(output);
                    if (update.update_available)
                    { fs.writeFileSync(path.join(process.env.DATA_NDPI_PATH, 'ndpi_version_update_available'), String(update.update_available), 'utf8'); }
                    if (update.newest_version?.ndpi)
                    { fs.writeFileSync(path.join(process.env.DATA_NDPI_PATH, 'ndpi_version_update_version'), String(update.newest_version.ndpi), 'utf8'); }
                }
                catch (err) { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ checkForUpdate() ] Error parsing update.`, err); }
                finally
                {
                    resolve();
                    return;
                }
            }
        });
    });
}

async function updateInstall() {
    let response = {
        success: false,
        message: '',
    };
    await new Promise((resolve) => {
        exec(path.join(__dirname, '..', 'sh', 'install-update'), (error, stdout, stderr) => {
            if (error)
            {
                response.message = stdoutToArray(stderr).join('. ').toString();
                resolve();
            }
            else
            {
                response.data = stdoutToArray(stdout);
                response.success = true;
                response.message = 'Update Installed';
                resolve();
            }
        });
    });
    return response;
}

module.exports = {
    stdoutToArray,
    waitForNetwork,
    setDisplayResolution,
    checkForUpdate,
    updateInstall,
};
