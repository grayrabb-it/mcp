import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { z } from 'zod';
import { ApiClient, Operation, validateOrigin, isSessionToken } from './api.js';
import { ensure, PlayerError, publicError } from './errors.js';
import { COPY } from './copy.js';
import { WalletStore } from './wallet.js';
import { signEntry, validateSignedEntry, validatePreparedEntry } from './transaction.js';
const uuid = z.string().uuid();
const amount = z.string().regex(/^(0|[1-9]\d{0,19})$/).refine(v => BigInt(v) <= 18446744073709551615n);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const key = z.string().min(32).max(44).refine(v => { try {
    return new PublicKey(v).toBase58() === v;
}
catch {
    return false;
} });
const signature = z.string().max(88).refine(v => { try {
    return bs58.decode(v).length === 64 && bs58.encode(bs58.decode(v)) === v;
}
catch {
    return false;
} });
const round = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const textSchema = z.string().min(1).refine(v => Array.from(v).length <= 1600 && Buffer.byteLength(v) <= 6400 && v.trim().length > 0 && Buffer.from(v).toString('utf8') === v);
const statuses = z.enum(['draft', 'queued', 'judging', 'judgment_unknown', 'scored', 'recording', 'recorded', 'published', 'paying', 'paid', 'failed']);
const attemptSchema = z.object({ id: uuid, status: statuses, round, season: z.number().int().min(1).max(0xffffffff), text: textSchema, burnUnits: amount, commitment: z.string().regex(/^[a-f0-9]{64}$/), rubricVersion: z.string().regex(/^[a-f0-9]{64}$/), entrySignature: signature.nullable(), createdAt: timestamp, score: z.number().min(0).max(1).optional(), winner: z.boolean().optional(), prizeLamports: amount.optional(), resultSignature: signature.optional(), payoutSignature: signature.nullable().optional() });
const fundsSchema = z.object({ wallet: key, network: z.enum(['devnet', 'mainnet-beta']), solLamports: amount, token: z.object({ mint: key, decimals: z.literal(6), units: amount, accountPresent: z.boolean() }), entry: z.object({ round, burnUnits: amount, receiptDepositLamports: amount, networkFeeLamports: amount, requiredSolLamports: amount, sufficientSol: z.boolean(), sufficientTokens: z.boolean(), ready: z.boolean(), program: key, game: key, judge: key }).nullable(), slot: timestamp, checkedAt: timestamp });
const preparedSchema = z.object({ transaction: z.string().min(1).max(1644), blockhash: key, lastValidBlockHeight: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const actorSchema = z.object({ wallet: key, mode: z.literal('agent'), sessionId: uuid, expiresAt: timestamp });
const sessionSchema = z.object({ token: z.string().refine(isSessionToken), actor: actorSchema });
const signedSchema = preparedSchema.extend({ signature });
const pendingSchema = z.object({ text: textSchema, key: z.string().regex(/^[A-Za-z0-9_-]{12,128}$/), id: uuid.optional(), signed: signedSchema.optional(), retiredSigned: z.array(signedSchema).max(64).optional(), reference: fundsSchema.optional(), identity: attemptSchema.optional() });
const receiptSchema = z.object({ key: z.string().regex(/^[A-Za-z0-9_-]{12,128}$/), text: textSchema, attempt: attemptSchema });
const stateSchema = z.object({ version: z.literal(1), origin: z.string(), wallet: key, session: sessionSchema.optional(), pending: pendingSchema.optional(), receipts: z.array(receiptSchema).max(64).optional(), completed: z.array(receiptSchema).max(64).optional() }).strict();
function parse(schema, value, code = 'UNAVAILABLE') { const result = schema.safeParse(value); ensure(result.success, code); return result.data; }
function ownAttempt(value) {
    const a = parse(attemptSchema, value);
    ensure(a.burnUnits === ['100000000000', '250000000000', '500000000000'][a.round - 1]);
    if (a.status !== 'draft' && a.status !== 'failed')
        ensure(a.entrySignature !== null);
    if (['recorded', 'published', 'paying', 'paid'].includes(a.status))
        ensure(a.score !== undefined && a.winner !== undefined && a.prizeLamports !== undefined && a.resultSignature !== undefined && a.payoutSignature !== undefined);
    if (a.status === 'paid')
        ensure(a.winner === true && a.payoutSignature !== null);
    return a;
}
function sameIdentity(a, b) { ensure(a.id === b.id && a.round === b.round && a.season === b.season && a.text === b.text && a.burnUnits === b.burnUnits && a.commitment === b.commitment && a.rubricVersion === b.rubricVersion); }
function accepted(a) { return a.entrySignature !== null && !['draft', 'failed'].includes(a.status); }
function terminal(a) { return (a.status === 'published' && a.winner === false) || (a.status === 'paid' && a.winner === true); }
function safeJson(value, depth = 0, count = { n: 0 }) {
    ensure(depth <= 10 && ++count.n <= 8000);
    if (value === null || typeof value === 'boolean')
        return value;
    if (typeof value === 'number') {
        ensure(Number.isFinite(value));
        return value;
    }
    if (typeof value === 'string') {
        ensure(Buffer.byteLength(value) <= 32000);
        return value;
    }
    if (Array.isArray(value))
        return value.map(v => safeJson(v, depth + 1, count));
    ensure(value !== null && typeof value === 'object');
    const result = {};
    for (const [k, v] of Object.entries(value)) {
        ensure(!['__proto__', 'constructor', 'prototype'].includes(k) && k.length <= 128);
        result[k] = safeJson(v, depth + 1, count);
    }
    return result;
}
export function createPlayer(options) {
    const origin = validateOrigin(options.origin ?? 'https://grayrabb.it', options.development);
    const api = new ApiClient(origin, options.fetch ?? fetch, options.development), store = new WalletStore(options.dataDir, origin), now = options.now ?? Date.now;
    async function withOperation(signal, action) { const op = new Operation(signal); try {
        const result = await action(op);
        op.check();
        return result;
    }
    catch (e) {
        throw publicError(e);
    }
    finally {
        op.close();
    } }
    async function walletRun(profile, signal, create, action) {
        return withOperation(signal, op => store.run(profile, create, async (w) => {
            const address = w.keypair.publicKey.toBase58();
            const state = Object.keys(w.state).length === 0 ? { version: 1, origin, wallet: address } : parse(stateSchema, w.state, 'WALLET_UNSAFE');
            if (state.completed) {
                ensure(!state.receipts, 'WALLET_UNSAFE');
                state.receipts = state.completed;
                delete state.completed;
            }
            ensure(state.origin === origin && state.wallet === address && (!state.session || state.session.actor.wallet === address), 'WALLET_UNSAFE');
            return action(w, state, op);
        }, op.check));
    }
    async function persist(w, state) {
        while (Buffer.byteLength(JSON.stringify(state)) > 240000 && state.receipts && state.receipts.length > 1)
            state.receipts.shift();
        ensure(Buffer.byteLength(JSON.stringify(state)) <= 240000, 'WALLET_UNSAFE');
        await w.save(state);
    }
    async function login(w, state, op) {
        const c = parse(z.object({ id: uuid, wallet: key, message: z.string().max(2048), expiresAt: timestamp, mode: z.literal('agent') }), await api.request('/auth/challenge', op, { method: 'POST', body: { wallet: state.wallet, mode: 'agent' } }));
        ensure(c.wallet === state.wallet && c.expiresAt > now());
        const lines = c.message.split('\n');
        ensure(lines.length === 9);
        const issuedString = lines[6]?.slice('Issued At: '.length), issued = Date.parse(issuedString ?? '');
        ensure(Number.isFinite(issued) && new Date(issued).toISOString() === issuedString && issued <= now() + 30000 && c.expiresAt > issued && c.expiresAt - issued <= 3600000);
        const expected = `grayrabb.it wants you to sign in with your Solana account:\n${state.wallet}\n\nURI: ${origin}\nVersion: 1\nNonce: ${c.id}\nIssued At: ${new Date(issued).toISOString()}\nExpiration Time: ${new Date(c.expiresAt).toISOString()}\nMode: agent`;
        ensure(c.message === expected);
        op.check();
        ensure(c.expiresAt > now());
        const privateKey = createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(w.keypair.secretKey.subarray(0, 32))]) });
        op.check();
        const signed = bs58.encode(sign(null, Buffer.from(expected), privateKey));
        op.check();
        ensure(c.expiresAt > now());
        const session = parse(sessionSchema, await api.request('/auth/session', op, { method: 'POST', body: { wallet: state.wallet, mode: 'agent', challengeId: c.id, signature: signed } }));
        ensure(session.actor.wallet === state.wallet && session.actor.expiresAt > now() && session.actor.expiresAt <= now() + 31 * 86400000);
        state.session = session;
        await persist(w, state);
        return session;
    }
    const authRefreshes = new WeakMap();
    function authenticated(w, state, op) {
        return async (path, options = {}) => {
            if (!state.session || state.session.actor.expiresAt <= now())
                await login(w, state, op);
            try {
                return await api.request(path, op, { ...options, token: state.session.token });
            }
            catch (e) {
                if (!(e instanceof PlayerError) || e.code !== 'UNAUTHORIZED' || (authRefreshes.get(op) ?? 0) >= 1)
                    throw e;
                authRefreshes.set(op, (authRefreshes.get(op) ?? 0) + 1);
                delete state.session;
                await persist(w, state);
                await login(w, state, op);
                return api.request(path, op, { ...options, token: state.session.token });
            }
        };
    }
    async function funds(request, state) {
        const f = parse(fundsSchema, await request('/wallet'));
        ensure(f.wallet === state.wallet && f.checkedAt <= now() + 30000 && now() - f.checkedAt <= 60000);
        if (!f.token.accountPresent)
            ensure(f.token.units === '0');
        if (f.entry) {
            const e = f.entry;
            ensure(e.requiredSolLamports === (BigInt(e.receiptDepositLamports) + BigInt(e.networkFeeLamports)).toString());
            ensure(e.burnUnits === ['100000000000', '250000000000', '500000000000'][e.round - 1]);
            ensure(e.sufficientSol === (BigInt(f.solLamports) >= BigInt(e.requiredSolLamports)) && e.sufficientTokens === (f.token.accountPresent && BigInt(f.token.units) >= BigInt(e.burnUnits)));
        }
        return f;
    }
    async function finish(w, state, a) {
        const pending = state.pending?.id === a.id ? state.pending : undefined;
        const existing = state.receipts?.find(r => r.attempt.id === a.id);
        if (pending) {
            ensure(pending.text === a.text);
            if (pending.identity)
                sameIdentity(pending.identity, a);
            if (pending.signed && a.entrySignature !== null)
                ensure(a.entrySignature === pending.signed.signature);
        }
        if (existing) {
            sameIdentity(existing.attempt, a);
            ensure(accepted(a) && a.entrySignature === existing.attempt.entrySignature);
            existing.attempt = a;
        }
        if (pending && accepted(a)) {
            if (!existing)
                state.receipts = [...(state.receipts ?? []), { key: pending.key, text: pending.text, attempt: a }].slice(-64);
            else
                ensure(existing.key === pending.key && existing.text === pending.text);
            delete state.pending;
        }
        if (existing || (pending && accepted(a)))
            await persist(w, state);
        return { status: terminal(a) ? 'complete' : 'pending', ...(terminal(a) ? {} : { message: COPY.pending }), attempt: a };
    }
    async function refreshReceipt(w, state, op, receipt) {
        const a = ownAttempt(await authenticated(w, state, op)(`/attempts/${receipt.attempt.id}`));
        sameIdentity(receipt.attempt, a);
        ensure(a.entrySignature === receipt.attempt.entrySignature);
        return finish(w, state, a);
    }
    async function progress(w, state, op, preflight) {
        const p = state.pending;
        const request = authenticated(w, state, op);
        let a;
        if (p.id) {
            a = ownAttempt(await request(`/attempts/${p.id}`));
            ensure(a.id === p.id && a.text === p.text);
            if (p.identity)
                sameIdentity(p.identity, a);
        }
        else {
            const f = preflight ?? await funds(request, state);
            preflight = f;
            ensure(f.entry, 'ROUND_CLOSED');
            if (!f.entry.sufficientSol || !f.entry.sufficientTokens)
                return { status: 'funding_required', message: COPY.fundingRequired, wallet: state.wallet, funds: f };
            ensure(f.entry.ready, 'ROUND_CLOSED');
            a = ownAttempt(await request('/attempts', { method: 'POST', body: { text: p.text }, idempotencyKey: p.key }));
            ensure(a.text === p.text && a.round === f.entry.round && a.burnUnits === f.entry.burnUnits);
            p.id = a.id;
            p.identity = a;
            await persist(w, state);
        }
        if (a.status !== 'draft' || a.entrySignature !== null)
            return finish(w, state, a);
        try {
            if (p.signed) {
                ensure(p.reference && p.identity, 'WALLET_UNSAFE');
                sameIdentity(p.identity, a);
                validateSignedEntry(p.signed, a, p.reference, w.keypair, op);
                let next;
                try {
                    next = parse(preparedSchema, await request(`/attempts/${a.id}/transaction`, { method: 'POST', body: {} }));
                }
                catch (error) {
                    if (!(error instanceof PlayerError) || error.code !== 'CONFLICT')
                        throw error;
                    const confirmed = ownAttempt(await request(`/attempts/${a.id}/confirm`, { method: 'POST', body: { signature: p.signed.signature } }));
                    sameIdentity(a, confirmed);
                    ensure(confirmed.entrySignature === p.signed.signature);
                    return finish(w, state, confirmed);
                }
                validatePreparedEntry(next, a, p.reference, w.keypair, op);
                if (next.blockhash !== p.signed.blockhash) {
                    // A changed successful prepare is the API's finalized-expiry and receipt-absence proof.
                    const current = await funds(request, state);
                    ensure(current.entry && current.entry.round === a.round && current.entry.burnUnits === a.burnUnits, 'ROUND_CLOSED');
                    ensure(current.entry.program === p.reference.entry?.program && current.entry.game === p.reference.entry?.game && current.entry.judge === p.reference.entry?.judge && current.token.mint === p.reference.token.mint && current.network === p.reference.network, 'SIGNATURE_REFUSED');
                    if (!current.entry.sufficientSol || !current.entry.sufficientTokens)
                        return { status: 'funding_required', message: COPY.fundingRequired, wallet: state.wallet, funds: current };
                    ensure(current.entry.ready, 'ROUND_CLOSED');
                    ensure((p.retiredSigned?.length ?? 0) < 64, 'PENDING');
                    const replacement = signEntry(next, a, current, w.keypair, op);
                    p.retiredSigned = [...(p.retiredSigned ?? []), p.signed];
                    p.signed = replacement;
                    p.reference = current;
                    await persist(w, state);
                }
                else
                    ensure(next.lastValidBlockHeight === p.signed.lastValidBlockHeight, 'SIGNATURE_REFUSED');
            }
            if (!p.signed) {
                const f = preflight ?? await funds(request, state);
                ensure(f.entry && f.entry.round === a.round && f.entry.burnUnits === a.burnUnits, 'ROUND_CLOSED');
                if (!f.entry.sufficientSol || !f.entry.sufficientTokens)
                    return { status: 'funding_required', message: COPY.fundingRequired, wallet: state.wallet, funds: f };
                ensure(f.entry.ready, 'ROUND_CLOSED');
                const prepared = parse(preparedSchema, await request(`/attempts/${a.id}/transaction`, { method: 'POST', body: {} }));
                op.check();
                p.signed = signEntry(prepared, a, f, w.keypair, op);
                p.reference = f;
                p.identity = a;
                await persist(w, state);
            }
            ensure(p.reference && p.identity, 'WALLET_UNSAFE');
            sameIdentity(p.identity, a);
            validateSignedEntry(p.signed, a, p.reference, w.keypair, op);
            op.check();
            const sent = ownAttempt(await request(`/attempts/${a.id}/submit`, { method: 'POST', body: { transaction: p.signed.transaction } }));
            sameIdentity(a, sent);
            ensure(sent.entrySignature === p.signed.signature);
            return finish(w, state, sent);
        }
        catch (e) {
            if (e instanceof PlayerError && e.code === 'PENDING')
                return { status: 'pending', message: COPY.pending, attempt: a };
            throw e;
        }
    }
    return {
        createWallet(profile, signal) { return walletRun(profile, signal, true, async (w) => ({ profile, wallet: w.keypair.publicKey.toBase58(), created: w.created, funding: COPY.funding })); },
        walletStatus(profile, signal) { return walletRun(profile, signal, false, (w, state, op) => funds(authenticated(w, state, op), state)); },
        huntStatus(signal) {
            return withOperation(signal, async (op) => {
                const schema = z.object({ season: z.number().int().positive(), round: round.nullable(), paused: z.boolean(), pots: z.union([z.array(amount).length(3), z.record(z.string(), amount)]), challenge: z.object({ round, threshold: z.number().min(0).max(1), entryTokens: amount, text: z.string().max(32000), inputRule: z.string().max(8000) }).nullable(), token: z.object({ mint: key, decimals: z.literal(6) }) });
                return parse(schema, await api.request('/round', op));
            });
        },
        history(limit, cursor, signal) {
            return withOperation(signal, async (op) => {
                ensure(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 && (cursor === undefined || (typeof cursor === 'string' && cursor.length <= 512)), 'INVALID_REQUEST');
                const row = z.object({ id: uuid, wallet: key, round, season: z.number().int().positive(), text: textSchema, score: z.number().min(0).max(1), winner: z.boolean(), entrySignature: signature, resultSignature: signature, payoutSignature: signature.nullable(), createdAt: timestamp, publishedAt: timestamp });
                return parse(z.object({ items: z.array(row).max(limit), cursor: z.string().max(512).nullable() }), await api.request(`/history?limit=${limit}${cursor === undefined ? '' : `&cursor=${new URLSearchParams({ cursor }).toString().slice(7)}`}`, op));
            });
        },
        solvedRubric(value, signal) {
            return withOperation(signal, async (op) => {
                parse(round, value, 'INVALID_REQUEST');
                const result = parse(z.object({ round, requirements: z.unknown(), outcomes: z.unknown(), scene: z.unknown() }).strict(), await api.request(`/rounds/${value}/rubric`, op));
                ensure(result.round === value);
                return { round: result.round, requirements: safeJson(result.requirements), outcomes: safeJson(result.outcomes), scene: safeJson(result.scene) };
            });
        },
        submitAttempt(profile, text, idempotencyKey, signal) {
            return walletRun(profile, signal, false, async (w, state, op) => {
                parse(textSchema, text, 'INVALID_REQUEST');
                ensure(idempotencyKey === undefined || (typeof idempotencyKey === 'string' && /^[A-Za-z0-9_-]{12,128}$/.test(idempotencyKey)), 'INVALID_REQUEST');
                const receipt = idempotencyKey ? state.receipts?.find(r => r.key === idempotencyKey) : undefined;
                if (receipt) {
                    ensure(receipt.text === text, 'INVALID_REQUEST');
                    return refreshReceipt(w, state, op, receipt);
                }
                if (state.pending) {
                    const prior = state.pending;
                    ensure(idempotencyKey !== prior.key || prior.text === text, 'INVALID_REQUEST');
                    if (prior.text === text && (idempotencyKey === undefined || idempotencyKey === prior.key))
                        return progress(w, state, op);
                    ensure(prior.id, 'PENDING');
                    const a = ownAttempt(await authenticated(w, state, op)(`/attempts/${prior.id}`));
                    ensure(a.id === prior.id && a.text === prior.text);
                    if (prior.identity)
                        sameIdentity(prior.identity, a);
                    await finish(w, state, a);
                    ensure(!state.pending, 'PENDING');
                }
                const f = await funds(authenticated(w, state, op), state);
                ensure(f.entry, 'ROUND_CLOSED');
                if (!f.entry.sufficientSol || !f.entry.sufficientTokens)
                    return { status: 'funding_required', message: COPY.fundingRequired, wallet: state.wallet, funds: f };
                ensure(f.entry.ready, 'ROUND_CLOSED');
                state.pending = { text, key: idempotencyKey ?? randomUUID() };
                await persist(w, state);
                return progress(w, state, op, f);
            });
        },
        attemptStatus(profile, id, signal) {
            return walletRun(profile, signal, false, async (w, state, op) => {
                parse(uuid, id, 'INVALID_REQUEST');
                const a = ownAttempt(await authenticated(w, state, op)(`/attempts/${id}`));
                ensure(a.id === id);
                if (state.pending?.id === id || state.receipts?.some(r => r.attempt.id === id))
                    await finish(w, state, a);
                return a;
            });
        },
        resumeAttempt(profile, signal) { return walletRun(profile, signal, false, async (w, state, op) => { if (state.pending)
            return progress(w, state, op); const latest = state.receipts?.at(-1); return latest ? refreshReceipt(w, state, op, latest) : { status: 'no_pending', message: COPY.noPending }; }); },
        disconnect(profile, signal) {
            return walletRun(profile, signal, false, async (w, state, op) => {
                if (state.session) {
                    const session = state.session;
                    delete state.session;
                    await persist(w, state);
                    try {
                        parse(z.object({ status: z.literal('signed_out') }), await api.request('/auth/session', op, { method: 'DELETE', token: session.token }));
                    }
                    catch (e) {
                        if (!(e instanceof PlayerError) || e.code !== 'UNAUTHORIZED')
                            throw e;
                    }
                }
                return { status: 'signed_out' };
            });
        },
    };
}
