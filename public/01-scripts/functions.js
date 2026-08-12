/**
 *  Keeps `.app`'s top/bottom padding matched to the ACTUAL rendered
 *  height of .topbar/.bottombar, instead of the fixed --topbar-height/
 *  --bottombar-height estimate the base CSS uses. Both bars are
 *  `height: auto` with only a `min-height: var(--*-height)`, so their
 *  real height can exceed that estimate once content wraps (long device
 *  names, narrow viewports triggering the bottombar-nav wrap rules,
 *  etc.) -- when that happens the fixed-position bars start overlapping
 *  page content instead of just reserving space for it.
 *
 *  Recalculated on initial load and any time either bar's own box size
 *  actually changes, via ResizeObserver rather than a plain window
 *  'resize' listener -- a bar's height can change independent of the
 *  window itself (e.g. text reflow), and ResizeObserver only fires when
 *  the observed element's box actually changes, so it doesn't do
 *  wasted work on a width-only resize that leaves both bars' heights
 *  untouched. Runs independently of the account-loading IIFE below so
 *  layout is correct immediately, not after that async work resolves.
 *  Skips pages with no app shell (set-pin.html, create-account.html)
 *  the same way the bootstrap below already does.
 */
function syncAppPaddingToBars() {
	const appEl = document.querySelector('.app');
	const topbarEl = document.querySelector('.topbar');
	const bottombarEl = document.querySelector('.bottombar');
	if (!appEl || !topbarEl || !bottombarEl) return;

	appEl.style.paddingTop = `calc(${topbarEl.offsetHeight}px + var(--main-body-padding))`;
	appEl.style.paddingBottom = `calc(${bottombarEl.offsetHeight}px + var(--main-body-padding))`;
}

function initAppPaddingSync() {
	const appEl = document.querySelector('.app');
	const topbarEl = document.querySelector('.topbar');
	const bottombarEl = document.querySelector('.bottombar');
	if (!appEl || !topbarEl || !bottombarEl) return;

	syncAppPaddingToBars();

	if (typeof ResizeObserver === 'function') {
		const observer = new ResizeObserver(() => { syncAppPaddingToBars(); });
		observer.observe(topbarEl);
		observer.observe(bottombarEl);
	} else {
		window.addEventListener('resize', syncAppPaddingToBars);
	}
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', initAppPaddingSync);
} else {
	initAppPaddingSync();
}

(async () => {
	setScale();

	// Auth-flow pages (set-pin, create-account) don't have the persistent
	// app shell (topbar/bottombar nav) — skip shell-specific setup on them
	// instead of throwing, since that would abort this whole IIFE before
	// loadUserAccount()/initPage() ever run.
	const pageLogo = document.getElementById('topbarLogo');
	const topbarEl = document.querySelector('.topbar');
	if (pageLogo && topbarEl) {
		const topbarHeight = topbarEl.clientHeight;
		pageLogo.style.width = topbarHeight ? `${topbarHeight - 10}px` : `100px`;
		pageLogo.style.height = topbarHeight ? `${topbarHeight - 10}px` : `100%`;
	}

	await loadUserAccount();

	if (document.getElementById('navDashboard')) {
		setNavigationButtons();
	}

	if (typeof initPage === 'function') { initPage(account); }
})();

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