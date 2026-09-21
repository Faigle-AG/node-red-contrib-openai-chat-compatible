'use strict';

const { EventEmitter } = require('node:events');

function pathParts(expression) {
    if (typeof expression !== 'string' || !expression.trim()) throw new Error('Invalid property');
    const normalized = expression
        .replace(/\[(?:"([^"\]]+)"|'([^'\]]+)'|(\d+))\]/g, (_, a, b, c) => `.${a || b || c}`)
        .replace(/^\./, '');
    if (!/^[\w$]+(?:\.[\w$]+)*$/.test(normalized)) throw new Error('Invalid property expression');
    const parts = normalized.split('.');
    if (parts.some((part) => ['__proto__', 'prototype', 'constructor'].includes(part))) {
        throw new Error('Unsafe property');
    }
    return parts;
}

function readPath(object, expression) {
    return pathParts(expression).reduce(
        (value, key) => (value == null ? undefined : value[key]),
        object,
    );
}

function writePath(object, expression, value) {
    const parts = pathParts(expression);
    let target = object;
    for (const part of parts.slice(0, -1)) {
        if (target[part] === undefined) target[part] = {};
        target = target[part];
    }
    target[parts[parts.length - 1]] = value;
}

function createHarness(options = {}) {
    const types = new Map();
    const nodes = new Map();
    const flow = {};
    const globalContext = {};
    const evaluations = [];
    const context = (data) => ({
        get(key) {
            return readPath(data, key);
        },
        set(key, value, callback) {
            if (options.contextError) return callback(new Error('Context write failed'));
            writePath(data, key, value);
            callback();
        },
    });

    const RED = {
        nodes: {
            registerType(name, constructor, settings) {
                types.set(name, { constructor, settings });
            },
            getNode(id) {
                return nodes.get(id);
            },
            createNode(node, config) {
                const events = new EventEmitter();
                node.id = config.id;
                node.on = events.on.bind(events);
                node.emit = events.emit.bind(events);
                node.listeners = events.listeners.bind(events);
                node.context = () => ({ flow: context(flow), global: context(globalContext) });
                node.statuses = [];
                node.logs = [];
                node.errors = [];
                node.sent = [];
                node.status = (value) => node.statuses.push(value);
                node.log = (value) => node.logs.push(value);
                node.warn = (value) => node.logs.push(value);
                node.error = (error, msg) => node.errors.push({ error, msg });
                node.send = (msg) => node.sent.push(msg);
                node.credentials = config._credentials || {};
            },
        },
        util: {
            normalisePropertyExpression: pathParts,
            setMessageProperty: writePath,
            evaluateNodeProperty(value, type, node, msg, callback) {
                evaluations.push({ value, type, node, msg });
                try {
                    let result;
                    switch (type) {
                        case 'str':
                            result = value;
                            break;
                        case 'msg':
                            result = readPath(msg, value);
                            break;
                        case 'env':
                            result = (options.env || {})[value];
                            break;
                        case 'flow':
                            result = readPath(flow, value);
                            break;
                        case 'global':
                            result = readPath(globalContext, value);
                            break;
                        case 'json':
                            result = typeof value === 'string' ? JSON.parse(value) : value;
                            break;
                        case 'jsonata':
                            if (!options.jsonata || !Object.hasOwn(options.jsonata, value)) {
                                throw new Error('No JSONata fixture for this expression');
                            }
                            result = options.jsonata[value];
                            break;
                        default:
                            throw new Error(`Unsupported test input type: ${type}`);
                    }
                    callback(null, result);
                } catch (err) {
                    callback(err);
                }
            },
        },
    };

    require('../src/openai-v1-compatible-config')(RED);
    require('../src/openai-v1-compatible')(RED);

    const create = (type, config) => {
        const node = new (types.get(type).constructor)(config);
        nodes.set(config.id, node);
        return node;
    };

    return {
        RED,
        types,
        nodes,
        flow,
        globalContext,
        evaluations,
        create,
        config(config = {}, credentials = { apiKey: 'test-api-key' }) {
            return create('openai-v1-compatible-config', {
                id: 'connection',
                baseUrl: 'https://llm.example.test/v1',
                baseUrlType: 'str',
                maxRetries: 0,
                timeoutMs: 120000,
                ...config,
                _credentials: credentials,
            });
        },
        ai(config = {}) {
            return create('openai-v1-compatible', {
                id: 'ai',
                config: 'connection',
                model: 'test-model',
                extraParameters: '{}',
                extraParametersType: 'json',
                ...config,
            });
        },
        async input(node, msg, fallback = false) {
            const sent = [];
            const done = [];
            await node.listeners('input')[0](
                msg,
                fallback ? undefined : (value) => sent.push(value),
                fallback ? undefined : (error) => done.push(error),
            );
            return { sent: fallback ? node.sent : sent, done, error: done[0] };
        },
        close() {
            for (const node of nodes.values()) node.emit('close');
        },
    };
}

function completion(content = 'Hello from model', extra = {}) {
    return {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1789999200,
        model: 'test-model',
        choices: [
            {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content },
            },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        ...extra,
    };
}

function jsonResponse(data = completion(), status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'content-type': 'application/json',
            'x-request-id': 'req-test',
            ...headers,
        },
    });
}

async function waitFor(predicate) {
    for (let i = 0; i < 100; i += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('Condition did not become true');
}

module.exports = { createHarness, completion, jsonResponse, waitFor };
