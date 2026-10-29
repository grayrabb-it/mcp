import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink, link } from 'node:fs/promises';
import { resolve, parse, join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { ensure, PlayerError } from './errors.js';
const uid = () => process.getuid?.();
const missing = (e) => e?.code === 'ENOENT';
function privateFile(s) { ensure(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && (uid() === undefined || s.uid === uid()) && (s.mode & 0o777) === 0o600, 'WALLET_UNSAFE'); }
async function ancestors(path) {
    let current = parse(path).root;
    for (const part of path.slice(current.length).split('/').filter(Boolean)) {
        current = join(current, part);
        const s = await lstat(current);
        ensure(s.isDirectory() && !s.isSymbolicLink(), 'WALLET_UNSAFE');
    }
}
async function dataDirectory(path) {
    let current = parse(path).root;
    for (const part of path.slice(current.length).split('/').filter(Boolean)) {
        current = join(current, part);
        try {
            const s = await lstat(current);
            ensure(s.isDirectory() && !s.isSymbolicLink(), 'WALLET_UNSAFE');
        }
        catch (e) {
            if (!missing(e))
                throw e;
            await ownDirectory(current);
        }
    }
}
async function ownDirectory(path) {
    try {
        await mkdir(path, { mode: 0o700 });
    }
    catch (e) {
        if (e.code !== 'EEXIST')
            throw e;
    }
    await ancestors(path);
    const s = await lstat(path);
    ensure(s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o777) === 0o700 && (uid() === undefined || s.uid === uid()), 'WALLET_UNSAFE');
}
async function checkedOpen(path, releasedLockSnapshot = false) {
    await ancestors(resolve(path, '..'));
    const before = await lstat(path);
    privateFile(before);
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const s = await fd.stat();
        if (releasedLockSnapshot && s.nlink === 0)
            throw Object.assign(new Error(), { code: 'ENOENT' });
        privateFile(s);
        if (releasedLockSnapshot && (s.ino !== before.ino || s.dev !== before.dev))
            throw Object.assign(new Error(), { code: 'ENOENT' });
        ensure(s.ino === before.ino && s.dev === before.dev && s.size <= 262144, 'WALLET_UNSAFE');
        await ancestors(resolve(path, '..'));
        return fd;
    }
    catch (e) {
        await fd.close();
        throw e;
    }
}
async function read(path, releasedLockSnapshot = false) {
    const fd = await checkedOpen(path, releasedLockSnapshot);
    try {
        const value = JSON.parse(await fd.readFile('utf8'));
        await ancestors(resolve(path, '..'));
        return value;
    }
    finally {
        await fd.close();
    }
}
async function syncDirectory(path) { const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try {
    await fd.sync();
}
finally {
    await fd.close();
} }
async function atomic(path, value, exclusive = false) {
    const parent = resolve(path, '..');
    await ancestors(parent);
    const serialized = JSON.stringify(value);
    ensure(Buffer.byteLength(serialized) <= 262144, 'WALLET_UNSAFE');
    if (exclusive) {
        const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
            await fd.writeFile(serialized);
            await fd.sync();
        }
        finally {
            await fd.close();
        }
        await syncDirectory(parent);
        return;
    }
    try {
        const s = await lstat(path);
        privateFile(s);
    }
    catch (e) {
        if (!missing(e))
            throw e;
    }
    const temp = join(parent, `.write-${randomBytes(16).toString('hex')}`);
    const fd = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
        await fd.writeFile(serialized);
        await fd.sync();
    }
    finally {
        await fd.close();
    }
    try {
        await ancestors(parent);
        try {
            privateFile(await lstat(path));
        }
        catch (e) {
            if (!missing(e))
                throw e;
        }
        await rename(temp, path);
        await syncDirectory(parent);
    }
    finally {
        await unlink(temp).catch(() => { });
    }
}
async function createKey(path, value) {
    const parent = resolve(path, '..');
    await ancestors(parent);
    const temp = join(parent, `.key-${randomBytes(16).toString('hex')}`);
    const fd = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
        await fd.writeFile(JSON.stringify(value));
        await fd.sync();
    }
    finally {
        await fd.close();
    }
    try {
        await ancestors(parent);
        await link(temp, path);
    }
    finally {
        await unlink(temp).catch(() => { });
    }
    await syncDirectory(parent);
}
function lockValue(v) { ensure(v !== null && typeof v === 'object', 'WALLET_UNSAFE'); const o = v; ensure(Number.isSafeInteger(o.pid) && Number(o.pid) > 0 && typeof o.nonce === 'string' && /^[a-f0-9]{32}$/.test(o.nonce), 'WALLET_UNSAFE'); return o; }
function dead(pid) { try {
    process.kill(pid, 0);
    return false;
}
catch (e) {
    return e.code === 'ESRCH';
} }
async function acquire(directory, check) {
    const path = join(directory, 'operation.lock');
    const token = { pid: process.pid, nonce: randomBytes(16).toString('hex') };
    const start = performance.now();
    while (true) {
        check();
        try {
            await atomic(path, token, true);
            break;
        }
        catch (e) {
            if (e.code !== 'EEXIST')
                throw e;
            let prior;
            try {
                prior = lockValue(await read(path, true));
            }
            catch (e) {
                if (missing(e))
                    continue;
                if (e instanceof SyntaxError) {
                    if (performance.now() - start > 2500)
                        throw new PlayerError('WALLET_BUSY');
                    await new Promise(r => setTimeout(r, 10));
                    continue;
                }
                throw e;
            }
            if (dead(prior.pid)) {
                // A permanent claim gives exactly one cleaner ownership of this dead generation.
                // A cleaner crash stays closed instead of risking another process's live lock.
                const claim = join(directory, `.reaped-${prior.nonce}`);
                try {
                    await atomic(claim, token, true);
                }
                catch (e) {
                    if (e.code === 'EEXIST')
                        throw new PlayerError('WALLET_BUSY');
                    throw e;
                }
                const current = lockValue(await read(path));
                ensure(current.nonce === prior.nonce && current.pid === prior.pid && dead(current.pid), 'WALLET_BUSY');
                await unlink(path);
                await syncDirectory(directory);
                continue;
            }
            if (performance.now() - start > 2500)
                throw new PlayerError('WALLET_BUSY');
            await new Promise(r => setTimeout(r, 10));
        }
    }
    return async () => { const current = lockValue(await read(path)); ensure(current.pid === token.pid && current.nonce === token.nonce, 'WALLET_UNSAFE'); await unlink(path); await syncDirectory(directory); };
}
export class WalletStore {
    root;
    stateName;
    constructor(dataDir, origin) {
        ensure(typeof dataDir === 'string' && dataDir.length > 0 && dataDir.length <= 4096, 'WALLET_UNSAFE');
        this.root = resolve(dataDir);
        this.stateName = `state-${createHash('sha256').update(origin).digest('hex')}.json`;
    }
    async run(profile, create, action, check = () => { }) {
        ensure(typeof profile === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(profile), 'INVALID_REQUEST');
        let release;
        try {
            check();
            await dataDirectory(this.root);
            await ancestors(this.root);
            const data = await lstat(this.root);
            ensure(uid() === undefined || data.uid === uid(), 'WALLET_UNSAFE');
            const wallets = join(this.root, 'wallets');
            await ownDirectory(wallets);
            const directory = join(wallets, profile);
            await ownDirectory(directory);
            check();
            release = await acquire(directory, check);
            check();
            const keyFile = join(directory, 'key.json');
            let keypair;
            let created = false;
            try {
                const saved = await read(keyFile);
                ensure(saved !== null && typeof saved === 'object' && Object.keys(saved).length === 1, 'WALLET_UNSAFE');
                const encoded = saved.key;
                ensure(typeof encoded === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(encoded), 'WALLET_UNSAFE');
                const bytes = Buffer.from(encoded, 'base64');
                ensure(bytes.length === 64 && bytes.toString('base64') === encoded, 'WALLET_UNSAFE');
                keypair = Keypair.fromSecretKey(bytes);
            }
            catch (e) {
                if (!missing(e))
                    throw e;
                ensure(create, 'WALLET_MISSING');
                check();
                keypair = Keypair.generate();
                await createKey(keyFile, { key: Buffer.from(keypair.secretKey).toString('base64') });
                created = true;
            }
            check();
            const stateFile = join(directory, this.stateName);
            let state = {};
            try {
                const saved = await read(stateFile);
                ensure(saved !== null && typeof saved === 'object' && !Array.isArray(saved), 'WALLET_UNSAFE');
                state = saved;
            }
            catch (e) {
                if (!missing(e))
                    throw e;
            }
            const context = { keypair, created, state, async save(value) { check(); await atomic(stateFile, value); context.state = value; check(); } };
            return await action(context);
        }
        catch (e) {
            if (e instanceof PlayerError)
                throw e;
            throw new PlayerError('WALLET_UNSAFE');
        }
        finally {
            if (release)
                await release().catch(() => { });
        }
    }
}
