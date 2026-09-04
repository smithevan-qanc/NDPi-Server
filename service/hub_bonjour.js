const bonjour = require('bonjour')();
const EventEmitter = require('events');
const path = require('path');

class NDPiBonjourDiscovery extends EventEmitter {
    constructor(fsData) {
        super();
        this.settings = fsData;

        this.discoveredClients   = new Map();

        this.browser = null;
    }

    start() {
        console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'Starting NDPi Client device discovery (mDNS).');

        this.browser = bonjour.find({ type: 'ndpi-monitor-client' });

        this.browser.on('up', (service) => {
            const deviceId = service.txt?.deviceId || 
                service.txt?.deviceid || 
                this.extractTxt(service, 'deviceid');

            const deviceName = service.txt?.deviceName || 
                service.txt?.devicename || 
                this.extractTxt(service, 'devicename') ||
                'NDPi Client';

            const ip = service.txt?.ip || 
                this.extractTxt(service, 'ip') || 
                service.addresses?.[0] || 
                service.host;

            const commandPort = service.txt?.commandPort ||
                service.txt?.commandport ||
                this.extractTxt(service, 'commandport') ||
                service.port;

            if (!deviceId)
            {
                console.warn(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] Discovered an NDPi Device — name: '${service.name}', host: '${service.host}', fqdn: '${service.fqdn}', txt: ${JSON.stringify(service.txt || {})}`);
                return;
            }

            this.settings.upsertDiscoveredClient(deviceId, {
                deviceName,
                ip,
                commandPort,
                lastSeen: new Date().toISOString(),
            });

            const existingClient = this.settings.getClient(deviceId);
            if (existingClient && !this.isDeviceRelayConnected(deviceId))
            {
                this.settings.upsertClient(deviceId, {
                    ip,
                    status: 'online',
                    lastSeen: new Date().toISOString(),
                });
            }

            if (existingClient && ip && commandPort)
            { this.ensureDeviceRelayConnections(deviceId, ip, commandPort); }
        });

        this.browser.on('down', (service) => {
            const deviceId = service.txt?.deviceId || service.txt?.deviceid || this.extractTxt(service, 'deviceid');
            if (!deviceId) return;
            
            const existingClient = this.settings.getClient(deviceId);
            if (existingClient && !this.isDeviceRelayConnected(deviceId))
            {
                this.settings.upsertClient(deviceId, {
                    status: 'offline',
                    lastSeen: new Date().toISOString(),
                });
            }
        });
    }

    stop() {
        if (this.browser)
        {
            try { this.browser.stop(); }
            catch {}
            this.browser = null;
        }
    }

    extractTxt(service, key) {
        const raw = Object.entries(service.txt || {}).map(([k, v]) => `${k}=${v}`).join('');
        const match = new RegExp(`(?:^|[\\x00-\\x1f])${key}=([^\\x00-\\x1f]*)`, 'i').exec(raw);
        return match ? match[1] : null;
    }

    upsertDiscoveredClient(deviceId, data = {}) {
        this.discoveredClients.set(
            deviceId,
            { ...(this.discoveredClients.get(deviceId) || {}), ...data, deviceId });
        this.emit('discovered-clients-update');
    }

    removeDiscoveredClient(deviceId) {
        if (this.discoveredClients.delete(deviceId))
        { this.emit('discovered-clients-update'); }
    }

    getDiscoveredClients() {
        return Array.from(this.discoveredClients.values()).filter((d) => !this.clients.has(d.deviceId));
    }

    // Unfiltered single lookup (unlike getDiscoveredClients(), still
    // returns a result after the device has been adopted into `clients`)
    // — used to recover the ip/commandPort mDNS reported for a device at
    // adopt time, to configure its Hub connection.
    getDiscoveredClient(deviceId) {
        return this.discoveredClients.get(deviceId) || null;
    }
}

module.exports = NDPiBonjourDiscovery;