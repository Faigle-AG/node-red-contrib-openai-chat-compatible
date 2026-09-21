'use strict';

const { makeError, MAX_TIMER_MS } = require('./lib/chat-request');

module.exports = function (RED) {
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

    function normalizeChatUrl(value) {
        const base = requiredString(value, 'Base URL');
        let url;
        try {
            url = new URL(base);
        } catch {
            throw makeError('Base URL must be a valid HTTP or HTTPS URL', 'INVALID_BASE_URL');
        }

        if (!['http:', 'https:'].includes(url.protocol)) {
            throw makeError('Base URL must use HTTP or HTTPS', 'INVALID_BASE_URL');
        }
        if (url.username || url.password) {
            throw makeError('Base URL must not contain embedded credentials', 'INVALID_BASE_URL');
        }
        if (url.search || url.hash) {
            throw makeError(
                'Base URL must not contain a query string or fragment',
                'INVALID_BASE_URL',
            );
        }

        url.pathname = url.pathname.replace(/\/+$/, '');
        if (!url.pathname.endsWith('/chat/completions')) {
            url.pathname += '/chat/completions';
        }
        return url.toString();
    }

    function evaluateEnvironment(node, variableName, label) {
        const variable = requiredString(variableName, label);
        return new Promise((resolve, reject) => {
            RED.util.evaluateNodeProperty(variable, 'env', node, {}, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
    }

    function OpenAIV1CompatibleConfigNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
        this.baseUrlType = config.baseUrlType || 'str';
        this.apiKeySource = config.apiKeySource || 'credentials';
        this.apiKeyEnv = config.apiKeyEnv || 'OPENAI_API_KEY';
        this.maxRetries = config.maxRetries;
        this.timeoutMs = config.timeoutMs;
        this.enableLogging = config.enableLogging === true;

        this.getApiKey = async () => {
            if (this.apiKeySource === 'none') return undefined;

            let value;
            if (this.apiKeySource === 'credentials') {
                value = this.credentials && this.credentials.apiKey;
            } else if (this.apiKeySource === 'env') {
                value = await evaluateEnvironment(
                    this,
                    this.apiKeyEnv,
                    'API key environment variable',
                );
            } else {
                throw makeError('Unsupported API key source', 'INVALID_CONFIG');
            }

            const apiKey = requiredString(value, 'API key');
            if (/\s/.test(apiKey)) {
                throw makeError(
                    'Enter the API key without a Bearer prefix or whitespace',
                    'INVALID_CONFIG',
                );
            }
            return apiKey;
        };

        this.getConnection = async () => {
            let baseUrlValue;
            if (this.baseUrlType === 'str') {
                baseUrlValue = this.baseUrl;
            } else if (this.baseUrlType === 'env') {
                baseUrlValue = await evaluateEnvironment(
                    this,
                    this.baseUrl,
                    'Base URL environment variable',
                );
            } else {
                throw makeError('Base URL must use string or environment input', 'INVALID_CONFIG');
            }

            return {
                url: normalizeChatUrl(baseUrlValue),
                apiKey: await this.getApiKey(),
                maxRetries:
                    optionalNumber(this.maxRetries, 'Max retries', {
                        integer: true,
                        min: 0,
                        max: 10,
                    }) ?? 4,
                timeoutMs:
                    optionalNumber(this.timeoutMs, 'Timeout', {
                        integer: true,
                        min: 1000,
                        max: MAX_TIMER_MS,
                    }) ?? 120000,
                enableLogging: this.enableLogging,
            };
        };
    }

    RED.nodes.registerType('openai-v1-compatible-config', OpenAIV1CompatibleConfigNode, {
        credentials: { apiKey: { type: 'password' } },
    });
};
