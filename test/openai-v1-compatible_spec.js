'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, completion, jsonResponse, waitFor } = require('./harness');

function setup(
    t,
    config = {},
    options = {},
    connectionConfig = {},
    credentials = { apiKey: 'test-api-key' },
) {
    const h = createHarness(options);
    h.config(connectionConfig, credentials);
    const node = h.ai(config);
    t.after(() => h.close());
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, request) => {
        calls.push({ url, request, body: JSON.parse(request.body) });
        return jsonResponse();
    });
    return { h, node, calls };
}

test('registers the processing node and connection configuration', () => {
    const h = createHarness();
    assert.deepEqual([...h.types.keys()], ['openai-v1-compatible-config', 'openai-v1-compatible']);
    assert.deepEqual(h.types.get('openai-v1-compatible-config').settings.credentials, {
        apiKey: { type: 'password' },
    });
});

test('posts an OpenAI V1 chat completion request and preserves the incoming message', async (t) => {
    const { h, node, calls } = setup(t, {
        instructions: 'Answer briefly.',
        maxCompletionTokens: '256',
        temperature: '0',
    });
    const msg = { payload: 'Hello', topic: 'keep', _msgid: 'message-1' };
    const result = await h.input(node, msg);

    assert.equal(result.error, undefined);
    assert.equal(result.done.length, 1);
    assert.equal(result.sent[0], msg);
    assert.equal(msg.topic, 'keep');
    assert.equal(msg._msgid, 'message-1');
    assert.equal(msg.payload, 'Hello from model');
    assert.equal(calls[0].url, 'https://llm.example.test/v1/chat/completions');
    assert.equal(calls[0].request.headers.Authorization, 'Bearer test-api-key');
    assert.equal(calls[0].request.redirect, 'error');
    assert.deepEqual(calls[0].body, {
        model: 'test-model',
        messages: [
            { role: 'system', content: 'Answer briefly.' },
            { role: 'user', content: 'Hello' },
        ],
        stream: false,
        max_completion_tokens: 256,
        temperature: 0,
    });
    assert.equal(msg.openaiV1.requestId, 'req-test');
    assert.equal(msg.openaiV1.finishReason, 'stop');
    assert.deepEqual(msg.openaiV1.usage, completion().usage);
    assert.equal(msg.openaiV1.response, undefined);
    assert.equal(node.statuses.at(-1).text, 'response received');
});

test('accepts a full chat completions URL without duplicating the path', async (t) => {
    const { h, node, calls } = setup(
        t,
        {},
        {},
        { baseUrl: 'https://gateway.example/openai/v1/chat/completions/' },
    );
    await h.input(node, { payload: 'Hello' });
    assert.equal(calls[0].url, 'https://gateway.example/openai/v1/chat/completions');
});

test('supports an unauthenticated local HTTP endpoint', async (t) => {
    const { h, node, calls } = setup(
        t,
        {},
        {},
        { baseUrl: 'http://127.0.0.1:8080/v1/', apiKeySource: 'none' },
        {},
    );
    await h.input(node, { payload: 'Hello' });
    assert.equal(calls[0].url, 'http://127.0.0.1:8080/v1/chat/completions');
    assert.equal(Object.hasOwn(calls[0].request.headers, 'Authorization'), false);
});

test('merges extra parameters while core fields remain controlled by the node', async (t) => {
    const { h, node, calls } = setup(t, {
        extraParameters: 'extras',
        extraParametersType: 'msg',
        maxCompletionTokens: 321,
        temperature: 0.4,
    });
    const msg = {
        payload: 'Hello',
        extras: {
            top_p: 0.8,
            response_format: { type: 'json_object' },
            max_tokens: 99,
            max_completion_tokens: 1,
            temperature: 1.9,
            model: 'wrong-model',
            messages: [{ role: 'user', content: 'wrong prompt' }],
            stream: true,
        },
    };
    await h.input(node, msg);
    assert.equal(calls[0].body.top_p, 0.8);
    assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
    assert.equal(calls[0].body.max_tokens, 99);
    assert.equal(calls[0].body.max_completion_tokens, 321);
    assert.equal(calls[0].body.temperature, 0.4);
    assert.equal(calls[0].body.model, 'test-model');
    assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: 'Hello' }]);
    assert.equal(calls[0].body.stream, false);
});

