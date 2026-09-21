'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requestChatCompletion, retryAfterMs, MAX_TIMER_MS } = require('../src/lib/chat-request');
const { jsonResponse, completion } = require('./harness');

function request(options = {}) {
    return requestChatCompletion({
        url: 'https://llm.example.test/v1/chat/completions',
        apiKey: 'secret-token',
        requestBody: {
            model: 'test-model',
            messages: [{ role: 'user', content: 'Hello' }],
            stream: false,
        },
        timeoutMs: 1000,
        maxRetries: 0,
        signal: new AbortController().signal,
        ...options,
    });
}

for (const status of [408, 409, 429, 500, 502, 503]) {
    test(`retries HTTP ${status}, honors a zero Retry-After and preserves the request body`, async (t) => {
        const bodies = [];
        const retries = [];
        t.mock.method(globalThis, 'fetch', async (url, options) => {
            bodies.push(options.body);
            return bodies.length === 1
                ? jsonResponse({ error: { message: 'Temporary failure' } }, status, {
                      'retry-after': '0',
                  })
                : jsonResponse();
        });
        const result = await request({ maxRetries: 1, onRetry: (...args) => retries.push(args) });
        assert.equal(result.retries, 1);
        assert.equal(result.response.id, 'chatcmpl-test');
        assert.equal(bodies.length, 2);
        assert.equal(bodies[0], bodies[1]);
        assert.equal(retries[0][1], 0);
    });
}

for (const status of [400, 401, 403, 404, 422]) {
    test(`does not retry HTTP ${status}`, async (t) => {
        let calls = 0;
        t.mock.method(globalThis, 'fetch', async () => {
            calls += 1;
            return jsonResponse({ error: { message: 'Rejected', code: 'provider_code' } }, status);
        });
        await assert.rejects(request({ maxRetries: 4 }), (error) => {
            assert.equal(error.statusCode, status);
            assert.equal(error.code, 'provider_code');
            assert.equal(error.requestId, 'req-test');
            return true;
        });
        assert.equal(calls, 1);
    });
}

test('bounds retries to one initial request plus maxRetries', async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls += 1;
        return jsonResponse({ error: { message: 'Busy' } }, 429, { 'retry-after': '0' });
    });
    await assert.rejects(request({ maxRetries: 2 }), { statusCode: 429 });
    assert.equal(calls, 3);
});

test('extracts structured provider errors and redacts token echoes', async (t) => {
    t.mock.method(globalThis, 'fetch', async () =>
        jsonResponse(
            {
                result: 'error',
                errors: [
                    { code: 'bad_secret-token', description: 'Invalid secret-token' },
                    { description: 'Second error' },
                ],
            },
            422,
            { 'x-request-id': 'request-secret-token' },
        ),
    );
    await assert.rejects(request(), (error) => {
        assert.equal(error.message.includes('secret-token'), false);
        assert.equal(error.code.includes('secret-token'), false);
        assert.equal(error.requestId.includes('secret-token'), false);
        assert.match(error.message, /Second error/);
        assert.equal(Object.hasOwn(error, 'cause'), false);
        return true;
    });
});

test('keeps HTML error bodies out of error messages', async (t) => {
    t.mock.method(
        globalThis,
        'fetch',
        async () => new Response('<html>private contents</html>', { status: 502 }),
    );
    await assert.rejects(request(), (error) => {
        assert.equal(error.statusCode, 502);
        assert.equal(error.message.includes('private contents'), false);
        return true;
    });
});

test('rejects malformed successful JSON without retrying', async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls += 1;
        return new Response('not JSON');
    });
    await assert.rejects(request({ maxRetries: 4 }), { code: 'INVALID_RESPONSE' });
    assert.equal(calls, 1);
});

test('does not silently accept service errors wrapped in HTTP 200', async (t) => {
    t.mock.method(globalThis, 'fetch', async () =>
        jsonResponse({ result: 'error', errors: [{ description: 'Rejected' }] }),
    );
    await assert.rejects(request(), /Rejected/);
});

test('normalizes network errors without copying headers or raw exceptions', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => {
        throw new TypeError('Error with secret-token and private prompt');
    });
    await assert.rejects(request(), (error) => {
        assert.equal(error.code, 'NETWORK_ERROR');
        assert.equal(error.message.includes('secret-token'), false);
        assert.equal(error.message.includes('private prompt'), false);
        return true;
    });
});

