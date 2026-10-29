#!/usr/bin/env node
import { Transform } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { COPY } from './copy.js';
export function createBoundedInput(source) {
    let frameBytes = 0;
    let frameStarted = 0;
    let frameTimer;
    let windowStarted = performance.now();
    let windowBytes = 0;
    let windowLines = 0;
    const clearFrame = () => { if (frameTimer)
        clearTimeout(frameTimer); frameTimer = undefined; };
    const input = new Transform({
        highWaterMark: 65536,
        transform(chunk, _encoding, callback) {
            try {
                const now = performance.now();
                if (now - windowStarted >= 1000) {
                    windowStarted = now;
                    windowBytes = 0;
                    windowLines = 0;
                }
                windowBytes += chunk.length;
                if (windowBytes > 262144 || (frameBytes > 0 && now - frameStarted >= 5000))
                    throw new Error(COPY.invalid);
                let offset = 0;
                while (offset < chunk.length) {
                    const newline = chunk.indexOf(10, offset);
                    const end = newline === -1 ? chunk.length : newline + 1;
                    const length = end - offset;
                    if (frameBytes === 0) {
                        frameStarted = performance.now();
                        frameTimer = setTimeout(() => { input.destroy(new Error(COPY.invalid)); }, 5000);
                        frameTimer.unref?.();
                    }
                    frameBytes += length;
                    if (frameBytes > 65536 || performance.now() - frameStarted >= 5000)
                        throw new Error(COPY.invalid);
                    if (newline !== -1) {
                        if (++windowLines > 120)
                            throw new Error(COPY.invalid);
                        clearFrame();
                        frameBytes = 0;
                    }
                    this.push(chunk.subarray(offset, end));
                    offset = end;
                }
                callback();
            }
            catch {
                callback(new Error(COPY.invalid));
            }
        },
        flush(callback) { clearFrame(); callback(frameBytes === 0 ? undefined : new Error(COPY.invalid)); },
        destroy(error, callback) {
            clearFrame();
            source.unpipe(input);
            source.off('error', sourceError);
            source.off('close', sourceClose);
            if (source.listenerCount('data') === 0)
                source.pause();
            callback(error);
        },
    });
    const sourceError = () => { input.destroy(new Error(COPY.invalid)); };
    const sourceClose = () => { input.destroy(); };
    source.on('error', sourceError);
    source.once('close', sourceClose);
    if (source.destroyed)
        input.destroy();
    else
        source.pipe(input);
    return input;
}
async function runCli() {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help') {
        process.stdout.write(`${COPY.help}\n`);
        return;
    }
    if (args.length === 1 && args[0] === '--version') {
        process.stdout.write(`${COPY.version}\n`);
        return;
    }
    if (args.length > 0) {
        process.stderr.write(`${COPY.usage}\n`);
        process.exitCode = 1;
        return;
    }
    const { createPlayer } = await import('./player.js');
    const player = createPlayer({
        origin: process.env.GRAYRABBIT_API_ORIGIN ?? 'https://grayrabb.it',
        dataDir: process.env.GRAYRABBIT_DATA_DIR ?? join(homedir(), '.local', 'share', 'grayrabbit'),
        development: process.env.GRAYRABBIT_DEVELOPMENT === '1',
    });
    let reported = false;
    await startMcpStdio(player, process.stdin, process.stdout, () => {
        if (!reported) {
            reported = true;
            process.stderr.write(`${COPY.unavailable}\n`);
        }
        process.exitCode = 1;
    });
}
export async function startMcpStdio(player, stdin, stdout, report) {
    const [{ createMcpServer }, { serveStdio, StdioServerTransport }, { serializeMessage, isJSONRPCRequest, isJSONRPCResponse, isJSONRPCNotification }] = await Promise.all([
        import('./server.js'), import('@modelcontextprotocol/server/stdio'), import('@modelcontextprotocol/server'),
    ]);
    const input = createBoundedInput(stdin);
    const wire = new StdioServerTransport(input, stdout, { maxBufferSize: 65536 });
    const requests = new Map();
    const releaseCancelled = (id, slot) => {
        if (slot.cancelled && slot.settled && slot.sending === 0 && requests.get(id) === slot)
            requests.delete(id);
    };
    let queuedBytes = 0;
    let closed = false;
    let closing;
    const close = () => {
        if (closed)
            return closing ?? Promise.resolve();
        closed = true;
        requests.clear();
        closing = (async () => {
            input.destroy();
            stdout.once('error', () => { });
            stdout.destroy(new Error(COPY.unavailable));
            await wire.close();
            transport.onclose?.();
        })();
        return closing;
    };
    const fail = () => {
        if (closed)
            return;
        transport.onerror?.(new Error(COPY.unavailable));
        void close().catch(() => { });
    };
    const transport = {
        start: () => wire.start(),
        close,
        async send(message) {
            if (closed)
                throw new Error(COPY.unavailable);
            const bytes = Buffer.byteLength(serializeMessage(message), 'utf8');
            if (bytes > 1048576 || queuedBytes + bytes > 2097152) {
                fail();
                throw new Error(COPY.unavailable);
            }
            queuedBytes += bytes;
            const id = isJSONRPCResponse(message) ? message.id : undefined;
            const slot = id === undefined ? undefined : requests.get(id);
            if (slot)
                slot.sending++;
            try {
                await wire.send(message);
            }
            finally {
                queuedBytes -= bytes;
                if (slot)
                    slot.sending--;
                if (id !== undefined && slot && requests.get(id) === slot)
                    requests.delete(id);
            }
        },
    };
    wire.onmessage = (message) => {
        if (closed)
            return;
        if (isJSONRPCRequest(message)) {
            if (requests.has(message.id) || requests.size >= 8) {
                fail();
                return;
            }
            requests.set(message.id, { cancelled: false, settled: false, sending: 0 });
        }
        if (isJSONRPCNotification(message) && message.method === 'notifications/cancelled') {
            const id = message.params?.requestId;
            if (typeof id === 'number' || typeof id === 'string') {
                const slot = requests.get(id);
                if (slot) {
                    slot.cancelled = true;
                    transport.onmessage?.(message);
                    queueMicrotask(() => releaseCancelled(id, slot));
                    return;
                }
            }
        }
        transport.onmessage?.(message);
    };
    wire.onerror = fail;
    wire.onclose = () => { void close().catch(() => { }); };
    const handle = serveStdio(() => createMcpServer(player, (id) => {
        const slot = requests.get(id);
        return (cancelled) => {
            if (!slot || requests.get(id) !== slot)
                return;
            slot.settled = true;
            slot.cancelled ||= cancelled;
            releaseCancelled(id, slot);
        };
    }), { transport, maxSubscriptions: 16, onerror: () => { report?.(); void close().catch(() => { }); } });
    return handle;
}
let entrypoint = false;
try {
    entrypoint = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
}
catch { }
if (entrypoint) {
    const warningTypes = new Set(['Warning', 'DeprecationWarning', 'ExperimentalWarning', 'MaxListenersExceededWarning', 'TimeoutOverflowWarning', 'TimeoutNegativeWarning', 'TimeoutNaNWarning', 'UnsupportedWarning']);
    process.removeAllListeners('warning');
    process.on('warning', (warning) => {
        const identifiers = [];
        try {
            const code = Object.getOwnPropertyDescriptor(warning, 'code')?.value;
            const type = Object.getOwnPropertyDescriptor(warning, 'name')?.value;
            if (typeof code === 'string' && (/^DEP[0-9]{4}$/.test(code) || code === 'ERR_REQUIRE_ESM' || code === 'ERR_REQUIRE_ASYNC_MODULE'))
                identifiers.push(code);
            if (typeof type === 'string' && warningTypes.has(type))
                identifiers.push(type);
        }
        catch { }
        process.stderr.write(`${COPY.runtimeWarning}${identifiers.length ? ` ${identifiers.join(' ')}` : ''}\n`);
    });
    void runCli().catch(() => { process.stderr.write(`${COPY.unavailable}\n`); process.exitCode = 1; });
}