test('omits unset optional parameters and applies retry/timeout defaults', async (t) => {
    const { h, node, calls } = setup(t, {}, {}, { maxRetries: undefined });
    const msg = { payload: 'Hello' };
    await h.input(node, msg);
    assert.equal(Object.hasOwn(calls[0].body, 'max_completion_tokens'), false);
    assert.equal(Object.hasOwn(calls[0].body, 'temperature'), false);
    assert.equal(msg.openaiV1.maxRetries, 4);
    assert.equal(msg.openaiV1.timeoutMs, 120000);
});

test('blank numeric options use defaults and blank output falls back to payload', async (t) => {
    const { h, node, calls } = setup(
        t,
        {
            temperature: '',
            maxCompletionTokens: '',
            output: '',
        },
        {},
        { maxRetries: '', timeoutMs: '' },
    );
    const msg = { payload: 'Hello' };
    assert.equal((await h.input(node, msg)).error, undefined);
    assert.equal(msg.payload, 'Hello from model');
    assert.equal(msg.openaiV1.maxRetries, 4);
    assert.equal(msg.openaiV1.timeoutMs, 120000);
    assert.equal(Object.hasOwn(calls[0].body, 'temperature'), false);
});

for (const [name, input, expected] of [
    ['Buffer', Buffer.from('Grüezi'), 'Grüezi'],
    ['object', { invoice: 42, customer: 'Acme' }, '{"invoice":42,"customer":"Acme"}'],
    ['number zero', 0, '0'],
    ['boolean false', false, 'false'],
]) {
    test(`normalizes ${name} input to user text`, async (t) => {
        const { h, node, calls } = setup(t);
        assert.equal((await h.input(node, { payload: input })).error, undefined);
        assert.equal(calls[0].body.messages[0].content, expected);
    });
}