test('uses jittered exponential backoff when no Retry-After is supplied', async (t) => {
    let calls = 0;
    const delays = [];
    t.mock.method(Math, 'random', () => 0);
    t.mock.method(globalThis, 'fetch', async () => {
        calls += 1;
        if (calls < 3) throw new TypeError('Network down');
        return jsonResponse();
    });
    const result = await request({ maxRetries: 2, onRetry: (attempt, ms) => delays.push(ms) });
    assert.deepEqual(delays, [375, 750]);
    assert.equal(result.retries, 2);
});

test('enforces timeouts on connection setup and aborts the attempt', async (t) => {
    let signal;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        signal = options.signal;
        return new Promise((resolve, reject) =>
            signal.addEventListener('abort', () =>
                reject(new DOMException('Aborted', 'AbortError')),
            ),
        );
    });
    await assert.rejects(request({ timeoutMs: 15 }), { code: 'ETIMEDOUT' });
    assert.equal(signal.aborted, true);
});

test('keeps the timeout active while reading the response body', async (t) => {
    t.mock.method(globalThis, 'fetch', async (url, { signal }) => ({
        status: 200,
        ok: true,
        headers: new Headers(),
        text: () =>
            new Promise((resolve, reject) =>
                signal.addEventListener('abort', () =>
                    reject(new DOMException('Aborted', 'AbortError')),
                ),
            ),
    }));
    await assert.rejects(request({ timeoutMs: 15 }), { code: 'ETIMEDOUT' });
});

test('retries a timeout when explicitly enabled', async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
        calls += 1;
        if (calls === 2) return jsonResponse();
        return new Promise((resolve, reject) =>
            signal.addEventListener('abort', () =>
                reject(new DOMException('Aborted', 'AbortError')),
            ),
        );
    });
    const result = await request({ timeoutMs: 15, maxRetries: 1 });
    assert.equal(result.retries, 1);
    assert.equal(calls, 2);
});

test('honors cancellation before any fetch', async (t) => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => jsonResponse());
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(request({ signal: controller.signal }), { code: 'REQUEST_CANCELLED' });
    assert.equal(fetch.mock.callCount(), 0);
});

test('rejects an overflowing Retry-After rather than retrying immediately', async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls += 1;
        return jsonResponse({ error: 'busy' }, 429, {
            'retry-after': String(MAX_TIMER_MS / 1000 + 10),
        });
    });
    await assert.rejects(request({ maxRetries: 1 }), /Retry-After is too long/);
    assert.equal(calls, 1);
});

test('parses Retry-After delta-seconds, fractional seconds and HTTP dates', () => {
    const now = Date.parse('2026-09-21T12:00:00Z');
    assert.equal(retryAfterMs('2', now), 2000);
    assert.equal(retryAfterMs('0.1', now), 100);
    assert.equal(retryAfterMs('0', now), 0);
    assert.equal(retryAfterMs('Mon, 21 Sep 2026 12:00:03 GMT', now), 3000);
    assert.equal(retryAfterMs('invalid', now), undefined);
    assert.equal(retryAfterMs('-1', now), undefined);
    assert.equal(retryAfterMs('', now), undefined);
    assert.equal(retryAfterMs(null, now), undefined);
});

test('omits Authorization when no API key is configured', async (t) => {
    let headers;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        headers = options.headers;
        return jsonResponse();
    });
    await request({ apiKey: undefined });
    assert.equal(Object.hasOwn(headers, 'Authorization'), false);
});

test('honors retry-after-ms before Retry-After', async (t) => {
    let calls = 0;
    const waits = [];
    t.mock.method(globalThis, 'fetch', async () => {
        calls += 1;
        return calls === 1
            ? jsonResponse({ error: { message: 'Busy' } }, 429, {
                  'retry-after-ms': '0',
                  'retry-after': '10',
              })
            : jsonResponse();
    });
    const result = await request({ maxRetries: 1, onRetry: (attempt, ms) => waits.push(ms) });
    assert.equal(result.retries, 1);
    assert.deepEqual(waits, [0]);
});

test('successful helper results retain response metadata', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => jsonResponse());
    assert.deepEqual(await request(), {
        response: completion(),
        requestId: 'req-test',
        statusCode: 200,
        retries: 0,
    });
});
