let account = {};

(async () => {
    account = await loadUserAccount();
        // Navigation buttons require account
    setNavigationButtons();
})();

(() => {
    setScale();
    const pageLogo = document.getElementById('topbarLogo');
	const topbarHeight = document.querySelector('.topbar').clientHeight;
	pageLogo.style.width = topbarHeight ? `${topbarHeight - 10}px` : `100px`;
	pageLogo.style.height = topbarHeight ? `${topbarHeight - 10}px` : `100%`;
})();