test('preserves message history and tool-call fields without mutating input', async (t) => {
    const { h, node, calls } = setup(t, { instructions: 'Be brief.', output: 'answer' });
    const history = [
        {
            role: 'user',
            content: [
                { type: 'text', text: 'Explain this.' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
            ],
        },
        {
            role: 'assistant',
            content: null,
            tool_calls: [
                {
                    id: 'tool-1',
                    type: 'function',
                    function: { name: 'lookup', arguments: '{}' },
                },
            ],
        },
        { role: 'tool', tool_call_id: 'tool-1', content: 'found' },
        { role: 'user', content: 'Summarize.' },
    ];
    const original = structuredClone(history);
    const msg = { payload: history };
    const result = await h.input(node, msg);
    assert.equal(result.error, undefined);
    assert.deepEqual(history, original);
    assert.equal(msg.payload, history);
    assert.deepEqual(calls[0].body.messages.slice(1), original);
});

test('resolves connection base URL plus typed model, input, instructions and extra parameters', async (t) => {
    const { h, node, calls } = setup(
        t,
        {
            model: 'MODEL_ID',
            modelType: 'env',
            instructions: 'systemPrompt',
            instructionsType: 'flow',
            input: '$string(payload)',
            inputType: 'jsonata',
            extraParameters: 'requestExtras',
            extraParametersType: 'global',
            output: 'answers.first',
        },
        {
            env: { MODEL_ID: 'env-model', ENDPOINT_URL: 'https://dynamic.example/v1' },
            jsonata: { '$string(payload)': 'evaluated prompt' },
        },
        { baseUrl: 'ENDPOINT_URL', baseUrlType: 'env' },
    );
    h.flow.systemPrompt = 'Use a sentence.';
    h.globalContext.requestExtras = { top_p: 0.75 };
    const msg = { payload: 123 };
    const result = await h.input(node, msg);
    assert.equal(result.error, undefined);
    assert.equal(calls[0].url, 'https://dynamic.example/v1/chat/completions');
    assert.equal(calls[0].body.model, 'env-model');
    assert.equal(calls[0].body.top_p, 0.75);
    assert.deepEqual(calls[0].body.messages, [
        { role: 'system', content: 'Use a sentence.' },
        { role: 'user', content: 'evaluated prompt' },
    ]);
    assert.equal(msg.answers.first, 'Hello from model');
    assert.equal(msg.payload, 123);
    assert.ok(h.evaluations.some((call) => call.type === 'jsonata' && call.msg === msg));
});

for (const scope of ['flow', 'global']) {
    test(`writes to ${scope} context and still forwards the message`, async (t) => {
        const { h, node } = setup(t, { output: 'answer', outputType: scope });
        const msg = { payload: 'keep prompt' };
        const result = await h.input(node, msg);
        assert.equal(result.error, undefined);
        assert.equal(msg.payload, 'keep prompt');
        assert.equal((scope === 'flow' ? h.flow : h.globalContext).answer, 'Hello from model');
        assert.equal(result.sent[0], msg);
    });
}

test('returns the complete response and optionally includes a raw-response reference', async (t) => {
    const { h, node } = setup(t, { outputMode: 'response', includeRawResponse: true });
    const msg = { payload: 'Hello' };
    await h.input(node, msg);
    assert.deepEqual(msg.payload, completion());
    assert.equal(msg.openaiV1.response, msg.payload);
});

test('response mode accepts a tool-call-only completion', async (t) => {
    const { h, node } = setup(t, { outputMode: 'response' });
    t.mock.method(globalThis, 'fetch', async () =>
        jsonResponse(
            completion(null, {
                choices: [
                    {
                        finish_reason: 'tool_calls',
                        message: {
                            role: 'assistant',
                            content: null,
                            tool_calls: [{ id: 'call-1' }],
                        },
                    },
                ],
            }),
        ),
    );
    const msg = { payload: 'Hello' };
    assert.equal((await h.input(node, msg)).error, undefined);
    assert.equal(msg.payload.choices[0].message.tool_calls[0].id, 'call-1');
});

test('text mode reports an empty response without sending a message', async (t) => {
    const { h, node } = setup(t);
    t.mock.method(globalThis, 'fetch', async () => jsonResponse(completion(null)));
    const result = await h.input(node, { payload: 'Hello' });
    assert.equal(result.error.code, 'NO_TEXT_OUTPUT');
    assert.equal(result.done.length, 1);
    assert.equal(result.sent.length, 0);
});

test('reads text parts while ignoring non-text content parts', async (t) => {
    const { h, node } = setup(t);
    t.mock.method(globalThis, 'fetch', async () =>
        jsonResponse(
            completion([
                { type: 'text', text: 'one' },
                { type: 'other' },
                { type: 'text', text: 'two' },
            ]),
        ),
    );
    const msg = { payload: 'Hello' };
    await h.input(node, msg);
    assert.equal(msg.payload, 'one\ntwo');
});

test('forwards partial output and shows a token-limit warning', async (t) => {
    const { h, node } = setup(t);
    const data = completion('Partial');
    data.choices[0].finish_reason = 'length';
    t.mock.method(globalThis, 'fetch', async () => jsonResponse(data));
    const msg = { payload: 'Hello' };
    assert.equal((await h.input(node, msg)).error, undefined);
    assert.equal(msg.payload, 'Partial');
    assert.equal(node.statuses.at(-1).fill, 'yellow');
    assert.equal(msg.openaiV1.finishReason, 'length');
});

for (const [name, config, msg] of [
    ['missing config', { config: 'missing' }, { payload: 'Hello' }],
    ['empty model', { model: '' }, { payload: 'Hello' }],
    ['missing input', {}, {}],
    ['null input', {}, { payload: null }],
    ['empty input', {}, { payload: '  ' }],
    ['empty history', {}, { payload: [] }],
    ['invalid history role', {}, { payload: [{ role: 'bogus', content: 'x' }] }],
    ['history without content', {}, { payload: [{ role: 'user' }] }],
    ['tool response without ID', {}, { payload: [{ role: 'tool', content: 'x' }] }],
    ['invalid temperature', { temperature: 3 }, { payload: 'Hello' }],
    ['non-finite temperature', { temperature: Infinity }, { payload: 'Hello' }],
    ['boolean temperature', { temperature: false }, { payload: 'Hello' }],
    ['fractional token count', { maxCompletionTokens: 1.5 }, { payload: 'Hello' }],
    ['zero token count', { maxCompletionTokens: 0 }, { payload: 'Hello' }],
    ['invalid output type', { outputType: 'env' }, { payload: 'Hello' }],
    ['invalid output mode', { outputMode: 'stream' }, { payload: 'Hello' }],
    ['reserved output root', { output: 'openaiV1' }, { payload: 'Hello' }],
    ['reserved output child', { output: 'openaiV1.answer' }, { payload: 'Hello' }],
    ['reserved bracket root', { output: '["openaiV1"].answer' }, { payload: 'Hello' }],
    ['invalid output syntax', { output: 'answer[' }, { payload: 'Hello' }],
    [
        'object instructions',
        { instructions: 'instructions', instructionsType: 'msg' },
        { payload: 'Hello', instructions: {} },
    ],
    [
        'array extra parameters',
        { extraParameters: 'extras', extraParametersType: 'msg' },
        { payload: 'Hello', extras: [] },
    ],
    [
        'invalid JSON string extra parameters',
        { extraParameters: 'extras', extraParametersType: 'msg' },
        { payload: 'Hello', extras: '{bad' },
    ],
]) {
    test(`rejects ${name} before an HTTP request`, async (t) => {
        const { h, node, calls } = setup(t, config);
        const result = await h.input(node, msg);
        assert.ok(result.error instanceof Error);
        assert.equal(result.sent.length, 0);
        assert.equal(result.done.length, 1);
        assert.equal(calls.length, 0);
    });
}

for (const [name, connectionConfig] of [
    ['invalid base URL', { baseUrl: 'not a URL' }],
    ['unsupported base protocol', { baseUrl: 'ftp://example.test/v1' }],
    ['base URL credentials', { baseUrl: 'https://secret@example.test/v1' }],
    ['base URL query', { baseUrl: 'https://example.test/v1?key=value' }],
    ['unsupported base URL type', { baseUrlType: 'msg' }],
    ['negative retries', { maxRetries: -1 }],
    ['too many retries', { maxRetries: 11 }],
    ['short timeout', { timeoutMs: 999 }],
    ['overflowing timeout', { timeoutMs: 2147483648 }],
]) {
    test(`rejects connection ${name} before an HTTP request`, async (t) => {
        const { h, node, calls } = setup(t, {}, {}, connectionConfig);
        const result = await h.input(node, { payload: 'Hello' });
        assert.ok(result.error instanceof Error);
        assert.equal(result.sent.length, 0);
        assert.equal(result.done.length, 1);
        assert.equal(calls.length, 0);
    });
}

test('rejects circular object input without sending a request', async (t) => {
    const { h, node, calls } = setup(t);
    const data = {};
    data.self = data;
    const result = await h.input(node, { payload: data });
    assert.equal(result.error.code, 'INVALID_INPUT');
    assert.equal(calls.length, 0);
});

test('reports context write failures rather than sending incomplete output', async (t) => {
    const { h, node } = setup(t, { outputType: 'flow' }, { contextError: true });
    const result = await h.input(node, { payload: 'Hello' });
    assert.match(result.error.message, /Context write failed/);
    assert.equal(result.sent.length, 0);
});

test('supports older send/error callbacks', async (t) => {
    const { h, node } = setup(t);
    const result = await h.input(node, { payload: 'Hello' }, true);
    assert.equal(result.sent.length, 1);
    await h.input(node, {}, true);
    assert.equal(node.errors.length, 1);
});

for (const [name, config, credentials, options, expected] of [
    ['stored', {}, { apiKey: '  secret-key  ' }, {}, 'secret-key'],
    [
        'environment',
        { apiKeySource: 'env', apiKeyEnv: 'MY_API_KEY' },
        {},
        { env: { MY_API_KEY: 'from-env' } },
        'from-env',
    ],
    ['none', { apiKeySource: 'none' }, {}, {}, undefined],
]) {
    test(`reads ${name} authentication`, async () => {
        const h = createHarness(options);
        const auth = h.config(config, credentials);
        assert.equal(await auth.getApiKey(), expected);
    });
}

test('connection config resolves an environment base URL and runtime settings', async () => {
    const h = createHarness({ env: { OPENAI_BASE_URL: 'https://env.example/v1' } });
    const connection = h.config(
        {
            baseUrl: 'OPENAI_BASE_URL',
            baseUrlType: 'env',
            apiKeySource: 'none',
            maxRetries: 3,
            timeoutMs: 45000,
            enableLogging: true,
        },
        {},
    );
    assert.deepEqual(await connection.getConnection(), {
        url: 'https://env.example/v1/chat/completions',
        apiKey: undefined,
        maxRetries: 3,
        timeoutMs: 45000,
        enableLogging: true,
    });
});

for (const [name, config, credentials] of [
    ['missing key', {}, {}],
    ['Bearer prefix', {}, { apiKey: 'Bearer secret' }],
    ['header injection', {}, { apiKey: 'secret\r\nBad:value' }],
    ['missing environment', { apiKeySource: 'env' }, {}],
    ['unsupported source', { apiKeySource: 'msg' }, {}],
]) {
    test(`rejects ${name} authentication`, async () => {
        const h = createHarness();
        const auth = h.config(config, credentials);
        await assert.rejects(auth.getApiKey());
    });
}

test('re-reads an environment API key for every request', async (t) => {
    const env = { API_KEY: 'first-key' };
    const { h, node, calls } = setup(
        t,
        {},
        { env },
        { apiKeySource: 'env', apiKeyEnv: 'API_KEY' },
        {},
    );
    await h.input(node, { payload: 'Hello' });
    env.API_KEY = 'second-key';
    await h.input(node, { payload: 'Hello' });
    assert.equal(calls[0].request.headers.Authorization, 'Bearer first-key');
    assert.equal(calls[1].request.headers.Authorization, 'Bearer second-key');
});

test('request logging excludes key, prompt, model and endpoint', async (t) => {
    const { h, node } = setup(
        t,
        { instructions: 'private instructions' },
        {},
        { enableLogging: true, baseUrl: 'https://private.example/v1' },
    );
    await h.input(node, { payload: 'private prompt' });
    const logs = node.logs.join('\n');
    assert.match(logs, /Calling OpenAI-compatible endpoint/);
    for (const secret of [
        'test-api-key',
        'private instructions',
        'private prompt',
        'test-model',
        'private.example',
    ]) {
        assert.equal(logs.includes(secret), false);
    }
});

test('aborts in-flight work on close and emits no output or error', async (t) => {
    const { h, node } = setup(t);
    let requestSignal;
    t.mock.method(globalThis, 'fetch', async (url, request) => {
        requestSignal = request.signal;
        return new Promise((resolve, reject) =>
            request.signal.addEventListener('abort', () =>
                reject(new DOMException('Aborted', 'AbortError')),
            ),
        );
    });
    const pending = h.input(node, { payload: 'Hello' });
    await waitFor(() => requestSignal);
    node.emit('close');
    const result = await pending;
    assert.equal(requestSignal.aborted, true);
    assert.equal(result.error, undefined);
    assert.equal(result.done.length, 1);
    assert.equal(result.sent.length, 0);
    assert.deepEqual(node.statuses.at(-1), {});
});

test('close cancels a long Retry-After delay', async (t) => {
    const { h, node } = setup(t, {}, {}, { maxRetries: 4 });
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls += 1;
        return jsonResponse({ error: { message: 'Busy' } }, 429, { 'retry-after': '3600' });
    });
    const pending = h.input(node, { payload: 'Hello' });
    await waitFor(() => node.statuses.some((status) => status.text === 'retry 1/4'));
    node.emit('close');
    const result = await pending;
    assert.equal(calls, 1);
    assert.equal(result.sent.length, 0);
    assert.equal(result.done.length, 1);
    assert.equal(result.error, undefined);
});

test('tracks concurrent requests independently', async (t) => {
    const { h, node } = setup(t);
    const resolveRequests = [];
    t.mock.method(
        globalThis,
        'fetch',
        () => new Promise((resolve) => resolveRequests.push(resolve)),
    );
    const first = h.input(node, { payload: 'first' });
    const second = h.input(node, { payload: 'second' });
    await waitFor(() => resolveRequests.length === 2);
    resolveRequests[0](jsonResponse(completion('one')));
    assert.equal((await first).sent[0].payload, 'one');
    assert.equal(node.statuses.at(-1).text, '1 request(s) pending');
    resolveRequests[1](jsonResponse(completion('two')));
    assert.equal((await second).sent[0].payload, 'two');
    assert.equal(node.statuses.at(-1).text, 'response received');
});
