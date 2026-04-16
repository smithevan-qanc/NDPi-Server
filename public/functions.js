
function setScale() {
    const savedScale = localStorage.getItem('ndpi_ui_scale') || '100';
	const scaleDecimal = savedScale / 100;
	document.body.style.zoom = scaleDecimal;
	if (!document.body.style.zoom) {
		document.body.style.transform = `scale(${scaleDecimal})`;
		document.body.style.transformOrigin = 'top left';
	}
}

function setNavigationButtons() {
	const dashboardNavEl = document.getElementById('navDashboard');
	dashboardNavEl.textContent = `Dashboard`;
	dashboardNavEl.addEventListener('click', function(e) {
		this.onclick = null;
		e.preventDefault();
		window.location.href = '/';
	});
	const devicesNavEl = document.getElementById('navDevices');
	devicesNavEl.textContent = `Devices`;
	devicesNavEl.addEventListener('click', function(e) {
		this.onclick = null;
		e.preventDefault();
		window.location.href = '/devices.html';
	});
	const groupsNavEl = document.getElementById('navGroups');
	groupsNavEl.textContent = `Groups`;
	groupsNavEl.addEventListener('click', function(e) {
		this.onclick = null;
		e.preventDefault();
		window.location.href = '/groups.html';
	});
	const settingsNavEl = document.getElementById('navSettings');
	settingsNavEl.textContent = `Settings`;
	settingsNavEl.addEventListener('click', function(e) {
		this.onclick = null;
		e.preventDefault();
		window.location.href = '/settings.html';
	});
	const userAccountNavEl = document.getElementById('navAccount');
	userAccountNavEl.innerHTML = `<font style="font-weight:800; font-size:75%;">@</font><font style="font-weight:400;">${account.username}</font>`;
	userAccountNavEl.addEventListener('click', function(e) {
		this.onclick = null;
		e.preventDefault();
		window.location.href ='/account-settings.html';
	});
}

function applyActiveNav(element) {
	if (!element) return;
	document.getElementById(element).classList.add('active');
}