class NDPiWebSocket {
    constructor() {
        this.ws = null;
        this.onDevicesUpdate = null;
        this.onServerEvent = null;
        this.currentPage = window.location.pathname + window.location.search;
        this.connect();
    }

    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        try {
            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                console.log('Requesting Connection to NDPi Monitor Server');
            };

            this.ws.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    this.handleMessage(message);
                } catch (error) {
                    console.error('Failed to parse WebSocket message:', error);
                }
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
            };

            this.ws.onclose = () => { };

        } catch (error) {
            console.error('Failed to create WebSocket:', error);
        }
    }

    // lives in 01-scripts/ws-hub-stats.js now -- /ws/hub-stats pushes on a
    // steady ~1/sec cadence on every page already, a faster and more
    // reliable liveness signal than this socket's own close/heartbeat
    // events. This socket still triggers the overlay directly for the two
    // cases where it has better information than a generic timeout would:
    // the server announcing its own imminent shutdown/reboot.
    handleMessage(message) {
        switch (message.type) {
            case 'connected':
                console.log(message.message);
                break;

            case 'heartbeat':
                break;

            case 'devices-update':
                if (this.onDevicesUpdate) {
                    this.onDevicesUpdate(message.devices);
                }
                break;

            case 'groups-update':
                if (this.onGroupsUpdate) {
                    this.onGroupsUpdate(message.groups);
                }
                break;

            case 'discovered-devices-update':
                if (this.onDiscoveredDevicesUpdate) {
                    this.onDiscoveredDevicesUpdate(message.devices);
                }
                break;

            case 'ndi-sources':
                if (this.onNDISourceUpdate) {
                    this.onNDISourceUpdate(message.sources);
                }
                break;

			case 'server-shutdown':
			case 'server-reboot':
                if (this.onServerEvent) {
                    this.onServerEvent(message);
                }
                showOfflineOverlay(message.type === 'server-shutdown' ? 'Server is shutting down...' : 'Server rebooting...');
                break;

            default:
                console.log('WebSocket message:', message);
        }
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

let ndpiWS = null;

function initWebSocket() {
    if (!ndpiWS) {
        ndpiWS = new NDPiWebSocket();
    }
    return ndpiWS;
}

function sendMessage(message) {
    if (ndpiWS && ndpiWS.ws && ndpiWS.ws.readyState === WebSocket.OPEN) {
        ndpiWS.ws.send(JSON.stringify(message));
    }
}

document.addEventListener("online", function() {
    console.log('online now');
});
