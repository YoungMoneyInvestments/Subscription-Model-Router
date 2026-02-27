#!/usr/bin/env node
/**
 * Subscription Model Router
 * Routes OpenAI-compatible requests across multiple AI providers:
 * - Cursor: Translates to Connect-RPC/protobuf format (uses macOS Keychain token)
 * - OpenAI: Pure pass-through to api.openai.com (uses OPENAI_API_KEY env var)
 *
 * Zero npm dependencies. Node.js 18+ required.
 *
 * Usage: node proxy-server.mjs [port]
 */

import http from "http";
import http2 from "http2";
import https from "https";
import { execSync } from "child_process";
import { randomUUID } from "crypto";
import zlib from "zlib";

// Prevent unhandled errors from crashing the process
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION]', err?.message || err);
});

// ============================================================
// Section 1: Config & Provider Detection
// ============================================================

const PORT = parseInt(process.argv[2]) || 4141;
const AGENT_BASE = "agentn.api5.cursor.sh";
const CLIENT_VERSION = "cli-2026.01.09-231024f";

// OpenAI provider: enabled if OPENAI_API_KEY is set
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE = "api.openai.com";

// Model → provider routing
function getProvider(model) {
  const m = model.toLowerCase();
  if (m.startsWith("gpt-") || m.startsWith("o1-") || m.startsWith("o3-") || m.startsWith("o4-") || m.startsWith("chatgpt-")) {
    return "openai";
  }
  return "cursor";
}

