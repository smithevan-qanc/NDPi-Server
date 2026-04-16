const socket = io();

let currentSources = [];
let currentClients = [];

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    let result = '';
    if (days > 0) result += days + 'd ';
    if (hours > 0) result += hours + 'h ';
    result += minutes + 'm';

    return result;
}
// Update system info display
function updateSystemInfo(data) {
    document.getElementById('hostname').textContent = data.hostname;
    document.getElementById('platform').textContent = data.platform;
    document.getElementById('arch').textContent = data.arch;
    document.getElementById('cpus').textContent = data.cpus;
    document.getElementById('totalMemory').textContent = formatBytes(data.totalMemory);
    document.getElementById('freeMemory').textContent = formatBytes(data.freeMemory);
    document.getElementById('uptime').textContent = formatUptime(data.uptime);
    document.getElementById('loadAverage').textContent = data.loadAverage.map(x => x.toFixed(2)).join(', ');
}

// Update NDI sources display
function updateSourcesDisplay(sources) {
    currentSources = sources;
    const sourcesList = document.getElementById('sources-list');

    if (sources.length === 0) {
        sourcesList.innerHTML = '<div class="no-sources">No NDI sources found</div>';
        return;
    }

    sourcesList.innerHTML = sources.map(source => `
        <div class="source-item">
            <div class="source-info">
                <div class="source-name">${source.name}</div>
                <div class="source-details">${source.address}:${source.port}</div>
            </div>
        </div>
    `).join('');
}

// Update clients display
function updateClientsDisplay(clients) {
    currentClients = clients;
    const clientsList = document.getElementById('clients-list');

    if (clients.length === 0) {
        clientsList.innerHTML = '<div class="no-clients">No clients discovered</div>';
        return;
    }

    clientsList.innerHTML = clients.map(client => {
        const isAuthorized = client.authorized;
        const canControl = isAuthorized && client.status === 'connected';

        return `
        <div class="client-item ${isAuthorized ? 'authorized' : 'discovered'}">
            <div class="client-info">
                <div class="client-name">
                    ${client.name}
                    <span class="client-badge ${isAuthorized ? 'badge-authorized' : 'badge-discovered'}">
                        ${isAuthorized ? 'Authorized' : 'Discovered'}
                    </span>
                </div>
                <div class="client-details">
                    ID: ${client.id} | IP: ${client.ip} |
                    Status: <span class="client-status status-${client.status}">${client.status}</span> |
                    Source: ${client.currentSource || 'None'}
                </div>
            </div>
            <div class="client-controls">
                ${!isAuthorized ? `
                    <button class="control-btn authorize-btn" onclick="authorizeClient('${client.id}')">Authorize</button>
                ` : `
                    <button class="control-btn unauthorize-btn" onclick="unauthorizeClient('${client.id}')">Unauthorize</button>
                    <button class="control-btn rename-btn" onclick="renameClient('${client.id}', '${client.name}')">Rename</button>
                    ${canControl ? `
                        <select class="assign-select" id="source-select-${client.id}">
                            <option value="">Select Source</option>
                            ${currentSources.map(source => `<option value="${source.name}" ${client.currentSource === source.name ? 'selected' : ''}>${source.name}</option>`).join('')}
                        </select>
                        <button class="assign-btn" onclick="assignSource('${client.id}')">Assign</button>
                        <button class="control-btn shutdown-btn" onclick="shutdownClient('${client.id}')">Shutdown</button>
                        <button class="control-btn reboot-btn" onclick="rebootClient('${client.id}')">Reboot</button>
                    ` : ''}
                `}
            </div>
        </div>
    `}).join('');
}

// Assign NDI source to client
async function assignSource(clientId) {
    const select = document.getElementById(`source-select-${clientId}`);
    const sourceName = select.value;

    if (!sourceName) {
        alert('Please select a source first');
        return;
    }

    try {
        const response = await fetch('/api/assign-source', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ clientId, sourceName })
        });

        const result = await response.json();
        if (result.success) {
            alert(result.message);
        } else {
            alert('Error: ' + result.error);
        }
    } catch (error) {
        console.error('Error assigning source:', error);
        alert('Failed to assign source');
    }
}

// Authorize a client
async function authorizeClient(clientId) {
    if (!confirm('Authorize this client? It will be able to connect and receive commands.')) {
        return;
    }

    try {
        const response = await fetch(`/api/device/${clientId}/authorize`, {
            method: 'POST'
        });

        const result = await response.json();
        if (result.success) {
            alert(result.message);
        } else {
            alert('Error: ' + result.error);
        }
    } catch (error) {
        console.error('Error authorizing client:', error);
        alert('Failed to authorize client');
    }
}

