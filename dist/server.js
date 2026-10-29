import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { COPY } from './copy.js';
import { errorEnvelope, PlayerError } from './errors.js';
const profile = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/).default('default');
const walletInput = z.strictObject({ profile });
const noInput = z.strictObject({});
const round = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const historyInput = z.strictObject({ limit: z.number().int().min(1).max(20).default(10), cursor: z.string().max(512).optional() });
const rubricInput = z.strictObject({ round });
const attemptInput = z.strictObject({ profile, id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) });
const submitInput = z.strictObject({
    profile,
    text: z.string().min(1).max(3200).refine((value) => {
        if (value.includes('\0') || Buffer.byteLength(value, 'utf8') > 6400)
            return false;
        let count = 0;
        for (const point of value) {
            if (++count > 1600)
                return false;
            const code = point.codePointAt(0);
            if (code >= 0xd800 && code <= 0xdfff)
                return false;
        }
        return true;
    }),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{12,128}$/).optional(),
});
function publicSchema(schema, unicodeText = false) {
    const input = () => {
        const json = z.toJSONSchema(schema, { io: 'input' });
        if (unicodeText && json.properties?.text && typeof json.properties.text === 'object')
            json.properties.text.maxLength = 1600;
        return json;
    };
    return { '~standard': {
            version: 1,
            vendor: COPY.name,
            jsonSchema: { input, output: () => z.toJSONSchema(schema, { io: 'output' }) },
            validate: (value) => {
                const parsed = schema.safeParse(value);
                return parsed.success ? { value: parsed.data } : { issues: [{ message: COPY.invalid }] };
            },
        } };
}
const unsafeKey = /^(?:stack|stacktrace|secret|secrets|key|keypair|seed|private|privatekey|secretkey|mnemonic|seedphrase|auth|authentication|credential|credentials|bearer|bearertoken|accesstoken|refreshtoken|authorization|cookie|cookies|password|session|sessiontoken|sessionsecret|rawtransaction|debug|environment|env)$/i;
function boundedJson(value) {
    let members = 0;
    let bytes = 0;
    const seen = new Set();
    const visit = (item, depth) => {
        if (++members > 4096 || depth > 12)
            throw new Error();
        if (item === null || typeof item === 'boolean')
            return item;
        if (typeof item === 'number' && Number.isFinite(item))
            return item;
        if (typeof item === 'string') {
            bytes += Buffer.byteLength(item, 'utf8');
            if (bytes > 262144)
                throw new Error();
            return item;
        }
        if (typeof item !== 'object' || seen.has(item))
            throw new Error();
        seen.add(item);
        if (Array.isArray(item)) {
            if (Object.getPrototypeOf(item) !== Array.prototype)
                throw new Error();
            if (item.length > 4096)
                throw new Error();
            const result = [];
            for (let i = 0; i < item.length; i++) {
                const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
                if (!descriptor || !('value' in descriptor))
                    throw new Error();
                result.push(visit(descriptor.value, depth + 1));
            }
            seen.delete(item);
            return result;
        }
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== Object.prototype && prototype !== null)
            throw new Error();
        const keys = Object.keys(item);
        if (keys.length > 4096)
            throw new Error();
        const result = Object.create(null);
        for (const key of keys) {
            if (key.length > 128 || unsafeKey.test(key.replace(/[_-]/g, '')) || key === '__proto__' || key === 'constructor')
                throw new Error();
            const descriptor = Object.getOwnPropertyDescriptor(item, key);
            if (!descriptor || !('value' in descriptor))
                throw new Error();
            if (key === 'token') {
                const token = descriptor.value;
                if (!token || typeof token !== 'object' || Array.isArray(token) || Object.getPrototypeOf(token) !== Object.prototype)
                    throw new Error();
                const allowed = new Set(['mint', 'decimals', 'units', 'accountPresent']);
                if (!Object.hasOwn(token, 'mint') || !Object.hasOwn(token, 'decimals') || Object.keys(token).some((field) => !allowed.has(field)))
                    throw new Error();
            }
            result[key] = visit(descriptor.value, depth + 1);
        }
        seen.delete(item);
        return result;
    };
    const result = visit(value, 0);
    if (result === null || typeof result !== 'object' || Array.isArray(result))
        throw new Error();
    return result;
}
function resultEnvelope(raw, isError = false) {
    const structuredContent = boundedJson(raw);
    const text = JSON.stringify(structuredContent);
    if (Buffer.byteLength(text, 'utf8') > 262144)
        throw new Error();
    const result = { content: [{ type: 'text', text }], structuredContent, ...(isError ? { isError: true } : {}) };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 1048576)
        throw new Error();
    return result;
}
async function respond(work, signal) {
    try {
        signal.throwIfAborted();
        const raw = await work();
        signal.throwIfAborted();
        return resultEnvelope(raw);
    }
    catch (error) {
        return resultEnvelope(errorEnvelope(error), true);
    }
}
export function createMcpServer(player, beginOperation) {
    const server = new McpServer({ name: COPY.name, version: COPY.version }, { instructions: COPY.instructions, maxToolInputElements: 16 });
    const session = new AbortController();
    const operations = new Map();
    const handlers = new Map();
    const closeSession = () => { session.abort(); for (const operation of operations.values())
        operation.abort(); };
    server.server.onclose = closeSession;
    const register = (name, description, schema, annotations, work, unicodeText = false) => {
        const handler = (input, signal) => respond(async () => {
            const stack = [input ?? {}];
            let nodes = 0;
            while (stack.length) {
                if (++nodes > 16)
                    throw new PlayerError('INVALID_REQUEST');
                const value = stack.pop();
                if (value && typeof value === 'object') {
                    const values = Object.values(value);
                    if (values.length > 16)
                        throw new PlayerError('INVALID_REQUEST');
                    stack.push(...values);
                }
            }
            const parsed = schema.safeParse(input ?? {});
            if (!parsed.success)
                throw new PlayerError('INVALID_REQUEST');
            return work(parsed.data, signal);
        }, signal);
        handlers.set(name, handler);
        server.registerTool(name, { description, inputSchema: publicSchema(schema, unicodeText), annotations }, (input, ctx) => handler(input, ctx.mcpReq.signal));
    };
    const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
    const local = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    const sessionRead = { ...local, openWorldHint: true };
    const paid = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
    const resume = { ...paid, idempotentHint: true };
    register('wallet_create', COPY.walletCreate, walletInput, local, (input, signal) => player.createWallet(input.profile, signal));
    register('wallet_status', COPY.walletStatus, walletInput, sessionRead, (input, signal) => player.walletStatus(input.profile, signal));
    register('hunt_status', COPY.huntStatus, noInput, read, (_input, signal) => player.huntStatus(signal));
    register('history', COPY.history, historyInput, read, (input, signal) => player.history(input.limit, input.cursor, signal));
    register('solved_rubric', COPY.solvedRubric, rubricInput, read, (input, signal) => player.solvedRubric(input.round, signal));
    register('submit_attempt', COPY.submitAttempt, submitInput, paid, (input, signal) => player.submitAttempt(input.profile, input.text, input.idempotencyKey, signal), true);
    register('attempt_status', COPY.attemptStatus, attemptInput, sessionRead, (input, signal) => player.attemptStatus(input.profile, input.id, signal));
    register('resume_attempt', COPY.resumeAttempt, walletInput, resume, (input, signal) => player.resumeAttempt(input.profile, signal));
    register('disconnect_wallet', COPY.disconnect, walletInput, { ...local, openWorldHint: true }, (input, signal) => player.disconnect(input.profile, signal));
    server.server.setRequestHandler('tools/call', async (request, ctx) => {
        if (operations.has(ctx.mcpReq.id) || operations.size >= 8) {
            closeSession();
            void server.close().catch(() => { });
            return resultEnvelope(errorEnvelope(new PlayerError('INVALID_REQUEST')), true);
        }
        const operation = new AbortController();
        const abort = () => operation.abort();
        operations.set(ctx.mcpReq.id, operation);
        ctx.mcpReq.signal.addEventListener('abort', abort, { once: true });
        session.signal.addEventListener('abort', abort, { once: true });
        if (ctx.mcpReq.signal.aborted || session.signal.aborted)
            operation.abort();
        let finish;
        try {
            finish = beginOperation?.(ctx.mcpReq.id);
            const handler = handlers.get(request.params.name);
            if (!handler)
                return resultEnvelope(errorEnvelope(new PlayerError('INVALID_REQUEST')), true);
            return await handler(request.params.arguments, operation.signal);
        }
        catch (error) {
            return resultEnvelope(errorEnvelope(error), true);
        }
        finally {
            operations.delete(ctx.mcpReq.id);
            ctx.mcpReq.signal.removeEventListener('abort', abort);
            session.signal.removeEventListener('abort', abort);
            try {
                finish?.(operation.signal.aborted);
            }
            catch {
                closeSession();
                void server.close().catch(() => { });
            }
        }
    });
    return server;
}
