let consoleWS = null;
let awaitCd = false;
let commandDir = null;

class NDPiWebSocket {
    constructor() {
        this.ws = null;
        this.pwd = null;
        this.hostname = '';
        this.isConnected = false;
        this.connect();
    }
    
    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/console`;
        try {
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onopen = () => {
                this.onLinePush({
                    text: 'Connecting',
                    color: '#8a8a8a',
                    weight: '600'
                });
            };
            
            this.ws.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    if (message.pwd) this.pwd = `${message.pwd}`;
                    if (message.hostname) this.hostname = `${message.hostname}`;
                    this.handleMessage(message);
                } catch (error) {
                    console.error('Failed to parse WebSocket message:', error);
                }
            };
            
            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.onLinePush({
                    text: 'Error:',
                    color: '#a80000',
                    weight: '600'
                });
                this.onLinePush({
                    text: `${error.timeStamp.toLocaleString()}`,
                    color: 'rgb(255, 0, 0)',
                    weight: '400'
                });
            };
            
            this.ws.onclose = () => {
                this.isConnected = false;
                this.onLinePush({
                    text: 'This session as ended.',
                    color: '#a80000',
                    weight: '600'
                });
                document.getElementById('promptContainer').remove();
            };
            
        } catch (error) {
            console.error('Failed to create WebSocket:', error);
        }
    }

    onLinePush(data, reset = false) {
        const consoleEl = document.getElementById('console-viewer');
        const newLine = document.createElement('pre');
        const txt = String(data.text);
        if (reset) consoleEl.innerHTML = '';

        // handle HTML tags.
        if (txt.includes('<br>')) {
            newLine.innerHTML = txt;
        } else if (txt.includes('<font')) {
            newLine.innerHTML = txt;
        } else if (txt.includes('<') || txt.includes('>')) {
            newLine.textContent = txt;
        } else {
            newLine.innerHTML = txt;
        }
        newLine.className = 'console-line'
        if (data.color) newLine.style.color = data.color;
        if (data.weight) newLine.style.fontWeight = data.weight;
        if (data.fontFamily) newLine.style.fontFamily = data.fontFamily;
        if (data.marginBottom) newLine.style.marginBottom = data.marginBottom;
        if (data.borderBottom) newLine.style.borderBottom = data.borderBottom;
        if (data.isResponse) newLine.style.padding = `0 5px 0 12px`;
        consoleEl.appendChild(newLine);
        newLine.scrollIntoView();
    }
    
    handleMessage(message) {
        const formatted_directory = `${this.pwd}`.replace('/home/ndpi-server/ndpi', '~');

        switch (message.type) {

            case 'connected':
                this.isConnected = true;
                if (Array.isArray(message.data)) {
                    message.data.forEach((response) => {
                        this.onLinePush({
                            text: response.message || '',
                            color: '#9a9a9a',
                            weight: '400',
                            fontFamily: 'system-ui',
                            marginBottom: '1rem',
                            borderBottom: '0.5px solid #676767',
                        }, true);
                    });
                }
                document.getElementById('pwd-label').innerHTML = 
                `<font style="color:#81c127;font-weight:800;">` +
                    `${this.hostname}` +
                `</font>:<font style="color:#008ffc;font-weight:800;">` +
                    `${formatted_directory} $` +
                `</font>`;
                break;
                
            case 'heartbeat':
                this.resetHeartbeatTimeout();
                break;

            case 'response-end':
                this.onLinePush({
                    text: '<font style="color:#222;font-weight:400;">|</font>',
                    color: '#e1e1e1',
                    weight: '600',
                });
                document.getElementById('promptIn').disabled = false;
                document.getElementById('pwd-label').textContent = `${this.pwd} $`;
                document.body.scrollTo({top:500000000, behavior: 'smooth'});
                break;
                
            case 'response':
                if (Array.isArray(message.data)) {
                    message.data.forEach((response) => {
                        if (response.message !== null) {
                            this.onLinePush({
                                text: response.message || '',
                                color: response.font.color || '#e1e1e1',
                                weight: response.font.weight || '400',
                                isResponse: true,
                            });
                        }
                    });
                }
                if (!message.keepOpen) {
                    document.getElementById('promptIn').disabled = false;
                    document.getElementById('promptIn').focus();
                    document.getElementById('pwd-label').innerHTML = 
                    `<font style="color:#81c127;font-weight:800;">` +
                        `${this.hostname}` +
                    `</font>:<font style="color:#008ffc;font-weight:800;">` +
                        `${formatted_directory} $` +
                    `</font>`;
                    //document.body.scrollTo({top:500000000, behavior: 'smooth'});
                }
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

function initConsole() {
    if (account && account.isAdmin && !consoleWS) {
        consoleWS = new NDPiWebSocket();
        return consoleWS;
    } else {
        return null;
    }
}

function killProcess() {
    if (
        consoleWS.ws &&
        consoleWS.ws.readyState === WebSocket.OPEN
    ) {
        consoleWS.ws.send(JSON.stringify({
            type: 'command-kill',
        }));
    }
}

function sendCommand() {
    if (
        consoleWS.ws &&
        consoleWS.ws.readyState === WebSocket.OPEN
    ) {
        document.getElementById('pwd-label').textContent = '';
        const promptInputEl = document.getElementById('promptIn');
        const message = promptInputEl.value;
        promptInputEl.disabled = true;

        commandDir = `${consoleWS.pwd}`;

        consoleWS.ws.send(JSON.stringify({
            type: 'command',
            command: message,
        }));
        
        consoleWS.onLinePush({
            text: `<font style="color:#81c127;font-weight:800;">` +
                `NDPi-Server` +
            `</font>:<font style="color:#008ffc;font-weight:800;">` +
                `${commandDir.replace('/home/ndpi-server/ndpi-monitor', '~')} $` +
            `</font> ${message}`,
            color: '#ffffff',
            weight: '600'
        });
        promptInputEl.value = '';
    }
}

window.addEventListener('beforeunload', () => {
    if (consoleWS) {
        consoleWS.disconnect();
    }
});

document.addEventListener("online", function() {
    console.log('Online now');
});

