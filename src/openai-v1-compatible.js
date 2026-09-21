'use strict';

const { requestChatCompletion, makeError } = require('./lib/chat-request');

module.exports = function (RED) {
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);
    const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool', 'function']);

    function requiredString(value, label) {
        if (typeof value !== 'string' || !value.trim()) {
            throw makeError(`${label} is missing or is not a string`, 'INVALID_CONFIG');
        }
        return value.trim();
    }

    function optionalNumber(value, label, { integer = false, min, max } = {}) {
        if (value === undefined || value === null || value === '') return undefined;
        if (typeof value !== 'string' && typeof value !== 'number') {
            throw makeError(`${label} must be a number`, 'INVALID_CONFIG');
        }
        if (typeof value === 'string' && !value.trim()) return undefined;

        const number = Number(value);
        if (!Number.isFinite(number) || (integer && !Number.isSafeInteger(number))) {
            throw makeError(
                `${label} must be a finite ${integer ? 'integer' : 'number'}`,
                'INVALID_CONFIG',
            );
        }
        if ((min !== undefined && number < min) || (max !== undefined && number > max)) {
            throw makeError(`${label} is outside the allowed range`, 'INVALID_CONFIG');
        }
        return number;
    }

    function normalizeMessages(value, instructions) {
        let messages;

        if (Array.isArray(value)) {
            if (!value.length) throw makeError('Message history is empty', 'INPUT_MISSING');
            messages = value.map((message, index) => {
                if (!message || typeof message !== 'object' || !ROLES.has(message.role)) {
                    throw makeError(
                        `Input message ${index} has an invalid role`,
                        'INVALID_MESSAGES',
                    );
                }

                const hasContent =
                    typeof message.content === 'string' || Array.isArray(message.content);
                const assistantWithoutText =
                    message.role === 'assistant' &&
                    ((Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ||
                        (message.function_call && typeof message.function_call === 'object') ||
                        typeof message.refusal === 'string');

                if (!hasContent && !assistantWithoutText) {
                    throw makeError(
                        `Input message ${index} has no valid content`,
                        'INVALID_MESSAGES',
                    );
                }
                if (
                    message.role === 'tool' &&
                    (typeof message.tool_call_id !== 'string' || !message.tool_call_id.trim())
                ) {
                    throw makeError(
                        `Input message ${index} is missing tool_call_id`,
                        'INVALID_MESSAGES',
                    );
                }

                return { ...message };
            });
        } else {
            if (value === undefined || value === null) {
                throw makeError('LLM input is missing', 'INPUT_MISSING');
            }

            let content;
            if (Buffer.isBuffer(value)) content = value.toString('utf8');
            else if (typeof value === 'string') content = value;
            else if (typeof value === 'object') {
                try {
                    content = JSON.stringify(value);
                } catch {
                    throw makeError('LLM input cannot be JSON-encoded', 'INVALID_INPUT');
                }
            } else if (typeof value === 'number' || typeof value === 'boolean') {
                content = String(value);
            }

            if (typeof content !== 'string' || !content.trim()) {
                throw makeError('LLM input is empty or unsupported', 'INPUT_MISSING');
            }
            messages = [{ role: 'user', content }];
        }

        if (instructions !== undefined && instructions !== null && instructions !== '') {
            if (typeof instructions !== 'string' && !Buffer.isBuffer(instructions)) {
                throw makeError('Instructions must resolve to text', 'INVALID_INSTRUCTIONS');
            }
            const content = String(instructions).trim();
            if (content) messages.unshift({ role: 'system', content });
        }

        return messages;
    }

    function normalizeExtraParameters(value) {
        if (value === undefined || value === null || value === '') return {};

        let parameters = value;
        if (typeof parameters === 'string') {
            if (!parameters.trim()) return {};
            try {
                parameters = JSON.parse(parameters);
            } catch {
                throw makeError(
                    'Extra Parameters must resolve to a JSON object',
                    'INVALID_EXTRA_PARAMETERS',
                );
            }
        }

        if (
            typeof parameters !== 'object' ||
            parameters === null ||
            Array.isArray(parameters) ||
            Buffer.isBuffer(parameters)
        ) {
            throw makeError(
                'Extra Parameters must resolve to an object',
                'INVALID_EXTRA_PARAMETERS',
            );
        }

        return { ...parameters };
    }

    function readOutput(response) {
        const choice = response && Array.isArray(response.choices) && response.choices[0];
        if (!choice || !choice.message || typeof choice.message !== 'object') {
            throw makeError(
                'OpenAI-compatible endpoint returned no completion choices',
                'INVALID_RESPONSE',
            );
        }

        const content = choice.message.content;
        const text =
            typeof content === 'string'
                ? content
                : Array.isArray(content)
                  ? content
                        .filter((part) => part && typeof part.text === 'string')
                        .map((part) => part.text)
                        .join('\n')
                  : '';

        return { choice, text };
    }

    function OpenAIV1CompatibleNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.configNode = RED.nodes.getNode(config.config);
        this.model = config.model;
        this.modelType = config.modelType || 'str';
        this.instructions = config.instructions || '';
        this.instructionsType = config.instructionsType || 'str';
        this.input = config.input === undefined ? 'payload' : config.input;
        this.inputType = config.inputType || 'msg';
        this.extraParameters = config.extraParameters === undefined ? '{}' : config.extraParameters;
        this.extraParametersType = config.extraParametersType || 'json';
        this.output =
            typeof config.output === 'string' && config.output.trim()
                ? config.output.trim()
                : 'payload';
        this.outputType = config.outputType || 'msg';
        this.outputMode = config.outputMode || 'text';
        this.maxCompletionTokens = config.maxCompletionTokens;
        this.temperature = config.temperature;
        this.includeRawResponse = config.includeRawResponse === true;

        const node = this;
        extendNode(node);

        const pending = new Set();
        let closing = false;
        node.status.waiting('waiting for input');

        node.on('close', function () {
            closing = true;
            for (const controller of pending) controller.abort();
            node.status.clear();
        });

        node.on('input', async function (msg, send, done) {
            send = send || node.send.bind(node);
            if (closing) {
                if (done) done();
                return;
            }

            const controller = new AbortController();
            pending.add(controller);
            let outcome;
            let failure;
            let apiKey;

            try {
                if (!node.configNode || typeof node.configNode.getConnection !== 'function') {
                    throw makeError('Missing OpenAI V1 Compatible configuration', 'CONFIG_MISSING');
                }
                if (!['msg', 'flow', 'global'].includes(node.outputType)) {
                    throw makeError('Output must target msg, flow, or global', 'INVALID_CONFIG');
                }
                if (!['text', 'response'].includes(node.outputMode)) {
                    throw makeError('Invalid output mode', 'INVALID_CONFIG');
                }

                if (node.outputType === 'msg') {
                    const path = RED.util.normalisePropertyExpression(node.output);
                    if (path[0] === 'openaiV1') {
                        throw makeError(
                            'msg.openaiV1 is reserved for response metadata',
                            'INVALID_CONFIG',
                        );
                    }
                }

                node.status.processing('calling OpenAI-compatible endpoint');

                const connection = await node.configNode.getConnection();
                apiKey = connection.apiKey;
                if (closing) return;

                const model = requiredString(
                    await node.getTypedProperty(node.model, node.modelType, msg),
                    'Model',
                );
                const input = await node.getTypedProperty(node.input, node.inputType, msg);
                const instructions = node.instructions
                    ? await node.getTypedProperty(node.instructions, node.instructionsType, msg)
                    : undefined;
                const extraParameters = normalizeExtraParameters(
                    await node.getTypedProperty(
                        node.extraParameters,
                        node.extraParametersType,
                        msg,
                    ),
                );
                const messages = normalizeMessages(input, instructions);
                const maxCompletionTokens = optionalNumber(
                    node.maxCompletionTokens,
                    'Max completion tokens',
                    { integer: true, min: 1 },
                );
                const temperature = optionalNumber(node.temperature, 'Temperature', {
                    min: 0,
                    max: 2,
                });

                const requestBody = {
                    ...extraParameters,
                    model,
                    messages,
                    stream: false,
                };
                if (maxCompletionTokens !== undefined) {
                    requestBody.max_completion_tokens = maxCompletionTokens;
                }
                if (temperature !== undefined) requestBody.temperature = temperature;

                if (connection.enableLogging) {
                    node.log(
                        `Calling OpenAI-compatible endpoint (${messages.length} messages, ` +
                            `maxRetries=${connection.maxRetries}, timeoutMs=${connection.timeoutMs})`,
                    );
                }

                const result = await requestChatCompletion({
                    url: connection.url,
                    apiKey,
                    requestBody,
                    maxRetries: connection.maxRetries,
                    timeoutMs: connection.timeoutMs,
                    signal: controller.signal,
                    onRetry: (attempt, waitMs, error) => {
                        if (!closing) {
                            node.status.warning(`retry ${attempt}/${connection.maxRetries}`);
                        }
                        if (connection.enableLogging) {
                            node.log(
                                `OpenAI-compatible retry ${attempt} in ${waitMs} ms ` +
                                    `(${error.statusCode || error.code})`,
                            );
                        }
                    },
                });

                if (closing) return;

                const { response } = result;
                const { choice, text } = readOutput(response);
                if (node.outputMode === 'text' && !text) {
                    throw makeError(
                        'OpenAI-compatible endpoint returned no text. Select Complete response object to inspect tool calls or refusals.',
                        'NO_TEXT_OUTPUT',
                    );
                }

                const outputValue = node.outputMode === 'response' ? response : text;
                await node.setTypedProperty(node.output, node.outputType, msg, outputValue);
                if (closing) return;

                msg.openaiV1 = {
                    id: response.id,
                    requestId: result.requestId || response.request_id,
                    model: response.model || model,
                    created: response.created,
                    finishReason: choice.finish_reason,
                    usage: response.usage,
                    outputText: text,
                    statusCode: result.statusCode,
                    maxRetries: connection.maxRetries,
                    retries: result.retries,
                    timeoutMs: connection.timeoutMs,
                };
                if (node.includeRawResponse) msg.openaiV1.response = response;

                outcome = choice.finish_reason === 'length' ? 'truncated' : 'success';
                send(msg);
            } catch (error) {
                if (!closing) {
                    const message =
                        error && error.message
                            ? String(error.message)
                            : 'OpenAI-compatible request failed';
                    const code = error && error.code ? String(error.code) : 'OPENAI_V1_ERROR';
                    failure = makeError(
                        apiKey ? message.split(apiKey).join('[redacted]') : message,
                        apiKey ? code.split(apiKey).join('[redacted]') : code,
                    );
                    failure.statusCode = error && error.statusCode;
                    const requestId = error && error.requestId;
                    failure.requestId =
                        requestId && apiKey
                            ? String(requestId).split(apiKey).join('[redacted]')
                            : requestId;
                }
            } finally {
                pending.delete(controller);
                if (!closing) {
                    if (pending.size) node.status.processing(`${pending.size} request(s) pending`);
                    else if (failure) {
                        node.status.failed(
                            failure.statusCode ? `HTTP ${failure.statusCode}` : failure.code,
                        );
                    } else if (outcome === 'truncated') {
                        node.status.warning('response truncated (token limit)');
                    } else if (outcome === 'success') {
                        node.status.succeeded('response received', {
                            next: () => node.status.waiting('waiting for input'),
                        });
                    }
                }

                if (done) done(failure);
                else if (failure) node.error(failure, msg);
            }
        });
    }

    RED.nodes.registerType('openai-v1-compatible', OpenAIV1CompatibleNode);
};
