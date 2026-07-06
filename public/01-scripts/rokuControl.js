/**
 * Roku TV Control Library
 * 
 * Provides functions to control Roku TVs via their REST API on port 8060.
 * All functions are standalone and don't manipulate the DOM.
 */


const ROKU_PORT = 8060;

/**
 * Get status from a Roku TV
 * @param {string} ipAddress - IP address of the Roku TV
 * @returns {Promise<boolean>} - Success status
 */
async function addRokuTv() {
	// Get IP address
	const ipAddress = await modal.prompt('Enter Roku TV IP address:', '', 'Add Roku TV');
	if (!ipAddress) return;
	
	// Validate IP format
	const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
	if (!ipPattern.test(ipAddress)) {
		toast.error('Invalid IP address format');
		return;
	}
	
	// Fetch device info from Roku
	toast.info('Fetching device information...');
	
	try {
		console.log(`Fetching device info from http://${ipAddress}:${ROKU_PORT}/query/device-info`);
		const response = await fetch(`http://${ipAddress}:${ROKU_PORT}/query/device-info`, {
			method: 'GET',
			headers: { 
				'Accept': 'application/xml'
			 }
		});
        /*
        const response = await fetch('/api/roku-info', {
            method: 'POST',
            body: JSON.stringify({
                ipAddress: ipAddress
            })
        });
        */  
		if (!response.ok) {
			toast.error('Failed to connect to Roku TV. Check IP address.');
			return;
		}
		
		const xmlText = await response.text();
		const parser = new DOMParser();
		const xmlDoc = parser.parseFromString(xmlText, 'application/xml');
		
		const getTagText = (tagName) => xmlDoc.getElementsByTagName(tagName)[0]?.textContent || '';
		
		const deviceInfo = {
			friendlyName: getTagText('friendly-device-name') || getTagText('user-device-name') || 'Roku TV',
			model: getTagText('model-name'),
			manufacturer: getTagText('vendor-name') || 'Roku',
			screenSize: getTagText('screen-size'),
			deviceType: getTagText('is-tv') === 'true' ? 'TV' : 'Device'
		};
		
		// Select group
		if (groups.length === 0) {
			toast.error('No groups available. Create a group first.');
			return;
		}
		
		const groupOptions = groups.map(g => ({ value: g.id, label: g.name }));
		const groupId = await modal.select('Select group for this Roku TV:', groupOptions, null, 'Add Roku TV');
		
		if (!groupId) return;
		
		// Save to server
		const res = await fetch('/api/roku-tv', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				displayName: deviceInfo.friendlyName,
				ipAddress,
				model: deviceInfo.model,
				manufacturer: deviceInfo.manufacturer,
				deviceType: deviceInfo.deviceType,
				screenSize: deviceInfo.screenSize,
				groupId
			})
		});
		
		if (res.ok) {
			toast.success('Roku TV added successfully');
			loadRokuTvs();
		} else {
			const data = await res.json();
			toast.error(data.error || 'Failed to add Roku TV');
		}
	} catch (e) {
		console.error('Error adding Roku TV:', e);
		toast.error('Failed to connect to Roku TV');
	}
}

/**
 * Send a keypress command to a Roku TV
 * @param {string} ipAddress - IP address of the Roku TV
 * @param {string} key - Key to press (e.g., 'Power', 'Home', 'powerOff')
 * @returns {Promise<boolean>} - Success status
 */
async function rokuKeypress(ipAddress, key) {
	try {
		const response = await fetch(`http://${ipAddress}:${ROKU_PORT}/keypress/${key}`, {
			method: 'POST'
		});
		return response.ok;
	} catch (error) {
		console.error(`Failed to send keypress ${key} to ${ipAddress}:`, error);
		return false;
	}
}

/**
 * Toggle power on/off
 * @param {string} ipAddress - IP address of the Roku TV
 * @returns {Promise<boolean>}
 */
async function rokuPowerToggle(ipAddress) {
	return rokuKeypress(ipAddress, 'Power');
}

/**
 * Power off the TV
 * @param {string} ipAddress - IP address of the Roku TV
 * @returns {Promise<boolean>}
 */
async function rokuPowerOff(ipAddress) {
	return rokuKeypress(ipAddress, 'PowerOff');
}

/**
 * Power on the TV
 * @param {string} ipAddress - IP address of the Roku TV
 * @returns {Promise<boolean>}
 */
async function rokuPowerOn(ipAddress) {
	return rokuKeypress(ipAddress, 'PowerOn');
}

/**
 * Press Home button
 * @param {string} ipAddress - IP address of the Roku TV
 * @returns {Promise<boolean>}
 */
async function rokuHome(ipAddress) {
	return rokuKeypress(ipAddress, 'Home');
}

/**
 * Get device information from Roku TV
 * @param {string} ipAddress - IP address of the Roku TV
 * @returns {Promise<Object|null>} - Device info object or null on failure
 */
async function rokuGetDeviceInfo(ipAddress) {
	try {
		const response = await fetch(`http://${ipAddress}:${ROKU_PORT}/query/device-info`);
		if (!response.ok) return null;
		
		const xmlText = await response.text();
		const parser = new DOMParser();
		const xmlDoc = parser.parseFromString(xmlText, 'application/xml');
		
		// Extract relevant fields
		const getTagText = (tagName) => xmlDoc.getElementsByTagName(tagName)[0]?.textContent || '';
		
		return {
			friendlyName: getTagText('friendly-device-name') || getTagText('user-device-name'),
			modelName: getTagText('model-name'),
			modelNumber: getTagText('model-number'),
			serialNumber: getTagText('serial-number'),
			deviceId: getTagText('device-id'),
			vendorName: getTagText('vendor-name'),
			screenSize: getTagText('screen-size'),
			powerMode: getTagText('power-mode'),
			softwareVersion: getTagText('software-version'),
			deviceType: getTagText('is-tv') === 'true' ? 'TV' : 'Device'
		};
	} catch (error) {
		console.error(`Failed to get device info from ${ipAddress}:`, error);
		return null;
	}
}

/**
 * Launch an app by ID
 * @param {string} ipAddress - IP address of the Roku TV
 * @param {string} appId - Roku app ID to launch
 * @returns {Promise<boolean>}
 */
async function rokuLaunchApp(ipAddress, appId) {
	try {
		const response = await fetch(`http://${ipAddress}:${ROKU_PORT}/launch/${appId}`, {
			method: 'POST'
		});
		return response.ok;
	} catch (error) {
		console.error(`Failed to launch app ${appId} on ${ipAddress}:`, error);
		return false;
	}
}

/**
 * Send multiple keypresses to multiple Roku TVs
 * @param {Array<string>} ipAddresses - Array of IP addresses
 * @param {string} key - Key to press
 * @returns {Promise<Array<boolean>>} - Array of success statuses
 */
async function rokuBulkKeypress(ipAddresses, key) {
	return Promise.all(ipAddresses.map(ip => rokuKeypress(ip, key)));
}
