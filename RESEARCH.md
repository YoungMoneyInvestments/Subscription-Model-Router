# Research Notes: Reverse Engineering Cursor's API

This document details how we reverse-engineered Cursor's API to create an OpenAI-compatible proxy.

## Discovery Process

### 1. Initial Investigation

We started by examining how Cursor communicates with its backend:

- **Traffic Capture**: Used mitmproxy and custom HTTP/2 logging to capture Cursor's network traffic
- **Binary Analysis**: Examined the Cursor CLI binary and Electron app
- **Token Discovery**: Found auth tokens stored in macOS Keychain under `cursor-access-token`

### 2. API Endpoints Discovered

| Endpoint | Purpose | Protocol |
|----------|---------|----------|
| `api2.cursor.sh` | User info, settings, model list | Connect-RPC (JSON) |
| `agentn.api5.cursor.sh` | Chat/agent streaming (non-privacy mode) | Connect-RPC (Protobuf) |
| `agent.api5.cursor.sh` | Chat/agent streaming (privacy mode) | Connect-RPC (Protobuf) |

### 3. Protocol Analysis

Cursor uses **Connect-RPC** with Protocol Buffers, not standard REST or gRPC-Web.

#### Connect-RPC Frame Format
```
[1 byte: compression flag] [4 bytes: length (big-endian)] [payload]

Compression flags:
- 0x00 = uncompressed
- 0x01 = gzip compressed
```

#### Critical Headers
```javascript
{
  'content-type': 'application/connect+proto',
  'connect-protocol-version': '1',
  'x-cursor-client-type': 'cli',
  'x-cursor-client-version': 'cli-2026.01.09-231024f',  // Must match real version!
  'x-ghost-mode': 'false',
  'authorization': 'Bearer <jwt-token>'
}
```

The `x-cursor-client-version` header is critical - using an incorrect version results in `permission_denied` errors.

### 4. Protobuf Message Structure

We reverse-engineered the protobuf schema by analyzing captured traffic:

```protobuf
// Reconstructed from binary analysis
message AgentClientMessage {
  AgentRunRequest request = 1;
}

message AgentRunRequest {
  string conversation_state = 1;  // Empty for new conversations
  ConversationAction action = 2;
  ModelDetails model = 3;
  string unknown4 = 4;            // Empty
  string conversation_id = 5;     // UUID
}

message ConversationAction {
  UserMessageAction user_action = 1;
}

message UserMessageAction {
  UserMessage message = 1;
  ExplicitContext context = 2;    // KEY: Context goes here, not in ConversationAction!
}

message UserMessage {
  string text = 1;
  string message_id = 2;          // UUID
  string unknown3 = 3;            // Empty
}

message ExplicitContext {
  FileContext file = 2;
}

message FileContext {
  string path = 1;
  string content = 2;
}

message ModelDetails {
  string model_id = 1;            // e.g., "composer-1"
  string display_model_id = 3;
  string display_name = 4;
  string display_name2 = 5;
  int32 unknown7 = 7;             // Always 0
}
```

### 5. Response Parsing Challenge

Cursor's responses are complex protobuf streams containing:
- System prompts (leaked!)
- User message echo
- Assistant responses (the actual content we want)
- Metadata (IDs, timestamps, etc.)

We developed a scoring algorithm to extract the correct assistant text:
1. Parse Connect-RPC frames
2. Decompress gzipped payloads
3. Recursively extract all strings from protobuf
4. Score candidates based on:
   - Frame index (later frames = assistant response)
   - String length and structure
   - Filter out user prompt echoes, hex IDs, metadata
5. Return highest-scored candidate

### 6. System Prompt Discovery

During research, we discovered Cursor leaks its full system prompt in responses. Key findings:
- Claims to be "Composer, a language model trained by Cursor"
- Uses `<think>` tags for hidden reasoning
- Receives extensive context (files, cursor position, edit history, linter errors)
- Instructed to never mention tool names to users

Full system prompt saved in the main project repo.

## Current Limitations

### What Works
- ✅ Authentication via macOS Keychain
- ✅ Model listing (15 models available)
- ✅ Basic chat completions
- ✅ Streaming responses (SSE)
- ✅ Multi-turn conversations

### What Doesn't Work Yet

#### Tool Calling
Cursor supports tool calling but we haven't implemented it yet. From traffic analysis:
- Tools are defined in the system prompt
- Tool calls appear as structured data in responses
- Tool results are sent back in subsequent messages

**Next steps for tool calling:**
1. Capture traffic with tool-using prompts
2. Identify the protobuf fields for tool definitions
3. Parse tool call responses from the protobuf stream
4. Implement OpenAI-compatible tool call format translation

#### Image/Attachment Support
- Cursor supports image inputs via `ExplicitContext`
- Need to implement base64 image encoding in protobuf
- Map OpenAI's image_url format to Cursor's format

#### Privacy Mode
- Currently only using `agentn.api5.cursor.sh` (non-privacy)
- Privacy mode endpoint is `agent.api5.cursor.sh`
- May require different headers or request format

## Technical Challenges Overcome

### 1. Version Header Discovery
Initial requests failed with `permission_denied`. After extensive traffic analysis, we discovered the `x-cursor-client-version` header must match a real Cursor CLI version.

### 2. Context Placement
Early attempts placed `ExplicitContext` in `ConversationAction`. The correct structure nests it inside `UserMessageAction`.

### 3. Response Text Extraction
The protobuf response contains many strings. We built a scoring system that:
- Prefers strings from later frames (assistant deltas come after state)
- Filters out hex IDs, UUIDs, metadata
- Penalizes strings matching user input
- Handles multi-modal content arrays

### 4. Multi-Modal Content
OpenCode sends content as arrays for multi-modal support:
```javascript
content: [{ type: "text", text: "Hello" }]
```
We added extraction logic to handle both string and array formats.

## Files Reference

| File | Purpose |
|------|---------|
| `proxy-server.mjs` | Main proxy server with all protocol logic |
| `opencode.example.json` | Example OpenCode configuration |

## Research Artifacts (in main project)

| File | Purpose |
|------|---------|
| `cursor-system-prompt.md` | Extracted Cursor system prompt |
| `http2-logger.cjs` | Traffic capture tool |
| `test-working-chat.mjs` | Direct API test script |
| `/tmp/cursor-agent-network/` | Captured request/response binaries |

## Future Work

1. **Tool Calling Support**
   - Parse tool definitions from protobuf
   - Extract tool calls from responses
   - Translate to/from OpenAI format

2. **Image Support**
   - Encode images in ExplicitContext
   - Handle base64 and URL formats

3. **Better Streaming**
   - Currently waits for full response then sends
   - Could parse protobuf stream incrementally for true streaming

4. **Cross-Platform**
   - Currently macOS only (Keychain)
   - Add Linux/Windows token storage support

5. **Error Handling**
   - Better error messages for auth failures
   - Retry logic for transient errors

## Contributing

If you want to help extend this:

1. **Capture traffic**: Use mitmproxy or the http2-logger to capture new request types
2. **Analyze protobufs**: Hex dump payloads and identify field patterns
3. **Test incrementally**: Use curl against the proxy to verify changes
4. **Document findings**: Update this file with new discoveries

## Resources

- [Connect-RPC Protocol](https://connectrpc.com/docs/protocol/)
- [Protocol Buffers Encoding](https://protobuf.dev/programming-guides/encoding/)
- [HTTP/2 Specification](https://httpwg.org/specs/rfc7540.html)
