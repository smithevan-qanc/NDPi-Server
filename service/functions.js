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
 * Set the Hub's two independent physical output resolutions via xrandr:
 * HDMI-1 on DISPLAY=:0.0 (the kiosk dashboard, config/kiosk.service) and
 * HDMI-2 on DISPLAY=:0.1 (the AirPlay-to-NDI mirror, see
 * config/systemd/uxplay-*.service and config/xorg/10-hdmi-zaphod.conf --
 * both are independent "Zaphod mode" screens on the SAME Xorg process/DRM
 * master, not separate X servers), each read from its own
 * 'output_display_hdmiN_resolution_preference' /
 * 'output_display_hdmiN_framerate_preference' settings. Unlike the Client
 * (one screen, both outputs mirrored), these two screens show independent
 * content, so each is configured with its own `xrandr` invocation against
 * its own DISPLAY -- no `--same-as`. A port with no resolution preference
 * on disk yet is left untouched (`--auto`).
 */
async function setDisplayResolution() {
    const ports = [
        { xrandrName: 'HDMI-1', display: ':0.0', keyPrefix: 'output_display_hdmi1', restartOpenbox: true },
        { xrandrName: 'HDMI-2', display: ':0.1', keyPrefix: 'output_display_hdmi2', restartOpenbox: false },
    ];

    for (const port of ports)
    {
        let resolution = null;
        let framerate = null;

        try { resolution = fs.readFileSync(path.join(process.env.DATA_NDPI_PATH, `${port.keyPrefix}_resolution_preference`), 'utf8').trim() }
        catch {}

        try { framerate = fs.readFileSync(path.join(process.env.DATA_NDPI_PATH, `${port.keyPrefix}_framerate_preference`), 'utf8').trim() }
        catch {}

        await new Promise((resolve) => {
            exec(`xrandr \
                --output ${port.xrandrName} \
                ${resolution ? `--mode ${resolution}` : '--auto'} \
                ${framerate ? `--rate ${framerate}` : ''} \
            `, {
                env: { ...process.env, DISPLAY: port.display }
            }, (error, stderr) => {
                if (error)
                {
                    console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ setDisplayResolution() ][ ERROR ] Resolution Set (${port.xrandrName}):`, { resolution, framerate }, stderr);
                    resolve();
                    return;
                }
                else if (port.restartOpenbox)
                {
                    exec('openbox --restart', {
                        env: { ...process.env, DISPLAY: port.display }
                    }, (error, stdout, stderr) => {
                        if (error)
                        { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ setDisplayResolution() ][ ERROR ] Openbox Restart (${port.xrandrName}): ${stderr.toString()}`); }
                        resolve();
                        return;
                    });
                }
                else
                {
                    resolve();
                    return;
                }
            });
        });
    }
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
                    console.log(`[ ${path.basename(__filename).split('.')[0]} ] Update Version Type: ${update.versionFrom || 'Not Defined'}`);
                    if (update.update_available)
                    { fs.writeFileSync(path.join(process.env.DATA_NDPI_PATH, 'ndpi_version_update_available'), String(update.update_available), 'utf8'); }
                    if (update.newest_version?.ndpi)
                    { fs.writeFileSync(path.join(process.env.DATA_NDPI_PATH, 'ndpi_version_update_version'), String(update.newest_version.ndpi), 'utf8'); }
                    if (update.newest_version?.released)
                    { fs.writeFileSync(path.join(process.env.DATA_NDPI_PATH, 'ndpi_version_update_version_date'), String(update.newest_version.released), 'utf8'); }
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
