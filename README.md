# @faigle/node-red-contrib-openai-v1-compatible

Provider-agnostic Node-RED node for non-streaming OpenAI-style **V1 Chat Completions** endpoints.

The node deliberately implements a narrow contract:

```text
POST <base-url>/chat/completions
Authorization: Bearer <api-key>   # when configured
Content-Type: application/json
```

with a request body based on:

```json
{
    "model": "model-id",
    "messages": [{ "role": "user", "content": "prompt" }],
    "stream": false
}
```

It contains no provider presets and no provider-specific request rewriting.

## Features

- Shared connection config node for base URL, authentication, retries, timeout, and logging
- Stored API key, environment API key, or no authentication
- Configurable model using Node-RED typed properties
- Optional system instructions
- Text input or Chat Completions message arrays
- Optional `max_completion_tokens` and `temperature`
- Pass-through **Extra Parameters** object for optional or implementation-specific fields
- Generated-text or complete-response output
- Configurable `msg`, `flow`, or `global` output target
- Retry handling for network failures, timeouts, HTTP 408/409/429, and 5xx
- `Retry-After` and `retry-after-ms` support
- Request timeout and cancellation when the node closes
- Optional raw-response metadata
- Uses `@faigle/node-red-runtime-utils` for typed properties and status behavior

## Requirements

- Node.js 22+
- Node-RED 4+
- `@faigle/node-red-runtime-utils` 0.4.2+
- An endpoint implementing a sufficiently compatible `POST /chat/completions` API

## Installation

From a package tarball:

```bash
cd ~/.node-red
npm install /path/to/faigle-node-red-contrib-openai-v1-compatible-0.2.0.tgz
```

Restart Node-RED after installation.

## Connection config node

The **OpenAI V1 Compatible Config** node owns endpoint and runtime connection settings. Reuse one config node across multiple processing nodes that share the same endpoint/authentication.

### Authentication

The shared configuration node supports:

- **Stored credential** — API key stored using Node-RED credentials
- **Environment variable** — API key resolved on every request; default variable is `OPENAI_API_KEY`
- **None** — no `Authorization` header

Enter only the API key value. Do not include `Bearer`.

### Base URL

The config node appends `/chat/completions` to the configured base URL. Base URL supports a literal string or an environment-variable reference.

Typical shape:

```text
https://api.example.com/v1
```

which becomes:

```text
https://api.example.com/v1/chat/completions
```

If the configured value already ends in `/chat/completions`, it is used as-is.

Both HTTP and HTTPS are accepted so local inference servers can be used. URLs containing embedded credentials, query strings, or fragments are rejected.

Examples of base-URL shapes:

```text
https://api.openai.com/v1
https://api.infomaniak.com/2/ai/<product_id>/openai/v1
http://localhost:8080/v1
```

These examples do not imply guaranteed compatibility with any particular provider or server version.

### Retry, timeout, and logging

The config node also owns **Max Retries**, **Timeout (ms)**, and request-metadata logging. This keeps transport behavior consistent for all processing nodes that share the connection.

## Processing node

### Model

Typed property sent unchanged as the `model` field.

### Instructions

Optional typed value prepended to the request as:

```json
{ "role": "system", "content": "..." }
```

### Input

Defaults to `msg.payload`.

The input can be:

- text
- UTF-8 `Buffer`
- number or boolean, converted to text
- object, JSON-encoded into one `user` message
- Chat Completions message array

For example:

```js
msg.payload = [
    { role: 'system', content: 'Answer concisely.' },
    { role: 'user', content: 'Explain Node-RED.' },
];
return msg;
```

The node does not maintain conversation history between messages.

### Extra Parameters

An optional object merged into the outgoing request before the node applies its core fields.

Example:

```json
{
    "top_p": 0.9,
    "response_format": { "type": "json_object" },
    "seed": 123
}
```

This can also carry fields such as tools, tool choice, reasoning controls, `max_tokens`, or implementation-specific extensions.

The following fields are always controlled by the node and therefore override values in Extra Parameters:

- `model`
- `messages`
- `stream` (`false`)

When configured, the dedicated **Max Tokens** and **Temperature** fields also override corresponding Extra Parameters values.

Extra Parameters are intentionally not provider-validated.

### Max Tokens

Optional positive integer sent as:

```json
{ "max_completion_tokens": 1024 }
```

Leave blank to omit it. If a target implementation uses another field such as `max_tokens`, leave this field blank and supply that value through Extra Parameters.

### Temperature

Optional number from `0` through `2`. Leave blank to omit it.

### Output

**Generated text** writes `choices[0].message.content` to the selected output target.

**Complete response object** writes the complete parsed JSON response.

Text mode returns an error when the first choice contains no text, for example a tool-call-only response. Use complete-response mode for such workflows.

## Metadata

The node adds:

```js
msg.openaiV1 = {
    id,
    requestId,
    model,
    created,
    finishReason,
    usage,
    outputText,
    statusCode,
    maxRetries,
    retries,
    timeoutMs,
};
```

When **Include raw response** is enabled:

```js
msg.openaiV1.response;
```

contains the complete parsed response.

`msg.openaiV1` is reserved by the node and cannot be used as the configured message output target.

## Retry and timeout behavior

These settings are configured on the shared connection config node. Default retry count: `4`.

Retryable conditions:

- network failures
- timeouts
- HTTP 408
- HTTP 409
- HTTP 429
- HTTP 5xx

The node honors `Retry-After` and `retry-after-ms` where possible. Otherwise it uses bounded exponential backoff with jitter.

A timeout applies to each individual HTTP attempt, including reading the response body. Retry delays are additional.

Requests and retry delays are aborted when the node closes or is redeployed. Cancellation cannot guarantee that a remote provider has stopped generation or billing.

## Compatibility scope

The node implements only the OpenAI-style, non-streaming Chat Completions transport contract. It does **not** contain special handling for OpenAI, Infomaniak, Gemini, xAI, llama.cpp, Ollama, or any other implementation.

In particular, the node does not attempt to normalize:

- provider-specific authentication
- model capabilities
- optional parameter names or semantics
- unsupported roles
- tool definitions or tool execution
- structured-output differences
- multimodal differences
- provider-specific error objects beyond common message/code shapes
- streaming

If a server accepts the request shape and returns an OpenAI-style Chat Completion response, the node can use it. Otherwise the flow or server configuration must adapt accordingly.

## Source layout

```text
src/openai-v1-compatible-config.js
src/openai-v1-compatible-config.html
src/openai-v1-compatible.js
src/openai-v1-compatible.html
src/lib/chat-request.js
```

The config node and processing node are registered as separate Node-RED modules.

## Development

Run syntax checks:

```bash
npm run check
```

Run tests:

```bash
npm test
```
