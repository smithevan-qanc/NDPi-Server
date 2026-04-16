const redirectSignIn = () => { window.location.href = '/signin.html'; }

(() => {
    console.log(window.location);
    if (window.location.pathname === '/signin.html') {
        localStorage.removeItem('ndpi_token');
        localStorage.removeItem('ndpi_account_id');
    }
})();

async function signIn(pin) {
    if (pin.length !== 4 && pin.length !== 6) {
        return { success: false, message: 'PIN must be 4 or 6 digits', reset: false };
    }
    
    try {
        const res = await fetch('/api/account/signin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin })
        });
        
        const data = await res.json();
        
        if (res.ok) {
            localStorage.setItem('ndpi_token', data.account.token);
            
            if (data.account.firstTimeLogin) {
                window.location.href = '/set-pin.html';
                return  { success: true, message: '', reset: true };
            } else {
                const returnUrl = sessionStorage.getItem('signin_return') || '/';
                sessionStorage.removeItem('signin_return');
                window.location.href = returnUrl;
                return  { success: true, message: '', reset: true };
            }
        } else {
            return { success: false, message: data.error || 'Invalid PIN', reset: true };
        }
    } catch (error) {
        return { success: false, message: 'Network error. Please try again.', reset: false };
    }
}

async function signOut() {
    const confirmSignOut = await modal.confirm('Are you sure you want to sign out?', 'Sign Out');
    if (!confirmSignOut) return;
    
    localStorage.removeItem('ndpi_token');
    localStorage.removeItem('ndpi_account_id');
    localStorage.removeItem('ndpi_account');
    redirectSignIn();
}

async function loadUserAccount() {
    const token = localStorage.getItem('ndpi_token');
    if (!token) {
        redirectSignIn();
		return;
    }
    try {
        const res = await fetch('/api/account', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        const data = await res.json();
        if (res.ok) {
            return data.account;
        } else {
            redirectSignIn();
		    return;
        }
    } catch (error) {
        console.error(error);
        redirectSignIn();
		return;
    }
}

async function updateProfile(firstName, lastName) {
    if (!firstName || !lastName) {
        toast.error('First and last name are required');
        return;
    }
    
    try {
        const res = await fetch(`/api/account/${account.id}/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ firstName, lastName })
        });
        
        if (res.ok) {
            // Update localStorage
            account.firstName = firstName;
            account.lastName = lastName;
            localStorage.setItem('ndpi_account', JSON.stringify(account));
            
            toast.success('Profile updated');
        } else {
            toast.error('Failed to update profile');
        }
    } catch (e) {
        toast.error(`Error updating profile: ${e}`);
    }
}

async function changePIN(newPin, confirmPin) {
    if (!newPin || !confirmPin) {
        toast.error('Please enter and confirm your new PIN');
        return;
    }
    
    if (newPin !== confirmPin) {
        toast.error('PINs do not match');
        return;
    }
    
    if (newPin.length !== 4 && newPin.length !== 6) {
        toast.error('PIN must be 4 or 6 digits');
        return;
    }
    
    const confirmed = await modal.confirm('Are you sure you want to change your PIN?', 'Change PIN');
    if (!confirmed) return;
    
    try {
        const res = await fetch(`/api/account/${account.id}/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: newPin })
        });
        
        if (res.ok) {
            document.getElementById('newPin').value = '';
            document.getElementById('confirmPin').value = '';
            toast.success('PIN changed');
        } else {
            toast.error('Failed to change PIN');
        }
    } catch (e) {
        toast.error('Error changing PIN');
    }
}