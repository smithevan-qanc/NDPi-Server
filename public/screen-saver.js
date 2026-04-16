(function() {
	'use strict';

	let screenSaverTimeout;
	let screenSaverActive = false;
	let isInitialized = false;
    let logoSquareSize = 250;
    let staticLogoOpacity = 0.8;
    let useLogoA = true;
    const logoAPath = '/assets/nlcsvg-square-outline-light-fill.svg';
    const logoBPath = '/assets/nlcsvg-square.svg';

    // Settings with defaults
    let settings = {
        inactivityMinutes: 5,
        disableSchedules: []
    };

    // Load settings from localStorage
    function loadSettings() {
        const saved = localStorage.getItem('ndpi_screensaver_settings');
        if (saved) {
            settings = JSON.parse(saved);
        }
    }

    // Check if screen saver should be disabled based on schedule
    function isInDisabledSchedule() {
        const now = new Date();
        const currentDay = now.getDay();
        const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        
        return settings.disableSchedules.some(schedule => {
            if (!schedule.days.includes(currentDay)) return false;
            return currentTime >= schedule.startTime && currentTime <= schedule.endTime;
        });
    }

    const logoDisplayInterval = 5000; // Duration to display logo after movement.
    const transitionSettings = {
        // BACKGROUND & BLUR
        modal: {
            timingFunction: 'ease', // Was ease
            duration: 1000,
        },
        // TOP & LEFT
        logoContainer: {
            timingFunction: 'ease-in-out',
            duration: 0,
        },
        // TRANSFORM & OPACITY
        logoSvg: {
            timingFunction: 'ease', // was ease
            duration: 1000,
        },
    }

	function startScreenSaverWait() {
		clearTimeout(screenSaverTimeout);
		const inactivityDuration = settings.inactivityMinutes * 60 * 1000;
		screenSaverTimeout = setTimeout(() => {
			if (!screenSaverActive && !isInDisabledSchedule()) {
				_initScreenSaver();
			} else if (isInDisabledSchedule()) {
				// If in disabled schedule, check again in 1 minute
				startScreenSaverWait();
			}
		}, inactivityDuration);
	}

    function resizeLogo(height = 1000, width= 1000) {
        if (width < height) {
            logoSquareSize = Math.max(width / 5, 100);
        } else {
            logoSquareSize = Math.max(height / 5);
        }
    }

	function _createScreenSaverElements() {
		if (isInitialized) return;

        const appendTo = document.querySelector('.hide-scrollbar');

        resizeLogo(appendTo.clientHeight, appendTo.clientWidth);

		const style = document.createElement('style');
		style.id = 'screen-saver-styles';
		style.textContent = `
			#screen-saver-modal {
				display: none;
				position: fixed;
				top: 0;
				left: 0;
				width: 100%;
				height: 100%;
				z-index: 9999;
				transition: backdrop-filter ${transitionSettings.modal.duration}ms ${transitionSettings.modal.timingFunction},
                    background-color ${transitionSettings.modal.duration}ms ${transitionSettings.modal.timingFunction};
			}

            @keyframes blurAnimation {
				from { backdrop-filter: blur(4px); background-color: rgba(0,0,0,0.7); }
				to   { backdrop-filter: blur(9px); background-color: rgba(0,0,0,1); }
			}

			#logo-container {
                display: none;
                position: fixed;
				height: ${logoSquareSize}px;
				width: ${logoSquareSize}px;
				transition:
                    top ${transitionSettings.logoContainer.duration}ms ${transitionSettings.logoContainer.timingFunction},
                    left ${transitionSettings.logoContainer.duration}ms ${transitionSettings.logoContainer.timingFunction};
			}

			.logo-svg {
				opacity: 0;
				height: 100%;
				width: 100%;
				transition:
                    transform ${transitionSettings.logoSvg.duration}ms ${transitionSettings.logoSvg.timingFunction},
                    opacity ${transitionSettings.logoSvg.duration}ms ${transitionSettings.logoSvg.timingFunction};
			}
		`;
		document.head.appendChild(style);

		const screenSaverModal = document.createElement('div');
		screenSaverModal.id = 'screen-saver-modal';
		screenSaverModal.innerHTML = `
			<div id="logo-container">
				<img src="${logoAPath}" class="logo-svg" alt="Screen Saver Logo" />
			</div>
		`;

        appendTo.appendChild(screenSaverModal);
        // Prior method. Removed body to see if it would overlay no matter where the page is scrolled to.
		/*
         * document.body.appendChild(screenSaverModal);
        */

		isInitialized = true;
	}
    
    function randomFromArray(arr) {
        const randVal = arr[Math.floor(Math.random() * arr.length)];
        return randVal;
    }

	async function _initScreenSaver() {
		_createScreenSaverElements();

        let screenSaverModal = document.getElementById('screen-saver-modal');
        let logoBox = document.getElementById('logo-container');
        let logo = document.querySelector('.logo-svg');

        resizeLogo(screenSaverModal.clientHeight, screenSaverModal.clientWidth);

		if (!screenSaverModal) return;

        // Set active flag immediately so user input is responsive
		screenSaverActive = true;

        // Set logo container (box) to center of screen for initial render.
        logoBox.style.height = `${logoSquareSize}px`;
        logoBox.style.width = `${logoSquareSize}px`;
		logoBox.style.top = `${(screenSaverModal.clientHeight - logoSquareSize) / 2}px`;
		logoBox.style.left = `${(screenSaverModal.clientWidth - logoSquareSize) / 2}px`;

        // Display both elements.
		screenSaverModal.style.display = `block`;
        logoBox.style.display = `block`;

        // Slight pause to allow render of elements. (This prevents a glitchy launch)
        await new Promise(resolve => setTimeout(resolve, 500));
        if (!screenSaverActive) return;

        screenSaverModal.style.backdropFilter = 'blur(4px)';
        screenSaverModal.style.backgroundColor = 'rgba(0,0,0,0.7)';

        // Wait for modal overlay to complete opacity transition...
        await new Promise(resolve => setTimeout(resolve, transitionSettings.modal.duration));
        if (!screenSaverActive) return;
        
        // Start the blur and opacity animation to render every pixel on screen to a different value.
        screenSaverModal.style.animation = `blurAnimation 60s linear infinite alternate running`;

        logo.style.opacity = staticLogoOpacity;

        // Wait for logo to complete opacity transition...
        await new Promise(resolve => setTimeout(resolve, transitionSettings.logoSvg.duration));
        if (!screenSaverActive) return;

        // First cycle of screensaver
        await new Promise(resolve => setTimeout(resolve, logoDisplayInterval));
        if (!screenSaverActive) return;
        
        const topThird = screenSaverModal.clientHeight / 3;
        const leftThird = screenSaverModal.clientWidth / 3;

        let phase = randomFromArray([2,4,6,8]);

		while (screenSaverActive) {
            // Check at start of each loop iteration
            if (!screenSaverActive) break;
            
            let rotation = 0;
            let x, y;

            // Set the next position (x,y) and set the next phase value.
            switch (phase) {
                case 1: // Top-left
                    x = Math.min(Math.random() * leftThird, screenSaverModal.clientWidth - logoSquareSize);
                    y = Math.min(Math.random() * topThird, screenSaverModal.clientHeight - logoSquareSize);
                    phase = randomFromArray([3,9,7,5]);
                    break;
                case 2: // Top-middle
                    x = Math.min(leftThird + Math.random() * leftThird, screenSaverModal.clientWidth - logoSquareSize);
                    y = Math.min(Math.random() * topThird, screenSaverModal.clientHeight - logoSquareSize);
                    phase = randomFromArray([7,9]);
                    break;
                case 3: // Top-right
                    x = Math.min(leftThird + leftThird + Math.random() * leftThird, screenSaverModal.clientWidth - logoSquareSize);
                    y = Math.min(Math.random() * topThird, screenSaverModal.clientHeight - logoSquareSize);
                    phase = randomFromArray([1,7,9,5]);
                    break;
                case 4: // middle-left
                    x = Math.min(Math.random() * leftThird, screenSaverModal.clientWidth - logoSquareSize);
                    y = Math.min(topThird + Math.random() * topThird, screenSaverModal.clientHeight - logoSquareSize);
                    phase = randomFromArray([3,9]);
                    break;
                case 5: // middle-middle
                    x = Math.min(leftThird + Math.random() * leftThird, screenSaverModal.clientWidth - logoSquareSize);
                    y = Math.min(topThird + Math.random() * topThird, screenSaverModal.clientHeight - logoSquareSize);
                    phase = randomFromArray([2,4,6,8]);
                    break;
                case 6: // middle-right
                    x = Math.min(leftThird + leftThird + Math.random() * leftThird, screenSaverModal.clientWidth - logoSquareSize);
                    y = Math.min(topThird + Math.random() * topThird, screenSaverModal.clientHeight - logoSquareSize);
                    phase = randomFromArray([1,7]);
                    break;
                case 7: // Bottom-left
                    x = Math.min(Math.random() * leftThird, screenSaverModal.clientWidth - logoSquareSize);
                    y = Math.min(topThird + topThird + Math.random() * topThird, screenSaverModal.clientHeight - logoSquareSize);
                    phase = randomFromArray([2,6,5]);
                    break;
                case 8: // bottom-middle
                    x = Math.min(leftThird + Math.random() * leftThird, screenSaverModal.clientWidth - logoSquareSize);
                    y = Math.min(topThird + topThird + Math.random() * topThird, screenSaverModal.clientHeight - logoSquareSize);
                    phase = randomFromArray([1,3]);
                    break;
                case 9: // Bottom-right
                    x = Math.min(leftThird + leftThird + Math.random() * leftThird, screenSaverModal.clientWidth - logoSquareSize);
                    y = Math.min(topThird + topThird + Math.random() * topThird, screenSaverModal.clientHeight - logoSquareSize);
                    phase = randomFromArray([2,4,5]);
                    break;
            }

			const logoBox = document.getElementById('logo-container');
			const logo = document.querySelector('.logo-svg');

            if (logo) {
                logo.style.opacity = 0;
                // Wait for logo opacity to transition
                await new Promise(resolve => setTimeout(resolve, transitionSettings.logoSvg.duration));
                
                // Set Logo then flip for next round.
                if (useLogoA) {
                    logo.src = logoAPath;
                } else {
                    logo.src = logoBPath;
                }
                useLogoA = !useLogoA;
            }

            // Move logo to new position
            if (logo && logoBox) {
                logoBox.style.top = `${y}px`;
                logoBox.style.left = `${x}px`;
                logo.style.transform = `rotate(${rotation}deg)`;
            }

            // Transition logo opacity back in slightly after movement transition
            setTimeout(() => {
                if (logo) logo.style.opacity = staticLogoOpacity;
            }, transitionSettings.logoContainer.duration);

			await new Promise(resolve => setTimeout(resolve, logoDisplayInterval));
            await new Promise(resolve => setTimeout(resolve, transitionSettings.logoSvg.duration));
		}
	}

	async function _hideScreenSaver() {
        const screenSaverModal = document.getElementById('screen-saver-modal');
        const logoBox = document.getElementById('logo-container');
        const logo = document.querySelector('.logo-svg');

        // Stop the animation loop first
        screenSaverActive = false;
        clearTimeout(screenSaverTimeout);

        try {
            if (screenSaverModal) {
                // Get current computed values before stopping animation
                const computedStyle = window.getComputedStyle(screenSaverModal);
                const currentBlur = computedStyle.backdropFilter;
                const currentBg = computedStyle.backgroundColor;
                
                // Stop the keyframe animation
                screenSaverModal.style.animation = 'none';
                
                // Lock in the current animated values
                screenSaverModal.style.backdropFilter = currentBlur;
                screenSaverModal.style.backgroundColor = currentBg;
                
                // Wait a frame to ensure the animation stop is processed
                await new Promise(resolve => requestAnimationFrame(resolve));
                
                // Now set the transition property
                screenSaverModal.style.transition = `backdrop-filter ${transitionSettings.modal.duration}ms ${transitionSettings.modal.timingFunction}, background-color ${transitionSettings.modal.duration}ms ${transitionSettings.modal.timingFunction}`;
                
                // Fade out logo
                if (logo) logo.style.opacity = 0;
                
                // Fade out backdrop and background
                screenSaverModal.style.backdropFilter = 'blur(0px)';
                screenSaverModal.style.backgroundColor = 'rgba(0,0,0,0)';
                
                let clearDisplayDuration = Math.max(
                    transitionSettings.logoSvg.duration,
                    transitionSettings.modal.duration
                );

                // Wait for transitions to complete, then remove elements completely
                setTimeout(() => {
                    const screenSaverModal = document.getElementById('screen-saver-modal');
                    const styleTag = document.getElementById('screen-saver-styles');
                    
                    if (screenSaverModal) screenSaverModal.remove();
                    if (styleTag) styleTag.remove();
                    useLogoA = true;
                    isInitialized = false; // Reset flag so elements are recreated fresh next time
                }, clearDisplayDuration);

            } else {
                console.log('screenSaverModal not found.')
            }
        } catch (e) {
            console.error(`Error during handling events: ${e}`)
        }
	}

	function _handleUserActivity() {
		if (screenSaverActive) {
			_hideScreenSaver();
		}
		startScreenSaverWait();
	}

	function init() {
		// Load settings on init
		loadSettings();
		
		// Listen for settings updates
		window.addEventListener('screensaver-settings-updated', (e) => {
			settings = e.detail;
			clearTimeout(screenSaverTimeout);
			startScreenSaverWait();
		});
		
		document.addEventListener('mousemove', _handleUserActivity);
		document.addEventListener('mousedown', _handleUserActivity);
		document.addEventListener('keydown', _handleUserActivity);
		document.addEventListener('scroll', _handleUserActivity);
		document.addEventListener('touchstart', _handleUserActivity);

		startScreenSaverWait();
	}

	// Initialize when DOM is ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

})();