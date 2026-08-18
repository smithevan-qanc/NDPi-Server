const ws = initWebSocket();

// Called by 01-scripts/functions.js's bootstrap once `account` has actually
// loaded. This used to run as a top-level IIFE that read account.username
// immediately on script load -- but that runs before the async
// loadUserAccount() call (in functions.js) resolves, so `account` was still
// null and this threw before the event listeners below were ever attached
// (same root cause CLAUDE.md documents as already fixed on settings.html,
// set-pin.html, etc. -- this file was missed).
function initPage() {

    initGlobalHubStats();

    populateFields();

    function populateFields() {
        document.getElementById('username').textContent = account.username;
        document.getElementById('firstName').value = account.firstName;
        document.getElementById('lastName').value = account.lastName;

        // The 'admin' account is locked server-side to PIN-only changes
        // (hub_api_server.js's handleAccountUpdate) -- disable the fields
        // here too so this reads as "not editable" instead of a request
        // that silently gets rejected on submit.
        if (String(account.username).toLowerCase() === 'admin') {
            document.getElementById('firstName').disabled = true;
            document.getElementById('lastName').disabled = true;
            const updateBtn = document.getElementById('update-profile');
            if (updateBtn) { updateBtn.disabled = true; updateBtn.title = "The 'admin' account's name cannot be changed."; }
        }
    }

    document.getElementById('update-profile').addEventListener('click', async function(e) {
        e.preventDefault();
        this.onclick = null;
        const firstName = document.getElementById('firstName').value.trim();
        const lastName = document.getElementById('lastName').value.trim();
        updateProfile(firstName, lastName);
    });

    document.getElementById('changePIN').addEventListener('click', async function(e) {
        e.preventDefault();
        this.onclick = null;
        const newPin = document.getElementById('newPin').value;
        const confirmPin = document.getElementById('confirmPin').value;
        await changePIN(newPin, confirmPin);
    });

    document.getElementById('signOut').addEventListener('click', async function(e) {
        e.preventDefault();
        this.onclick = null;
        await signOut();
    });
}
