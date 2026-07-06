class NDPiWebSocket {
    constructor() {
        this.ws = null;
        this.reconnectInterval = null;
        this.heartbeatTimeout = null;
        this.heartbeatMaxAge = 30000; // 30 seconds without heartbeat = connection lost
        this.onDevicesUpdate = null;
        this.onServerEvent = null;
        this.onViewersUpdate = null;
        this.currentPage = window.location.pathname + window.location.search;
        this.viewerJoined = false;
        this.connect();
    }
    
    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        try {
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onopen = () => {
                this.stopReconnecting();
                this.hideOfflineOverlay();
                this.resetHeartbeatTimeout();

                console.log('Requesting Connection to NDPi Monitor Server');
                this.sendViewerJoin();
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
            
            this.ws.onclose = () => {
                this.clearHeartbeatTimeout();
                this.viewerJoined = false;
                this.startReconnecting();
            };
            
        } catch (error) {
            console.error('Failed to create WebSocket:', error);
            this.startReconnecting();
        }
    }
    
    sendViewerJoin() {
        const accountData = localStorage.getItem('ndpi_account');

        if (
            accountData &&
            this.ws &&
            this.ws.readyState === WebSocket.OPEN &&
            !this.viewerJoined
        ) {
            this.viewerJoined = true;

            const account = JSON.parse(accountData);
            this.ws.send(JSON.stringify({
                type: 'viewer-join',
                accountId: account.id,
                accountName: `${account.firstName} ${account.lastName}`,
                username: account.username
            }));
        }
    }
    
    sendViewerLeave() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN && this.viewerJoined) {
            this.ws.send(JSON.stringify({
                type: 'viewer-leave',
                accountId: account.id,
                accountName: `${account.firstName} ${account.lastName}`,
                username: account.username
            }));
            this.viewerJoined = false;
        }
    }
    
    handleMessage(message) {
        switch (message.type) {
            case 'connected':
                console.log(message.message);
                this.sendViewerJoin();
                break;
                
            case 'heartbeat':
                this.resetHeartbeatTimeout();
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
                
            case 'active-viewers':
                if (this.onViewersUpdate) {
                    this.onViewersUpdate(message.viewers);
                }
                break;
			
			case 'system-stats':
				if (this.onSystemStatsUpdate) {
					this.onSystemStatsUpdate(message.stats);
				}
				break;
				
			case 'server-shutdown':
			case 'server-reboot':
                if (this.onServerEvent) {
                    this.onServerEvent(message);
                }
                this.showOfflineOverlay(message.type === 'server-shutdown' ? 'Server is shutting down...' : 'Server rebooting...');
                break;
                
            default:
                console.log('WebSocket message:', message);
        }
    }
    
    resetHeartbeatTimeout() {
        this.hideOfflineOverlay();
        this.clearHeartbeatTimeout();

        this.heartbeatTimeout = setTimeout(() => {
            this.showOfflineOverlay('Server connection has been lost...');
        }, this.heartbeatMaxAge);
    }
    
    clearHeartbeatTimeout() {
        if (this.heartbeatTimeout) {
            clearTimeout(this.heartbeatTimeout);
            this.heartbeatTimeout = null;
        }
    }
    
    startReconnecting() {
        if (this.reconnectInterval) return;

        // this.showOfflineOverlay('Server Offline - Reconnecting...');
        document.getElementById('offlineMessage').textContent = 'Reconnecting...'

        this.reconnectInterval = setInterval(() => {
            if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
                this.connect();
            }
        }, 3000);
    }
    
    stopReconnecting() {
        if (this.reconnectInterval) {
            clearInterval(this.reconnectInterval);
            this.reconnectInterval = null;
        }
    }
    
    disconnect() {
        this.sendViewerLeave();
        this.stopReconnecting();
        this.clearHeartbeatTimeout();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
    
    showOfflineOverlay(message = 'Server Offline - Waiting for signal...') {
        let overlay = document.getElementById('offlineOverlay');
        
        // Create overlay if it doesn't exist
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'offlineOverlay';
            overlay.className = 'offline-overlay'
            overlay.innerHTML = `
                <div class="offline-modal">
                    <div class="offline-spinner"></div>
                    <h2>Lost Server Connection</h2>
                    <p id="offlineMessage" class="offline-message">${message}</p>
                </div>
            `;
            document.body.appendChild(overlay);
        } else {
            // Update message if overlay exists
            const msgEl = overlay.querySelector('.offline-message');
            if (msgEl) msgEl.textContent = message;
        }
        
        overlay.classList.add('active');
    }
    
    hideOfflineOverlay() {
        const overlay = document.getElementById('offlineOverlay');
        if (overlay) {
            overlay.classList.remove('active');
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

window.addEventListener('beforeunload', () => {
    if (ndpiWS) {
        ndpiWS.sendViewerLeave();
    }
});

document.addEventListener("online", function() {
    console.log('online now');
});

