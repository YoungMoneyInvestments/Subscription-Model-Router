# Subscription Model Router

A single OpenAI-compatible proxy that routes AI model requests across multiple subscriptions. Use your Cursor subscription's models (Claude, GPT, Gemini, etc.) alongside OpenAI's API through one unified endpoint.

**Zero npm dependencies.** Node.js 18+ only.

## Supported Providers

| Provider | Auth Method | Models |
|----------|------------|--------|
| **Cursor** | macOS Keychain (automatic) | All models in your Cursor subscription |
| **OpenAI** | `OPENAI_API_KEY` env var | All OpenAI models (GPT-4o, o1, o3, o4, etc.) |

## Quick Start

```bash
git clone https://github.com/YoungMoneyInvestments/Subscription-Model-Router
cd Subscription-Model-Router
node proxy-server.mjs
```

The server starts on `http://localhost:4141` by default.

### Enable OpenAI

```bash
OPENAI_API_KEY=sk-... node proxy-server.mjs
```

### Custom Port

```bash
node proxy-server.mjs 8080
```

## How Routing Works

Requests are routed by model name:

| Model Pattern | Provider |
|---------------|----------|
| `gpt-*`, `o1-*`, `o3-*`, `o4-*`, `chatgpt-*` | OpenAI |
| Everything else | Cursor |

If a provider isn't configured, requests to its models return a clear error. Providers degrade gracefully — you can run with just Cursor, just OpenAI, or both.

## API Endpoints

### `GET /v1/models`

Returns a merged list of models from all active providers.

### `POST /v1/chat/completions`

Standard OpenAI chat completions format. Supports both streaming (`"stream": true`) and non-streaming responses.

## Usage Examples

### curl

```bash
# List all available models
curl http://localhost:4141/v1/models

# Chat (Cursor provider)
curl http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-4.6-sonnet-high", "messages": [{"role": "user", "content": "Hello"}]}'

# Chat (OpenAI provider)
curl http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello"}]}'

# Streaming
curl http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-4.6-sonnet-high", "messages": [{"role": "user", "content": "Hello"}], "stream": true}'
```

### OpenCode

Add to your `opencode.json`:

```json
{
  "provider": {
    "proxy": {
      "name": "Subscription Router",
      "api": "http://localhost:4141/v1",
      "models": {
        "claude-4.6-sonnet-high": {
          "name": "Claude 4.6 Sonnet",
          "limit": { "context": 200000, "output": 16000 }
        },
        "gpt-4o": {
          "name": "GPT-4o",
          "limit": { "context": 128000, "output": 16000 }
        }
      }
    }
  }
}
```

### Claude Code

In your Claude Code settings, set the provider to use this proxy as an OpenAI-compatible endpoint:

```
Base URL: http://localhost:4141/v1
```

### Any OpenAI-Compatible Client

Point any client that supports OpenAI's API format at `http://localhost:4141/v1`. No API key required (the proxy handles auth per-provider).

## How It Works

### Cursor Provider
1. Extracts your Cursor auth token from macOS Keychain
2. Translates incoming OpenAI-format requests to Cursor's Connect-RPC/protobuf format
3. Sends requests to Cursor's API via HTTP/2
4. Parses protobuf responses back to OpenAI format

### OpenAI Provider
Pure HTTPS pass-through — forwards the request body to `api.openai.com` with your API key, pipes the response back unchanged.

## Requirements

- **Node.js 18+**
- **macOS** for Cursor provider (uses Keychain for token storage)
- **Cursor CLI** installed and logged in ([cursor.com/cli](https://cursor.com/cli))
- **OpenAI API key** (optional, for OpenAI provider)

## Running as a Service (macOS)

Create `~/Library/LaunchAgents/com.subscription-model-router.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.subscription-model-router</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/proxy-server.mjs</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>OPENAI_API_KEY</key>
        <string>sk-your-key-here</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

Then:
```bash
launchctl load ~/Library/LaunchAgents/com.subscription-model-router.plist
```

## Troubleshooting

### "Cursor token not available"
Ensure the [Cursor CLI](https://cursor.com/cli) is installed and you're logged in:
```bash
security find-generic-password -s "cursor-access-token" -w
```

### Empty Cursor responses
Enable debug logging to see response parsing details:
```bash
DEBUG=1 node proxy-server.mjs
```

### OpenAI 401 errors
Verify your API key:
```bash
curl -H "Authorization: Bearer $OPENAI_API_KEY" https://api.openai.com/v1/models
```

## License

MIT
