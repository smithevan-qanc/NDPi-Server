let account = {};
const ws = initWebSocket();

(() => {
    setScale();
    setNavigationButtons();
    applyActiveNav('navAccount');
})();

(async () => {
    account = await loadUserAccount();
    populateFields();

    function populateFields() {
        document.getElementById('username').textContent = account.username;
        document.getElementById('firstName').value = account.firstName;
        document.getElementById('lastName').value = account.lastName;
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

})();
