'use strict';

const { setTimeout: delay } = require('node:timers/promises');

const MAX_TIMER_MS = 2_147_483_647;
const RETRYABLE_STATUS = new Set([408, 409, 429]);

function makeError(message, code, extra = {}) {
    return Object.assign(new Error(message), { name: 'OpenAIV1CompatibleError', code }, extra);
}

function redact(value, apiKey) {
    const text = String(value);
    return apiKey ? text.split(apiKey).join('[redacted]') : text;
}

function retryAfterMs(value, now = Date.now()) {
    if (!value || !String(value).trim()) return undefined;
    const text = String(value).trim();
    const seconds = Number(text);
    const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(text) - now;
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
    return Math.ceil(milliseconds);
}

function responseRetryAfterMs(response) {
    const retryAfterMilliseconds = response.headers.get('retry-after-ms');
    if (retryAfterMilliseconds !== null && String(retryAfterMilliseconds).trim() !== '') {
        const milliseconds = Number(retryAfterMilliseconds);
        if (Number.isFinite(milliseconds) && milliseconds >= 0) return Math.ceil(milliseconds);
    }
    return retryAfterMs(response.headers.get('retry-after'));
}

function responseError(response, data, apiKey) {
    const serviceError = data && data.error;
    const errors = data && Array.isArray(data.errors) ? data.errors : [];
    let description;

    if (typeof serviceError === 'string') description = serviceError;
    else if (serviceError && typeof serviceError.message === 'string')
        description = serviceError.message;
    else if (serviceError && typeof serviceError.description === 'string')
        description = serviceError.description;
    else if (errors.length) {
        description = errors
            .map((error) => error && (error.description || error.message || error.code))
            .filter(Boolean)
            .join('; ');
    } else if (data && typeof data.message === 'string') description = data.message;

    const statusCode = response.status;
    let message = `OpenAI-compatible endpoint HTTP ${statusCode}`;
    if (description) message += `: ${redact(description, apiKey).slice(0, 1000)}`;
    if (statusCode === 401)
        message += '. Check the configured API key or authentication requirements.';
    if (statusCode === 403) message += '. Check the API key permissions and endpoint access.';

    const serviceCode =
        (serviceError && (serviceError.code || serviceError.type)) || (errors[0] && errors[0].code);

    return makeError(message, serviceCode ? redact(serviceCode, apiKey) : `HTTP_${statusCode}`, {
        statusCode,
        requestId: redact(response.headers.get('x-request-id') || '', apiKey) || undefined,
        retryable: RETRYABLE_STATUS.has(statusCode) || (statusCode >= 500 && statusCode < 600),
        retryAfterMs: responseRetryAfterMs(response),
    });
}

/**
 * One attempt, including reading the complete response body, is bounded by timeoutMs.
 * The parent signal cancels in-flight work when the Node-RED node is redeployed or closed.
 */
async function requestAttempt({ url, apiKey, body, timeoutMs, signal }) {
    if (signal.aborted) throw makeError('Request cancelled', 'REQUEST_CANCELLED');

    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);

    try {
        const headers = {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body,
            signal: controller.signal,
            // Do not forward credentials or prompts to a redirect target.
            redirect: 'error',
        });

        const text = await response.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            if (!response.ok) throw responseError(response, undefined, apiKey);
            throw makeError('OpenAI-compatible endpoint returned invalid JSON', 'INVALID_RESPONSE');
        }

        if (!response.ok) throw responseError(response, data, apiKey);
        if (data && (data.error || data.result === 'error')) {
            const error = responseError(response, data, apiKey);
            error.retryable = false;
            throw error;
        }

        return {
            response: data,
            requestId: response.headers.get('x-request-id') || undefined,
            statusCode: response.status,
        };
    } catch (error) {
        if (signal.aborted) throw makeError('Request cancelled', 'REQUEST_CANCELLED');
        if (timedOut) {
            throw makeError(
                `OpenAI-compatible request timed out after ${timeoutMs} ms`,
                'ETIMEDOUT',
                {
                    retryable: true,
                },
            );
        }
        if (error && error.name === 'OpenAIV1CompatibleError') throw error;
        if (error && error.name === 'TypeError') {
            throw makeError(
                'Unable to reach the OpenAI-compatible endpoint or read its response',
                'NETWORK_ERROR',
                {
                    retryable: true,
                },
            );
        }
        throw makeError('OpenAI-compatible request failed', 'REQUEST_FAILED');
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
    }
}

async function requestChatCompletion(options) {
    const body = JSON.stringify(options.requestBody);

    for (let attempt = 0; ; attempt += 1) {
        try {
            const result = await requestAttempt({ ...options, body });
            return { ...result, retries: attempt };
        } catch (error) {
            if (options.signal.aborted) throw makeError('Request cancelled', 'REQUEST_CANCELLED');
            if (!error.retryable || attempt >= options.maxRetries) throw error;

            const backoffMs = Math.round(
                Math.min(500 * 2 ** attempt, 8000) * (0.75 + Math.random() * 0.25),
            );
            const waitMs = error.retryAfterMs === undefined ? backoffMs : error.retryAfterMs;

            if (waitMs > MAX_TIMER_MS) {
                error.message += '. Retry-After is too long for an automatic retry.';
                throw error;
            }

            if (options.onRetry) options.onRetry(attempt + 1, waitMs, error);
            try {
                await delay(waitMs, undefined, { signal: options.signal });
            } catch {
                throw makeError('Request cancelled', 'REQUEST_CANCELLED');
            }
        }
    }
}

module.exports = {
    requestChatCompletion,
    retryAfterMs,
    makeError,
    MAX_TIMER_MS,
};
