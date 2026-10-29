import { randomUUID } from 'node:crypto';
import { COPY } from './copy.js';
const definitions = {
    INVALID_REQUEST: [COPY.invalid, 'input', 'check_input'],
    UNAUTHORIZED: [COPY.unavailable, 'authentication', 'retry'],
    FORBIDDEN: [COPY.unavailable, 'authentication', 'retry'],
    NOT_FOUND: [COPY.unavailable, 'state', 'retry'],
    CONFLICT: [COPY.pending, 'state', 'resume'],
    RATE_LIMITED: [COPY.unavailable, 'limit', 'wait'],
    ROUND_CLOSED: [COPY.unavailable, 'state', 'check_hunt'],
    PENDING: [COPY.pending, 'state', 'resume'],
    UNAVAILABLE: [COPY.unavailable, 'service', 'retry'],
    MISCONFIGURED: [COPY.unavailable, 'service', 'retry'],
    WALLET_MISSING: [COPY.walletMissing, 'wallet', 'create_wallet'],
    WALLET_UNSAFE: [COPY.walletUnsafe, 'wallet', 'check_storage'],
    WALLET_BUSY: [COPY.walletBusy, 'wallet', 'resume'],
    SIGNATURE_REFUSED: [COPY.signatureRefused, 'security', 'retry'],
};
export class PlayerError extends Error {
    code;
    retryAfterSeconds;
    category;
    action;
    id;
    constructor(code = 'UNAVAILABLE', retryAfterSeconds, id) {
        super(definitions[code][0]);
        this.code = code;
        this.retryAfterSeconds = retryAfterSeconds;
        this.name = 'PlayerError';
        this.category = definitions[code][1];
        this.action = definitions[code][2];
        this.id = id && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id) ? id : randomUUID();
    }
    toJSON() { return errorEnvelope(this); }
}
export function publicError(error) {
    try {
        if (!(error instanceof PlayerError) || !knownCode(error.code))
            return new PlayerError();
        const wait = error.retryAfterSeconds;
        if (wait !== undefined && (typeof wait !== 'number' || !Number.isSafeInteger(wait) || wait < 0))
            return new PlayerError();
        return new PlayerError(error.code, wait, typeof error.id === 'string' ? error.id : undefined);
    }
    catch {
        return new PlayerError();
    }
}
export function errorEnvelope(error) {
    const e = publicError(error);
    return { error: { code: e.code, message: e.message, category: e.category, action: e.action, id: e.id }, ...(e.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: e.retryAfterSeconds }) };
}
export function knownCode(value) { return typeof value === 'string' && Object.hasOwn(definitions, value); }
export function ensure(condition, code = 'UNAVAILABLE') { if (!condition)
    throw new PlayerError(code); }