// Unauthorize a client
async function unauthorizeClient(clientId) {
    if (!confirm('Unauthorize this client? It will be disconnected and unable to reconnect.')) {
        return;
    }

    try {
        const response = await fetch(`/api/device/${clientId}/unauthorize`, {
            method: 'POST'
        });

        const result = await response.json();
        if (result.success) {
            alert(result.message);
        } else {
            alert('Error: ' + result.error);
        }
    } catch (error) {
        console.error('Error unauthorizing client:', error);
        alert('Failed to unauthorize client');
    }
}

// Rename a client
async function renameClient(clientId, currentName) {
    const newName = prompt('Enter new name for the client:', currentName);
    if (!newName || newName === currentName) {
        return;
    }

    try {
        const response = await fetch(`/api/device/${clientId}/rename`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ newName })
        });

        const result = await response.json();
        if (result.success) {
            alert(result.message);
        } else {
            alert('Error: ' + result.error);
        }
    } catch (error) {
        console.error('Error renaming client:', error);
        alert('Failed to rename client');
    }
}

// Shutdown a client
async function shutdownClient(clientId) {
    if (!confirm('Shutdown this client device?')) {
        return;
    }

    try {
        const response = await fetch(`/api/device/${clientId}/shutdown`, {
            method: 'POST'
        });

        const result = await response.json();
        if (result.success) {
            alert(result.message);
        } else {
            alert('Error: ' + result.error);
        }
    } catch (error) {
        console.error('Error shutting down client:', error);
        alert('Failed to shutdown client');
    }
}

// Reboot a client
async function rebootClient(clientId) {
    if (!confirm('Reboot this client device?')) {
        return;
    }

    try {
        const response = await fetch(`/api/device/${clientId}/reboot`, {
            method: 'POST'
        });

        const result = await response.json();
        if (result.success) {
            alert(result.message);
        } else {
            alert('Error: ' + result.error);
        }
    } catch (error) {
        console.error('Error rebooting client:', error);
        alert('Failed to reboot client');
    }
}

// Load initial system info
async function loadSystemInfo() {
    try {
        const response = await fetch('/api/system-info');
        const data = await response.json();
        updateSystemInfo(data);
    } catch (error) {
        console.error('Error loading system info:', error);
    }
}

// Load initial clients and sources
async function loadInitialData() {
    try {
        const [clientsRes, sourcesRes] = await Promise.all([
            fetch('/api/clients'),
            fetch('/api/ndi-sources')
        ]);

        const clients = await clientsRes.json();
        const sources = await sourcesRes.json();

        updateClientsDisplay(clients);
        updateSourcesDisplay(sources);
    } catch (error) {
        console.error('Error loading initial data:', error);
    }
}

// Socket.io real-time updates
socket.on('initial-state', (data) => {
    updateClientsDisplay(data.clients);
    updateSourcesDisplay(data.sources);
});

socket.on('client-discovered', (client) => {
    updateClientsDisplay([...currentClients.filter(c => c.id !== client.id), client]);
});

socket.on('client-registered', (client) => {
    updateClientsDisplay([...currentClients.filter(c => c.id !== client.id), client]);
});

socket.on('client-status-updated', (client) => {
    updateClientsDisplay(currentClients.map(c => c.id === client.id ? client : c));
});

socket.on('client-disconnected', (client) => {
    updateClientsDisplay(currentClients.map(c => c.id === client.id ? client : c));
});

socket.on('client-removed', (clientId) => {
    updateClientsDisplay(currentClients.filter(c => c.id !== clientId));
});

socket.on('ndi-sources-updated', (sources) => {
    updateSourcesDisplay(sources);
    // Update client dropdowns with new sources
    updateClientsDisplay(currentClients);
});

// Control buttons
document.getElementById('scan-sources-btn').addEventListener('click', () => {
    // Trigger manual NDI scan (server does this automatically, but this forces it)
    socket.emit('scan-sources');
    alert('Scanning for NDI sources...');
});

document.getElementById('restart-btn').addEventListener('click', () => {
    if (confirm('Are you sure you want to restart the server?')) {
        // In a real implementation, this would call an API endpoint
        alert('Server restart functionality would be implemented here');
    }
});

document.getElementById('shutdown-btn').addEventListener('click', () => {
    if (confirm('Are you sure you want to shutdown the Raspberry Pi?')) {
        // In a real implementation, this would call an API endpoint
        alert('Pi shutdown functionality would be implemented here');
    }
});

document.getElementById('refresh-btn').addEventListener('click', () => {
    loadSystemInfo();
    loadInitialData();
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    loadSystemInfo();
    loadInitialData();
});