// Check which providers are available
function getCursorToken() {
  try {
    return execSync('security find-generic-password -s "cursor-access-token" -w', {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

const cursorAvailable = !!getCursorToken();
const openaiAvailable = !!OPENAI_API_KEY;

// ============================================================
// Section 2: Cursor Provider (Connect-RPC / Protobuf)
// ============================================================

function getToken() {
  const token = getCursorToken();
  if (!token) {
    console.error("Error: Could not get Cursor token from keychain");
    throw new Error("Cursor token not available");
  }
  return token;
}

class ProtoWriter {
  constructor() { this.parts = []; }

  writeVarint(v) {
    const b = [];
    while (v > 127) { b.push((v & 0x7f) | 0x80); v >>>= 7; }
    b.push(v & 0x7f);
    this.parts.push(Buffer.from(b));
  }

  writeString(field, value) {
    const buf = Buffer.from(value, 'utf8');
    this.writeVarint((field << 3) | 2);
    this.writeVarint(buf.length);
    this.parts.push(buf);
  }

  writeMessage(field, writer) {
    const buf = writer.toBuffer();
    this.writeVarint((field << 3) | 2);
    this.writeVarint(buf.length);
    this.parts.push(buf);
  }

  writeInt32(field, value) {
    this.writeVarint((field << 3) | 0);
    this.writeVarint(value);
  }

  toBuffer() { return Buffer.concat(this.parts); }
}

function buildProtobufRequest(text, model = 'composer-1', context = '') {
  const messageId = randomUUID();
  const conversationId = randomUUID();

  const userMsg = new ProtoWriter();
  userMsg.writeString(1, text);
  userMsg.writeString(2, messageId);
  userMsg.writeString(3, '');

  const fileCtx = new ProtoWriter();
  fileCtx.writeString(1, '/context.txt');
  fileCtx.writeString(2, context || 'Session context');

  const explicitCtx = new ProtoWriter();
  explicitCtx.writeMessage(2, fileCtx);

  const userMsgAction = new ProtoWriter();
  userMsgAction.writeMessage(1, userMsg);
  userMsgAction.writeMessage(2, explicitCtx);

  const convAction = new ProtoWriter();
  convAction.writeMessage(1, userMsgAction);

  const displayName = model.charAt(0).toUpperCase() + model.slice(1).replace(/-/g, ' ');
  const modelDetails = new ProtoWriter();
  modelDetails.writeString(1, model);
  modelDetails.writeString(3, model);
  modelDetails.writeString(4, displayName);
  modelDetails.writeString(5, displayName);
  modelDetails.writeInt32(7, 0);

  const runReq = new ProtoWriter();
  runReq.writeString(1, '');
  runReq.writeMessage(2, convAction);
  runReq.writeMessage(3, modelDetails);
  runReq.writeString(4, '');
  runReq.writeString(5, conversationId);

  const clientMsg = new ProtoWriter();
  clientMsg.writeMessage(1, runReq);

  return { payload: clientMsg.toBuffer(), messageId, conversationId };
}

function createFrame(payload) {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos];
}

function extractStringsFromProtobuf(buf, fieldPath = '', depth = 0) {
  const strings = [];
  let pos = 0;

  while (pos < buf.length) {
    const [tag, newPos] = readVarint(buf, pos);
    if (newPos === pos) break;
    pos = newPos;

    const fieldNum = tag >> 3;
    const wireType = tag & 0x07;
    const currentPath = fieldPath ? `${fieldPath}.${fieldNum}` : `${fieldNum}`;

    if (wireType === 0) {
      const [, nextPos] = readVarint(buf, pos);
      pos = nextPos;
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 2) {
      const [len, dataStart] = readVarint(buf, pos);
      pos = dataStart + len;

      if (len > 0 && dataStart + len <= buf.length) {
        const data = buf.slice(dataStart, dataStart + len);

        const nested = extractStringsFromProtobuf(data, currentPath, depth + 1);
        if (nested.length > 0) {
          strings.push(...nested);
        }

        const str = data.toString('utf8');
        if (str.length > 0 && /^[\x20-\x7e\n\r\t]+$/.test(str)) {
          strings.push({ text: str, fieldPath: currentPath, depth });
        }
      }
    } else if (wireType === 5) {
      pos += 4;
    } else {
      break;
    }
  }

  return strings;
}

function extractTextFromResponse(data, userPrompt = '') {
  const allStrings = [];
  let offset = 0;
  let frameIndex = 0;

  while (offset < data.length) {
    if (data.length - offset < 5) break;

    const compressed = data[offset];
    const length = data.readUInt32BE(offset + 1);

    if (data.length - offset < 5 + length) break;

    let payload = data.slice(offset + 5, offset + 5 + length);

    if (compressed === 1) {
      try { payload = zlib.gunzipSync(payload); } catch(e) {}
    }

    const strings = extractStringsFromProtobuf(payload);
    for (const s of strings) {
      s.frameIndex = frameIndex;
    }
    allStrings.push(...strings);

    offset += 5 + length;
    frameIndex++;
  }

  const userPromptLower = userPrompt.toLowerCase().trim();
  const userPromptWords = userPromptLower.split(/\s+/).filter(w => w.length > 3);

  const candidates = allStrings
    .filter(s => {
      const t = s.text.trim();
      const tLower = t.toLowerCase();

      if (t.length === 0) return false;
      if (t.length > 2000) return false;
      if (tLower === userPromptLower) return false;
      if (userPrompt && t.includes(userPrompt)) return false;
      if (/^[0-9a-f]{16}$/i.test(t)) return false;
      if (/^[0-9a-f]{32}$/i.test(t)) return false;
      if (/^[0-9a-f-]{20,}$/i.test(t) && !t.includes(' ')) return false;
      if (t.includes('You are a powerful')) return false;
      if (t.includes('"role"')) return false;
      if (t.includes('providerOptions')) return false;
      if (t.includes('serverGenReqId')) return false;
      if (t.includes('user_query')) return false;
      if (t.includes('composer-1') || t.includes('Composer 1')) return false;
      if (t.includes('Session context')) return false;
      if (t.includes('/context.txt')) return false;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return false;
      if (t.length < 3 && !/\w/.test(t)) return false;

      return true;
    })
    .map(s => {
      let score = 0;
      const t = s.text.trim();
      const tLower = t.toLowerCase();

      if (t.length > 10) score += 20;
      if (t.length > 30) score += 30;
      if (t.length > 50) score += 50;
      if (/[.!?]$/.test(t)) score += 40;
      if (/^[A-Z]/.test(t)) score += 10;
      if (t.includes(' ')) score += 20;
      score += s.frameIndex * 10;
      if (s.frameIndex > 10) score += 50;
      score += s.depth * 2;

      let matchesUserWords = 0;
      for (const word of userPromptWords) {
        if (tLower.includes(word)) matchesUserWords++;
      }
      if (userPromptWords.length > 0) {
        const matchRatio = matchesUserWords / userPromptWords.length;
        if (matchRatio > 0.3) score -= 150;
        if (matchRatio > 0.5) score -= 300;
        if (matchRatio > 0.8) score -= 500;
      }

      if (t.length > 5 && userPromptLower.includes(tLower)) {
        score -= 1000;
      }
      if (userPrompt.length > 5 && tLower.includes(userPromptLower)) {
        score -= 1000;
      }

      if (t.includes('/') && t.length < 50) score -= 50;
      if (/^[A-Z][a-z]+ [A-Z0-9][a-z0-9.-]*$/i.test(t)) score -= 30;

      return { ...s, score };
    })
    .sort((a, b) => b.score - a.score);

  if (process.env.DEBUG) {
    console.log('Top 5 candidates:');
    candidates.slice(0, 5).forEach((c, i) => {
      console.log(`  ${i+1}. score=${c.score} frame=${c.frameIndex} depth=${c.depth}: "${c.text.substring(0, 60)}..."`);
    });
  }

  if (candidates.length > 0) {
    return candidates[0].text.trim();
  }

  return '';
}

function cursorStreamChat(model, messages, onData, onEnd, onError) {
  const token = getToken();

  const extractText = (content) => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('\n');
    }
    return String(content || '');
  };

  const lastUserMsg = messages.filter(m => m.role === 'user').pop();
  const prompt = extractText(lastUserMsg?.content);
  const context = messages.map(m => `${m.role}: ${extractText(m.content)}`).join('\n');

  const { payload } = buildProtobufRequest(prompt, model, context);
  const frame = createFrame(payload);

  const client = http2.connect(`https://${AGENT_BASE}`);

  let responseData = Buffer.alloc(0);
  let lastDataTime = Date.now();

  client.on('error', (err) => {
    console.error('  HTTP/2 client error:', err.message);
    onError(err);
  });

  const stream = client.request({
    ':method': 'POST',
    ':path': '/agent.v1.AgentService/Run',
    'authorization': `Bearer ${token}`,
    'content-type': 'application/connect+proto',
    'connect-protocol-version': '1',
    'x-cursor-client-type': 'cli',
    'x-cursor-client-version': CLIENT_VERSION,
    'x-ghost-mode': 'false',
    'x-request-id': randomUUID(),
  });

  const idleCheck = setInterval(() => {
    if (Date.now() - lastDataTime > 3000 && responseData.length > 0) {
      clearInterval(idleCheck);
      console.log(`  Idle timeout - Response: ${responseData.length} bytes`);
      const text = extractTextFromResponse(responseData, prompt);
      console.log(`  Extracted text: "${text.substring(0, 100)}..."`);
      if (text) onData(text);
      onEnd();
      client.close();
    }
  }, 500);

  stream.on('response', (headers) => {
    console.log(`  Cursor API status: ${headers[':status']}`);
    if (headers[':status'] !== 200) {
      clearInterval(idleCheck);
      onError(new Error(`HTTP ${headers[':status']}`));
      client.close();
    }
  });

  stream.on('data', (chunk) => {
    lastDataTime = Date.now();
    responseData = Buffer.concat([responseData, chunk]);
  });

  stream.on('end', () => {
    clearInterval(idleCheck);
    console.log(`  Response received: ${responseData.length} bytes`);
    const text = extractTextFromResponse(responseData, prompt);
    console.log(`  Extracted text: "${text.substring(0, 100)}..."`);
    if (text) onData(text);
    onEnd();
    client.close();
  });

  stream.on('error', (err) => {
    clearInterval(idleCheck);
    onError(err);
    client.close();
  });

  stream.write(frame);
  stream.end();

  setTimeout(() => {
    clearInterval(idleCheck);
    console.log(`  Hard timeout - Response: ${responseData.length} bytes`);
    const text = extractTextFromResponse(responseData, prompt);
    if (text) onData(text);
    onEnd();
    client.close();
  }, 60000);
}

async function cursorConnectRequest(host, service, method, body = {}) {
  const token = getToken();
  const postData = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${host}`);

    client.on("error", reject);

    const req = client.request({
      ":method": "POST",
      ":path": `/${service}/${method}`,
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "connect-protocol-version": "1",
      "accept": "application/json",
      "x-cursor-client-type": "cli",
      "x-cursor-client-version": CLIENT_VERSION,
      "x-ghost-mode": "false",
      "x-request-id": randomUUID(),
    });

    let data = "";
    req.on("data", (chunk) => data += chunk);
    req.on("end", () => {
      client.close();
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(data);
      }
    });
    req.on("error", (err) => {
      client.close();
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

async function getCursorModels() {
  try {
    const result = await cursorConnectRequest(AGENT_BASE, "agent.v1.AgentService", "GetUsableModels");
    return (result.models || []).map(m => ({
      id: m.modelId,
      object: "model",
      created: Date.now(),
      owned_by: "cursor",
    }));
  } catch (err) {
    console.error("  Failed to fetch Cursor models:", err.message);
    return [];
  }
}

// ============================================================
// Section 3: OpenAI Provider (Pure Pass-Through)
// ============================================================

function openaiRequest(path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: OPENAI_BASE,
      port: 443,
      path: path,
      method: method,
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      resolve(res);
    });

    req.on("error", reject);

    if (body) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function openaiStreamChat(requestBody, res) {
  const options = {
    hostname: OPENAI_BASE,
    port: 443,
    path: "/v1/chat/completions",
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    // Forward status and relevant headers
    const forwardHeaders = {
      "Content-Type": proxyRes.headers["content-type"] || "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    };
    res.writeHead(proxyRes.statusCode, forwardHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err) => {
    console.error("  OpenAI proxy error:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ error: { message: "OpenAI upstream error: " + err.message } }));
  });

  proxyReq.write(JSON.stringify(requestBody));
  proxyReq.end();
}

function openaiNonStreamChat(requestBody, res) {
  const options = {
    hostname: OPENAI_BASE,
    port: 443,
    path: "/v1/chat/completions",
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    let data = "";
    proxyRes.on("data", (chunk) => data += chunk);
    proxyRes.on("end", () => {
      res.writeHead(proxyRes.statusCode, { "Content-Type": "application/json" });
      res.end(data);
    });
  });

  proxyReq.on("error", (err) => {
    console.error("  OpenAI proxy error:", err.message);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "OpenAI upstream error: " + err.message } }));
  });

  proxyReq.write(JSON.stringify(requestBody));
  proxyReq.end();
}

async function getOpenAIModels() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: OPENAI_BASE,
      port: 443,
      path: "/v1/models",
      method: "GET",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.data || []);
        } catch {
          resolve([]);
        }
      });
    });

    req.on("error", (err) => {
      console.error("  Failed to fetch OpenAI models:", err.message);
      resolve([]);
    });

    req.end();
  });
}

// ============================================================
// Section 4: Model Router
// ============================================================

function routeChat(provider, model, messages, stream, requestBody, res) {
  if (provider === "openai") {
    if (!openaiAvailable) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "OpenAI provider not configured. Set OPENAI_API_KEY environment variable." } }));
      return;
    }
    console.log(`  Routing to OpenAI`);
    if (stream) {
      openaiStreamChat(requestBody, res);
    } else {
      openaiNonStreamChat(requestBody, res);
    }
  } else {
    if (!cursorAvailable) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Cursor provider not available. Ensure Cursor CLI is installed and logged in." } }));
      return;
    }
    console.log(`  Routing to Cursor`);
    handleCursorChat(model, messages, stream, res);
  }
}

// ============================================================
// Section 5: Request Handler
// ============================================================

function handleCursorChat(model, messages, stream, res) {
  // Prevent unhandled 'error' events on the response from crashing the process
  res.on('error', (err) => {
    console.error("Response stream error (suppressed):", err.message);
  });

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    const responseId = `chatcmpl-${randomUUID()}`;

    cursorStreamChat(
      model,
      messages,
      (text) => {
        if (text) {
          const eventData = {
            id: responseId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              delta: { content: text },
              finish_reason: null,
            }],
          };
          res.write(`data: ${JSON.stringify(eventData)}\n\n`);
        }
      },
      () => {
        res.write(`data: ${JSON.stringify({
          id: responseId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      },
      (err) => {
        console.error("Stream error:", err.message);
        try {
          if (!res.writableEnded) {
            if (!res.headersSent) {
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: { message: err.message, type: "upstream_error" } }));
            } else {
              res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
              res.end();
            }
          }
        } catch (writeErr) {
          console.error("Stream error handler failed:", writeErr.message);
        }
      }
    );
  } else {
    let fullResponse = "";

    cursorStreamChat(
      model,
      messages,
      (text) => { fullResponse += text; },
      () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: `chatcmpl-${randomUUID()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{
            index: 0,
            message: { role: "assistant", content: fullResponse || "No response received" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }));
      },
      (err) => {
        console.error("Error:", err.message);
        try {
          if (!res.writableEnded) {
            if (!res.headersSent) {
              res.writeHead(502, { "Content-Type": "application/json" });
            }
            res.end(JSON.stringify({ error: { message: err.message, type: "upstream_error" } }));
          }
        } catch (writeErr) {
          console.error("Error handler failed:", writeErr.message);
        }
      }
    );
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // Read body
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }
  let json = {};
  try {
    json = body ? JSON.parse(body) : {};
  } catch {}

  console.log(`[${new Date().toISOString()}] ${req.method} ${path}`);

  try {
    // GET /v1/models - merged model list from all providers
    if (path === "/v1/models" && req.method === "GET") {
      const modelPromises = [];

      if (cursorAvailable) {
        modelPromises.push(getCursorModels());
      }
      if (openaiAvailable) {
        modelPromises.push(getOpenAIModels());
      }

      const results = await Promise.all(modelPromises);
      const allModels = results.flat();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: allModels }));
      return;
    }

    // POST /v1/chat/completions - route to appropriate provider
    if (path === "/v1/chat/completions" && req.method === "POST") {
      const { model = 'composer-1', messages = [], stream = false } = json;
      const provider = getProvider(model);

      console.log(`  Model: ${model}, Provider: ${provider}, Messages: ${messages.length}, Stream: ${stream}`);

      routeChat(provider, model, messages, stream, json, res);
      return;
    }

    // Unknown endpoint
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Not found", path } }));

  } catch (err) {
    console.error("Error:", err.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: err.message } }));
  }
}

// ============================================================
// Section 6: Server Startup
// ============================================================

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  const providers = [];
  if (cursorAvailable) providers.push("Cursor (Keychain)");
  if (openaiAvailable) providers.push("OpenAI (API Key)");

  console.log(`
+---------------------------------------------------+
|         Subscription Model Router                 |
+---------------------------------------------------+
|  Listening on: http://localhost:${String(PORT).padEnd(5)}            |
|  Endpoint:     /v1/chat/completions               |
|  Models:       /v1/models                         |
+---------------------------------------------------+
|  Active Providers:                                |
${providers.map(p => `|    - ${p.padEnd(44)}|`).join('\n')}
${providers.length === 0 ? '|    (none configured)                              |\n' : ''}+---------------------------------------------------+
|  Routing:                                         |
|    gpt-*, o1-*, o3-*, o4-*, chatgpt-* -> OpenAI   |
|    Everything else                    -> Cursor    |
+---------------------------------------------------+
`);

  if (!cursorAvailable && !openaiAvailable) {
    console.warn("WARNING: No providers available!");
    console.warn("  - Cursor: Install Cursor CLI and log in");
    console.warn("  - OpenAI: Set OPENAI_API_KEY environment variable");
  }
});
