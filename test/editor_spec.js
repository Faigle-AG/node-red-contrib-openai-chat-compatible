'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = ['../src/openai-v1-compatible-config.html', '../src/openai-v1-compatible.html']
    .map((file) => fs.readFileSync(path.join(__dirname, file), 'utf8'))
    .join('\n');

function editor() {
    const types = new Map();
    const inputs = new Map();
    const jquery = (selector) => {
        if (!inputs.has(selector)) {
            inputs.set(selector, {
                value: '',
                visible: true,
                val(value) {
                    if (arguments.length) {
                        this.value = value;
                        return this;
                    }
                    return this.value;
                },
                typedInput(options) {
                    this.options = options;
                    return this;
                },
                toggle(value) {
                    this.visible = value;
                    return this;
                },
                off() {
                    return this;
                },
                on(event, handler) {
                    this.handler = handler;
                    return this;
                },
            });
        }
        return inputs.get(selector);
    };
    const RED = {
        nodes: { registerType: (name, definition) => types.set(name, definition) },
        validators: {
            typedInput: () => (value) => typeof value === 'string' && value.trim().length > 0,
        },
    };

    for (const match of html.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)) {
        vm.runInNewContext(match[1], { RED, $: jquery });
    }
    return { types, inputs, jquery };
}

test('editor registers both nodes and matches templates/help sections', () => {
    const { types } = editor();
    assert.deepEqual([...types.keys()], ['openai-v1-compatible-config', 'openai-v1-compatible']);
    for (const name of types.keys()) {
        assert.ok(html.includes(`data-template-name="${name}"`));
        assert.ok(html.includes(`data-help-name="${name}"`));
    }
    assert.equal(types.get('openai-v1-compatible').category, 'ai processing');
    assert.equal(types.get('openai-v1-compatible').inputs, 1);
    assert.equal(types.get('openai-v1-compatible').outputs, 1);
});

test('editor keeps credentials out of defaults and includes configuration fields', () => {
    const { types } = editor();
    const auth = types.get('openai-v1-compatible-config');
    assert.equal(auth.defaults.apiKey, undefined);
    assert.equal(auth.credentials.apiKey.type, 'password');

    for (const [name, definition] of types) {
        const prefix = name.endsWith('-config') ? 'node-config-input-' : 'node-input-';
        for (const key of Object.keys(definition.defaults)) {
            assert.ok(html.includes(`id="${prefix}${key}"`), key);
        }
    }
});

test('editor configures connection and processing typed inputs', () => {
    const { types, inputs } = editor();
    types.get('openai-v1-compatible-config').oneditprepare.call({});
    types.get('openai-v1-compatible').oneditprepare.call({
        output: 'payload',
        outputType: 'msg',
        extraParameters: '{}',
        extraParametersType: 'json',
    });

    assert.ok(inputs.get('#node-config-input-baseUrl').options);
    assert.deepEqual(Array.from(inputs.get('#node-config-input-baseUrl').options.types), [
        'str',
        'env',
    ]);

    for (const field of ['model', 'instructions', 'input', 'extraParameters', 'output']) {
        assert.ok(inputs.get(`#node-input-${field}`).options, field);
    }
    assert.deepEqual(Array.from(inputs.get('#node-input-output').options.types), [
        'msg',
        'flow',
        'global',
    ]);
    assert.deepEqual(Array.from(inputs.get('#node-input-extraParameters').options.types), [
        'json',
        'msg',
        'flow',
        'global',
        'jsonata',
    ]);
});

test('editor validates request and connection numeric boundaries', () => {
    const { types } = editor();
    const requestDefaults = types.get('openai-v1-compatible').defaults;
    const connectionDefaults = types.get('openai-v1-compatible-config').defaults;
    assert.equal(requestDefaults.temperature.validate('0'), true);
    assert.equal(requestDefaults.temperature.validate('3'), false);
    assert.equal(requestDefaults.maxCompletionTokens.validate('1.5'), false);
    assert.equal(requestDefaults.maxCompletionTokens.validate(''), true);
    assert.equal(connectionDefaults.maxRetries.validate('11'), false);
    assert.equal(connectionDefaults.timeoutMs.validate('2147483648'), false);
});

test('editor switches between stored, environment and no authentication', () => {
    const { types, jquery } = editor();
    const selector = jquery('#node-config-input-apiKeySource');

    selector.val('credentials');
    types.get('openai-v1-compatible-config').oneditprepare();
    assert.equal(jquery('#openai-v1-api-key-credentials-row').visible, true);
    assert.equal(jquery('#openai-v1-api-key-env-row').visible, false);

    selector.val('env');
    selector.handler();
    assert.equal(jquery('#openai-v1-api-key-credentials-row').visible, false);
    assert.equal(jquery('#openai-v1-api-key-env-row').visible, true);

    selector.val('none');
    selector.handler();
    assert.equal(jquery('#openai-v1-api-key-credentials-row').visible, false);
    assert.equal(jquery('#openai-v1-api-key-env-row').visible, false);
});
