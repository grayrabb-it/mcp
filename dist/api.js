import { performance } from 'node:perf_hooks';
import { ensure, knownCode, PlayerError } from './errors.js';
export function validateOrigin(value = 'https://grayrabb.it', development = false) {
    ensure(typeof value === 'string' && value.length <= 256, 'INVALID_REQUEST');
    let u;
    try {
        u = new URL(value);
    }
    catch {
        throw new PlayerError('INVALID_REQUEST');
    }
    ensure(!u.username && !u.password && !u.search && !u.hash && u.pathname === '/' && value === u.origin, 'INVALID_REQUEST');
    ensure(value === 'https://grayrabb.it' || (development && u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)), 'INVALID_REQUEST');
    return u.origin;
}
export function isSessionToken(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value))
        return false;
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === value;
}
export class Operation {
    caller;
    duration;
    start = performance.now();
    controller = new AbortController();
    timer;
    abort = () => this.controller.abort();
    constructor(caller, duration = 45000) {
        this.caller = caller;
        this.duration = duration;
        this.timer = setTimeout(this.abort, duration);
        this.timer.unref();
        caller?.addEventListener('abort', this.abort, { once: true });
        if (caller?.aborted)
            this.abort();
    }
    get signal() { return this.controller.signal; }
    check = () => { if (this.signal.aborted || this.caller?.aborted || performance.now() - this.start >= this.duration) {
        this.abort();
        throw new PlayerError();
    } };
    async wait(work, late) {
        return new Promise((resolve, reject) => {
            let finished = false;
            const abort = () => { if (!finished) {
                finished = true;
                reject(new PlayerError());
            } };
            this.signal.addEventListener('abort', abort, { once: true });
            try {
                this.check();
            }
            catch {
                abort();
            }
            work.then(value => { this.signal.removeEventListener('abort', abort); if (finished) {
                try {
                    late?.(value);
                }
                catch { }
                return;
            } try {
                this.check();
                finished = true;
                resolve(value);
            }
            catch (e) {
                finished = true;
                late?.(value);
                reject(e);
            } }, () => { this.signal.removeEventListener('abort', abort); if (!finished) {
                finished = true;
                reject(new PlayerError());
            } });
        });
    }
    close() { clearTimeout(this.timer); this.caller?.removeEventListener('abort', this.abort); }
}
function bounded(value, depth = 0, count = { nodes: 0 }) {
    ensure(depth <= 12 && ++count.nodes <= 12000);
    if (Array.isArray(value)) {
        for (const item of value)
            bounded(item, depth + 1, count);
        return;
    }
    if (value !== null && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
            ensure(key !== '__proto__' && key !== 'constructor' && key !== 'prototype');
            bounded(item, depth + 1, count);
        }
    }
}
function retryDelay(raw) {
    if (raw === null)
        return undefined;
    ensure(raw.length <= 128);
    if (/^\d+$/.test(raw)) {
        const n = Number(raw);
        ensure(Number.isSafeInteger(n));
        return n;
    }
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const modern = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(raw);
    const obsolete = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(raw);
    const asc = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(raw);
    const m = modern ?? obsolete;
    ensure(m || asc);
    const weekday = (m?.[1] ?? asc[1]).slice(0, 3);
    const day = Number(m?.[2] ?? asc[3]);
    const month = months.indexOf(m?.[3] ?? asc[2]);
    let year = Number(m?.[4] ?? asc[7]);
    if (obsolete) {
        const current = new Date().getUTCFullYear();
        year += Math.floor(current / 100) * 100;
        if (year > current + 50)
            year -= 100;
    }
    const hour = Number(m?.[5] ?? asc[4]), minute = Number(m?.[6] ?? asc[5]), second = Number(m?.[7] ?? asc[6]);
    const date = new Date(0);
    date.setUTCFullYear(year, month, day);
    date.setUTCHours(hour, minute, second, 0);
    ensure(date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second && days[date.getUTCDay()] === weekday);
    const wait = Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
    ensure(Number.isSafeInteger(wait));
    return wait;
}
export class ApiClient {
    fetcher;
    origin;
    constructor(origin, fetcher = fetch, development = false) {
        this.fetcher = fetcher;
        this.origin = validateOrigin(origin, development);
    }
    async request(path, operation, options = {}) {
        operation.check();
        ensure(typeof path === 'string' && path.length <= 1800 && path.startsWith('/') && !path.startsWith('//'), 'INVALID_REQUEST');
        const target = new URL(path, this.origin);
        ensure(target.origin === this.origin && !target.hash && /^\/(?:wallet|round|history|auth\/(?:challenge|session)|rounds\/[123]\/rubric|attempts(?:\/[a-f0-9-]{36}(?:\/(?:transaction|submit|confirm))?)?)$/.test(target.pathname) && !/(?:^|\/)(?:\.|%2e)(?:\.|%2e)?(?:\/|$)/i.test(path), 'INVALID_REQUEST');
        ensure(!target.search || (target.pathname === '/history' && [...target.searchParams.keys()].every(k => ['limit', 'cursor'].includes(k))), 'INVALID_REQUEST');
        const headers = { Accept: 'application/json', Origin: this.origin };
        if (options.token !== undefined) {
            ensure(isSessionToken(options.token), 'INVALID_REQUEST');
            headers.Authorization = `Bearer ${options.token}`;
        }
        if (options.idempotencyKey !== undefined) {
            ensure(/^[A-Za-z0-9_-]{12,128}$/.test(options.idempotencyKey), 'INVALID_REQUEST');
            headers['Idempotency-Key'] = options.idempotencyKey;
        }
        const body = options.body === undefined ? undefined : JSON.stringify(options.body);
        ensure(body === undefined || Buffer.byteLength(body) <= 12000, 'INVALID_REQUEST');
        if (body !== undefined)
            headers['Content-Type'] = 'application/json';
        let response;
        let reader;
        try {
            operation.check();
            response = await operation.wait(this.fetcher(`${this.origin}/api/v1${path}`, { method: options.method ?? 'GET', headers, body, signal: operation.signal, redirect: 'manual', credentials: 'omit' }), r => { void r.body?.cancel().catch(() => { }); });
            operation.check();
            ensure(response.status < 300 || response.status >= 400);
            ensure(!response.redirected);
            const length = response.headers.get('content-length');
            if (length !== null)
                ensure(/^\d+$/.test(length) && Number(length) <= 1048576);
            ensure(response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json');
            ensure(response.body);
            reader = response.body.getReader();
            const chunks = [];
            let total = 0, reads = 0;
            while (true) {
                operation.check();
                ensure(++reads <= 256);
                const part = await operation.wait(reader.read());
                operation.check();
                if (part.done)
                    break;
                total += part.value.byteLength;
                ensure(total <= 1048576);
                chunks.push(part.value);
            }
            operation.check();
            const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
            bounded(value);
            operation.check();
            if (!response.ok || (value !== null && typeof value === 'object' && Object.hasOwn(value, 'error'))) {
                const error = value !== null && typeof value === 'object' ? value.error : undefined;
                const object = error !== null && typeof error === 'object' ? error : {};
                throw new PlayerError(knownCode(object.code) ? object.code : response.status === 401 ? 'UNAUTHORIZED' : 'UNAVAILABLE', retryDelay(response.headers.get('retry-after')), typeof object.id === 'string' ? object.id : undefined);
            }
            return value;
        }
        catch (error) {
            if (error instanceof PlayerError)
                throw error;
            throw new PlayerError();
        }
        finally {
            if (reader) {
                void reader.cancel().catch(() => { });
                reader.releaseLock();
            }
            else if (response?.body)
                void response.body.cancel().catch(() => { });
        }
    }
}
