# OpenCowork Import Protocol

Web (currently `https://routin.ai/device/opencowork`) authorizes the user, then returns
provider configuration through the same device-login handoff the client already uses.

- Desktop: `opencowork://import/provider#settings=base64url:<payload>`
- CLI: `POST http://127.0.0.1:<port>/opencowork-device-login` with the same JSON plus `state`

`schemaVersion` omitted or `1` is the original Routin-key import. `schemaVersion: 2` can
configure built-in or custom channels, including models and model parameters.

## Login URL

Clients open the device-login page with:

| Query                            | Meaning                                 |
| -------------------------------- | --------------------------------------- |
| `protocol=2`                     | Client understands v2                   |
| `client=desktop` or `client=cli` | Which handoff to use                    |
| `callback`                       | CLI localhost callback URL              |
| `state`                          | CLI CSRF token; echoed in the POST body |

Unknown query parameters are ignored.

## Transports

### Desktop deep link

```
opencowork://import/provider#settings=base64url:<base64url-json>
```

Keep the encoded hash at or under 6KB. Larger catalogs should use `configRef`.

### CLI callback

```http
POST /opencowork-device-login
Content-Type: application/json

{ "state": "<uuid>", ...payload }
```

Body limit is 256KB. `state` must match the login URL. CORS is open for the login page.

Legacy v1 body still works:

```json
{ "state": "<uuid>", "apiKey": "ak-…", "kind": "apiKey" }
```

## v1 payload

```json
{
  "providers": [{ "apiKey": "ak-…", "builtinId": "routin-ai", "kind": "apiKey" }],
  "source": "routin-device-login"
}
```

The client classifies `ak-` → `routin-ai` and `plan-` → `routin-ai-plan`, writes the key,
and selects a default model. Other local providers are left alone.

## v2 payload

```json
{
  "schemaVersion": 2,
  "source": "routin-device-login",
  "active": { "key": "builtin:routin-ai", "modelId": "grok-4.6" },
  "providers": []
}
```

Each `providers[]` entry is an upsert. Local channels that are not listed are not deleted.

### Built-in channel

```json
{
  "kind": "builtin",
  "builtinId": "openai",
  "apiKey": "sk-…",
  "models": [{ "id": "gpt-5.6-sol", "name": "GPT 5.6 Sol", "enabled": true }]
}
```

`kind` may be omitted when `builtinId` is present. Known ids:

`routin-ai`, `routin-ai-plan`, `openai`, `anthropic`, `google`, `deepseek`, `openrouter`,
`opencode`, `opencode-go`, `ollama`, `azure-openai`, `moonshot`, `moonshot-coding`, `qwen`,
`qwen-coding`, `baidu`, `baidu-coding`, `minimax`, `minimax-coding`, `siliconflow`,
`gitee-ai`, `xiaomi`, `xiaomi-coding`, `bigmodel`, `bigmodel-coding`, `volcengine`, `xai`,
`longcat`, `hunyuan`, `stepfun`, `stepfun-plan`, `mistral`, `meta`, `groq`, `vertex-ai`,
`lmstudio`, `nvidia`, `cerebras`, `together`, `fireworks`, `modelscope`, `ppio`, `novita`,
`infini`, `huggingface`

`codex-oauth` and `copilot-oauth` are rejected. This protocol only writes `authMode: "apiKey"`.

An unknown `builtinId` with `type` + `baseUrl` is imported as a custom channel. Otherwise it
is skipped.

### Custom channel

```json
{
  "kind": "custom",
  "key": "custom:acme-gateway",
  "name": "Acme Gateway",
  "type": "openai-chat",
  "baseUrl": "https://llm.example.com/v1",
  "apiKey": "sk-…",
  "defaultModel": "acme-large",
  "models": [{ "id": "acme-large", "name": "Acme Large", "enabled": true }]
}
```

`key` is required and stored as `importKey` so a later login updates the same row.

`type` must be one of: `anthropic`, `openai-chat`, `openai-responses`, `openai-images`,
`openai-video`, `seedance-video`, `xai-video`, `gemini-interactions`, `vertex-ai`.

### Channel fields

Omitted fields are left unchanged on an existing row.

Writable: `name`, `apiKey`, `baseUrl`, `enabled`, `defaultModel`, `type`,
`requiresApiKey`, `useSystemProxy`, `allowInsecureTls`, `sendTemperature`,
`sendMaxOutputTokens`, `userAgent`, `requestOverrides`, `websocketUrl`,
`websocketMode`, `cacheTtl`, `models`, `modelPolicy`.

`modelPolicy` is `merge` (default, upsert by model `id`) or `replace`.

Not written: `oauth`, `oauthAccounts`, `channel`, local `id`, `createdAt`, `presetVersion`.
Icons must be `https` URLs — no data URLs.

### Model fields

`models[].id` is the upsert key. Writable fields match the desktop `AIModelConfig`:
identity, context window, capabilities, `thinkingConfig`, `requestOverrides`, Responses
image-generation, cache flags, and optional pricing.

Global `settings.temperature` is not part of this protocol. Use `sendTemperature` on the
channel, or pin a value with `requestOverrides.body` / `omitBodyKeys`.

## configRef

When the deep-link hash would exceed ~6KB:

```json
{
  "schemaVersion": 2,
  "source": "routin-device-login",
  "configRef": {
    "url": "https://routin.ai/api/opencowork/import/…",
    "token": "…",
    "expiresAt": 1770000000000
  }
}
```

The client `GET`s the URL with `Authorization: Bearer <token>`. The URL must be `https` on
`routin.ai` or a `*.routin.ai` host. The response is a full v2 document (not another
`configRef`). CLI can POST the full document directly and skip `configRef`.

## Apply rules

1. Only listed channels are written.
2. `active` selects `activeProviderId` / `activeModelId`. If omitted, the first successful
   channel and its `defaultModel` (or first model) become active.
3. Partial success is allowed: valid channels are written, skipped entries are reported.
4. A v1 payload never goes through the v2 overlay path.

## Client implementation

| Role                 | Location                                   |
| -------------------- | ------------------------------------------ |
| Types, parse, apply  | `src/shared/opencowork-import-protocol.ts` |
| Desktop persist      | `src/main/lib/opencowork-import.ts`        |
| CLI persist          | `cli/src/runtime/provider-setup.ts`        |
| CLI callback         | `cli/src/lib/device-login-bridge.ts`       |
| v1 Routin classifier | `src/shared/routin-credential.ts`          |
