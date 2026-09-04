const { EventEmitter } = require("ws");
const path = require('path');
const fs = require('fs');
const crypto = require('node:crypto');
const func = require('./functions.js');

class NDPiUserAccountManager extends EventEmitter {
    constructor() {
        super();
        this.accounts = new Map();
        this.accountsPath = path.join(this.dataDir, 'accounts.json');
        //
    }

    loadAccounts() {
        try
        {
            if (fs.existsSync(this.accountsPath))
            {
                this.accounts = new Map(
                    Object.entries(
                        JSON.parse(
                            fs.readFileSync(this.accountsPath, 'utf8')
                        )
                    )
                );
            }
        }
        catch (error)
        {
            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] Loading accounts.json`, error);
            this.accounts = new Map();
        }

        if (this.accounts.size === 0)
        {   
            this.createAccount({
                firstName: 'Admin',
                lastName: 'User',
                username: 'admin',
                pinHash: func.hashPin('0000'),
                isAdmin: true,
            });
            console.info(`[ ${path.basename(__filename).split('.')[0]} ] Default admin account created — Username: admin, PIN: 0000`);
        }
    }

    getAccounts() {
        return Array.from(this.accounts.values());
    }

    // getAccount(id) {
    getAccountById(id) {
        return this.accounts.get(id) || null;
    }

    // findAccountByPinHash(pinHash) {
    getAccountByPinHash(pinHash) {
        return Array.from(this.accounts.values()).find((acc) => acc.pinHash === pinHash) || null;
    }

    // findAccountByUsername(username) {
    getAccountByUsername(username) {
        return Array.from(this.accounts.values()).find((acc) => acc.username.toLowerCase() === String(username || '').toLowerCase()) || null;
    }

    saveAccounts() {
        try
        { 
            fs.writeFileSync(
                this.accountsPath,
                JSON.stringify(Object.fromEntries(this.accounts), null, 2)
            );
        }
        catch (error)
        { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] Saving accounts.json`, error); }
    }

    createAccount({ firstName, lastName, username, pin, isAdmin = false } = {}) {
        const id = crypto.randomUUID();
        const account = {
            id,
            firstName,
            lastName,
            username,
            pinHash: func.hashPin(pin),
            isAdmin: !!isAdmin,
            firstTimeLogin: true,
            createdAt: new Date().toISOString(),
        };
        this.accounts.set(id, account);
        this.saveAccounts();
        return account;
    }

    updateAccount(id, updates = {}) {
        const account = this.accounts.get(id);
        if (!account) return null;

        for (const key of ['firstName', 'lastName', 'username'])
        { if (key in updates) { account[key] = updates[key]; } }

        if ('isAdmin' in updates)
        { account.isAdmin = !!updates.isAdmin; }

        if (updates.pin)
        {
            account.pinHash = func.hashPin(updates.pin);
            account.firstTimeLogin = false;
        }

        if (updates.clearFirstTime)
        { account.firstTimeLogin = false; }

        this.accounts.set(id, account);
        this.saveAccounts();
        return account;
    }

    deleteAccount(id) {
        const existed = this.accounts.delete(id);
        if (existed) { this.saveAccounts(); }
        return existed;
    }
}

module.exports = NDPiUserAccountManager;