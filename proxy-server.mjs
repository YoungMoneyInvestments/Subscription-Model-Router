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

// Track uncaught exceptions — if too many in a short window, self-restart
// to avoid spinning at 100% CPU in a corrupted state.
let uncaughtCount = 0;
const UNCAUGHT_WINDOW_MS = 60_000;
const UNCAUGHT_THRESHOLD = 20;

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err.message);
  uncaughtCount++;
  if (uncaughtCount >= UNCAUGHT_THRESHOLD) {
    console.error(`[FATAL] ${uncaughtCount} uncaught exceptions in window — exiting for launchd restart`);
    process.exit(1);
  }
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION]', err?.message || err);
});

// Reset uncaught counter periodically
setInterval(() => { uncaughtCount = 0; }, UNCAUGHT_WINDOW_MS);

// ============================================================
// Section 1: Config & Provider Detection
// ============================================================

const PORT = parseInt(process.argv[2]) || 4141;
const AGENT_BASE = "agentn.api5.cursor.sh";
const CLIENT_VERSION = "cli-2026.01.09-231024f";

// OpenAI provider: enabled if OPENAI_API_KEY is set
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE = "api.openai.com";

// Cached set of Cursor-hosted model IDs (populated at startup)
let cursorModelIds = new Set();

// Default Composer model for conversational use. Composer models have
// unlimited quota on Cursor Pro. composer-2-fast ≈ Kimi K2.5 (quantized Opus 4.6).
const DEFAULT_COMPOSER_MODEL = 'composer-2-fast';

// Remap 'default' to a specific Composer model for consistent behavior.
// Non-Composer models pass through as-is.
function getEffectiveModel(model) {
  const m = model.toLowerCase();
  if (m === 'default') return DEFAULT_COMPOSER_MODEL;
  return model;
}

// Model → provider routing
function getProvider(model) {
  const m = model.toLowerCase();
  // If this model is in Cursor's model list, always route to Cursor
  if (cursorModelIds.has(m)) return "cursor";
  // Default routing: OpenAI-branded models go to OpenAI only if we have a key
  if (m.startsWith("gpt-") || m.startsWith("o1-") || m.startsWith("o3-") || m.startsWith("o4-") || m.startsWith("chatgpt-")) {
    return OPENAI_API_KEY ? "openai" : "cursor";
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

// Check if a string is likely natural language text (not binary/protobuf garbage).
// Allows UTF-8 characters unlike the original ASCII-only check.
function isLikelyText(str) {
  if (str.length === 0) return false;
  let printable = 0;
  const checkLen = Math.min(str.length, 500);
  for (let i = 0; i < checkLen; i++) {
    const code = str.charCodeAt(i);
    if (code === 0) return false;
    if (code < 0x09) return false;
    if (code > 0x0d && code < 0x20) return false;
    if (code === 0xfffd) return false;
    if ((code >= 0x20 && code <= 0x7e) || code >= 0x80) printable++;
  }
  return printable / checkLen > 0.5;
}

// Extract readable text segments from raw buffer (fallback when protobuf parsing fails)
function extractRawTextSegments(buf) {
  const segments = [];
  let current = '';

  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if ((byte >= 0x20 && byte <= 0x7e) || byte === 0x0a || byte === 0x0d || byte === 0x09) {
      current += String.fromCharCode(byte);
    } else {
      if (current.length >= 8 && /[a-zA-Z]{3,}/.test(current)) {
        segments.push(current);
      }
      current = '';
    }
  }
  if (current.length >= 8 && /[a-zA-Z]{3,}/.test(current)) {
    segments.push(current);
  }

  return segments;
}

// Try to extract text from a buffer that might be JSON
function tryExtractJSON(buf) {
  try {
    const str = buf.toString('utf8').trim();
    if (str.startsWith('{') || str.startsWith('[')) {
      const json = JSON.parse(str);
      if (json.choices?.[0]?.message?.content) return json.choices[0].message.content;
      if (json.choices?.[0]?.delta?.content) return json.choices[0].delta.content;
      if (json.text) return json.text;
      if (json.content) return typeof json.content === 'string' ? json.content : null;
      if (json.error) return null; // Don't treat errors as text
    }
    // SSE format
    if (str.includes('data: ')) {
      const parts = str.split('\n')
        .filter(l => l.startsWith('data: ') && l !== 'data: [DONE]')
        .map(l => {
          try {
            const d = JSON.parse(l.slice(6));
            return d.choices?.[0]?.delta?.content || d.text || '';
          } catch { return ''; }
        })
        .filter(Boolean);
      if (parts.length > 0) return parts.join('');
    }
  } catch {}
  return null;
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
        if (isLikelyText(str)) {
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

// Returns { text, error? } — error is set for rate limits/API errors
function extractTextFromResponse(data, userPrompt = '') {
  const allStrings = [];
  let offset = 0;
  let frameIndex = 0;
  let frameCount = 0;

  // ── Phase 1: Parse Connect-RPC frames ──
  while (offset < data.length) {
    if (data.length - offset < 5) break;

    const flags = data[offset];
    const length = data.readUInt32BE(offset + 1);

    if (length > 1_000_000 || data.length - offset < 5 + length) break;

    let payload = data.slice(offset + 5, offset + 5 + length);
    frameCount++;

    // Connect-RPC end-of-stream frame (flags bit 1) — contains JSON, not protobuf
    if (flags & 0x02) {
      try {
        const json = JSON.parse(payload.toString('utf8'));
        // Detect rate limit / API errors and propagate as structured error
        if (json.error) {
          const detail = json.error.details?.[0]?.debug?.details?.detail
            || json.error.details?.[0]?.debug?.details?.title
            || json.error.message || 'Cursor API error';
          const code = json.error.code === 'resource_exhausted' ? 429 : 502;
          console.log(`  [FRAME ${frameIndex}] API error (${code}): ${detail.substring(0, 120)}`);
          return { text: '', error: { status: code, body: {
            error: { message: detail, type: json.error.code, code }
          }}};
        }
        // Non-error JSON trailer — try to extract text
        const jsonText = tryExtractJSON(payload);
        if (jsonText) {
          console.log(`  [FRAME ${frameIndex}] JSON text in trailer: ${jsonText.length} chars`);
          return { text: postProcessText(jsonText) };
        }
      } catch {
        // Not JSON — skip
      }
      offset += 5 + length;
      frameIndex++;
      continue;
    }

    if (flags & 0x01) {
      try { payload = zlib.gunzipSync(payload); } catch {}
    }

    const strings = extractStringsFromProtobuf(payload);
    for (const s of strings) s.frameIndex = frameIndex;
    allStrings.push(...strings);

    if (strings.length === 0 && payload.length > 10) {
      const jsonText = tryExtractJSON(payload);
      if (jsonText) {
        allStrings.push({ text: jsonText, fieldPath: 'json', depth: 0, frameIndex });
      }
    }

    offset += 5 + length;
    frameIndex++;
  }

  console.log(`  [EXTRACT] ${frameCount} frames parsed, ${allStrings.length} raw strings from ${data.length} bytes`);

  // ── Phase 2: Fallbacks when frame parsing fails ──
  if (allStrings.length === 0 && data.length > 5) {
    const directStrings = extractStringsFromProtobuf(data);
    if (directStrings.length > 0) {
      console.log(`  [FALLBACK] Direct protobuf parse: ${directStrings.length} strings`);
      for (const s of directStrings) s.frameIndex = 0;
      allStrings.push(...directStrings);
    }
  }

  if (allStrings.length === 0 && data.length > 5) {
    const jsonText = tryExtractJSON(data);
    if (jsonText) {
      console.log(`  [FALLBACK] JSON parse: ${jsonText.length} chars`);
      return { text: postProcessText(jsonText) };
    }
  }

  if (allStrings.length === 0 && data.length > 5) {
    const segments = extractRawTextSegments(data);
    const filtered = segments.filter(s => {
      if (s.includes('CHAT conversation')) return false;
      if (s.includes('Do not call any tools')) return false;
      if (s.includes('[IMPORTANT:')) return false;
      if (s.includes('Session context')) return false;
      if (s.includes('/context.txt')) return false;
      if (/^[0-9a-f-]+$/i.test(s.trim())) return false;
      // Detect rate limit error in raw text
      if (s.includes('resource_exhausted')) return false;
      return true;
    });
    if (filtered.length > 0) {
      const best = filtered.sort((a, b) => b.length - a.length)[0].trim();
      if (best.length > 10) {
        console.log(`  [FALLBACK] Raw text: ${best.length} chars: "${best.substring(0, 100)}"`);
        return { text: postProcessText(best) };
      }
    }
    // Check if raw data is a rate limit error we missed
    const rawStr = data.toString('utf8');
    if (rawStr.includes('resource_exhausted') || rawStr.includes('RATE_LIMITED')) {
      return { text: '', error: { status: 429, body: {
        error: { message: 'Cursor API rate limit exceeded', type: 'resource_exhausted', code: 429 }
      }}};
    }
    const hex = data.slice(0, Math.min(100, data.length)).toString('hex').match(/.{1,2}/g)?.join(' ') || '';
    console.log(`  [DEBUG] 0 strings. First 100 bytes: ${hex}`);
    return { text: '' };
  }

  // ── Phase 3: Streaming concatenation (for Composer token-by-token responses) ──
  // Composer models stream tool calls + text across many small protobuf frames.
  // Filter out metadata/tool artifacts, then concatenate remaining text fragments.
  if (allStrings.length > 5) {
    const streamFragments = allStrings
      .filter(s => {
        const t = s.text;
        if (t.length === 0) return false;
        // UUIDs and hex strings
        if (/^[0-9a-f-]{16,}$/i.test(t) && !t.includes(' ')) return false;
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(t)) return false;
        // Tool-call IDs and metadata
        if (/^(call_|fc_|toolu_)/.test(t)) return false;
        if (/^(true|false|null|undefined)$/i.test(t)) return false;
        if (/^(content|count|files_with_matches|file_search|code_search|grep|find|read|write|edit)$/i.test(t)) return false;
        // Known metadata fields
        if (t.includes('/context.txt') || t.includes('Session context')) return false;
        if (t.includes('"role"') || t.includes('user_query')) return false;
        if (t.includes('providerOptions') || t.includes('serverGenReqId')) return false;
        if (t.includes('composer-') || t.includes('Composer ')) return false;
        // Prompt echoes — check against the system message and user prompt
        if (userPrompt && t.includes(userPrompt)) return false;
        if (userPrompt && t === userPrompt) return false;
        return true;
      })
      .sort((a, b) => a.frameIndex - b.frameIndex || a.depth - b.depth);

    // Deduplicate WITHIN each frame: take the deepest string per frame.
    // Deeper = more granular token, less protobuf overhead.
    // Never dedup across frames — different frames carry different tokens.
    const distinctFrames = new Set(streamFragments.map(f => f.frameIndex));

    if (distinctFrames.size > 15) {
      const byFrame = new Map();
      for (const frag of streamFragments) {
        if (!byFrame.has(frag.frameIndex)) byFrame.set(frag.frameIndex, []);
        byFrame.get(frag.frameIndex).push(frag);
      }

      const deduped = [];
      for (const [, frags] of byFrame) {
        // Within this frame, take the deepest string (most granular token)
        const maxDepth = Math.max(...frags.map(f => f.depth));
        const deepest = frags.filter(f => f.depth === maxDepth);
        // If multiple at same depth, take the shortest (least overhead)
        deepest.sort((a, b) => a.text.length - b.text.length);
        if (deepest.length > 0) deduped.push(deepest[0]);
      }

      deduped.sort((a, b) => a.frameIndex - b.frameIndex);

      if (deduped.length > 3) {
        const concatenated = deduped.map(f => f.text).join('');
        if (concatenated.length > 30 && /[a-zA-Z]{3,}/.test(concatenated)) {
          console.log(`  [STREAM-CONCAT] ${deduped.length} tokens from ${distinctFrames.size} frames → ${concatenated.length} chars`);
          return { text: postProcessText(concatenated) };
        }
      }
    }
  }

  // ── Phase 4: Score and rank individual strings (original Composer approach) ──
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
      if (t.includes('SYSTEM INSTRUCTIONS')) return false;
      if (t.includes('OUTPUT RULES')) return false;
      if (t.includes('CONVERSATION HISTORY')) return false;
      if (t.includes('providerOptions')) return false;
      if (t.includes('serverGenReqId')) return false;
      if (t.includes('user_query')) return false;
      if (t.includes('composer-1') || t.includes('Composer 1')) return false;
      if (t.includes('Session context')) return false;
      if (t.includes('/context.txt')) return false;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return false;
      if (t.length < 3 && !/\w/.test(t)) return false;
      if (/^call_/.test(t)) return false;
      if (/^fc_/.test(t)) return false;
      if (/^toolu_/.test(t)) return false;
      if (/^[0-9a-f-]{30,}/i.test(t) && !t.includes(' ')) return false;
      if (/^(true|false|null|undefined)$/i.test(t)) return false;
      if (/^(content|count|files_with_matches|file_search|code_search|grep|find|read|write|edit)$/i.test(t)) return false;
      if (!t.includes(' ') && t.length < 60 && /^[a-zA-Z0-9_.\-\/\\|*+?{}[\]^$()]+$/.test(t)) return false;
      if (t.length > 5 && !t.includes(' ') && (t.match(/[^a-zA-Z0-9\s]/g) || []).length > t.length * 0.3) return false;
      if (t.length < 20 && !t.includes(' ')) return false;

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

      if (t.length > 5 && userPromptLower.includes(tLower)) score -= 1000;
      if (userPrompt.length > 5 && tLower.includes(userPromptLower)) score -= 1000;
      if (t.includes('/') && t.length < 50) score -= 50;
      if (/^[A-Z][a-z]+ [A-Z0-9][a-z0-9.-]*$/i.test(t)) score -= 30;

      return { ...s, score };
    })
    .sort((a, b) => b.score - a.score);

  console.log(`  [EXTRACT] ${candidates.length} candidates from ${allStrings.length} strings`);
  if (candidates.length > 0) {
    const top = candidates[0];
    console.log(`    Top: score=${top.score} frame=${top.frameIndex} len=${top.text.trim().length}: "${top.text.trim().substring(0, 120)}"`);
  } else {
    const viable = allStrings.filter(s => s.text.trim().length > 20 && s.text.includes(' '));
    console.log(`  [EXTRACT] ${viable.length} strings with len>20 and spaces (all filtered):`);
    viable.slice(0, 8).forEach((s, i) => {
      console.log(`    ${i+1}. frame=${s.frameIndex} depth=${s.depth} len=${s.text.trim().length}: "${s.text.trim().substring(0, 120)}"`);
    });
  }

  if (candidates.length > 0) {
    const topScore = candidates[0].score;
    const threshold = Math.max(topScore * 0.4, topScore - 100);
    const selected = candidates
      .filter(c => c.score >= threshold && c.score > 0)
      .reduce((acc, c) => {
        const isDupe = acc.some(a =>
          a.text.includes(c.text) || c.text.includes(a.text)
        );
        if (!isDupe) acc.push(c);
        return acc;
      }, [])
      .sort((a, b) => a.frameIndex - b.frameIndex || a.depth - b.depth);

    let result;
    if (selected.length > 1) {
      result = selected.map(s => s.text.trim()).join('\n\n');
    } else {
      result = candidates[0].text.trim();
    }

    return { text: postProcessText(result) };
  }

  return { text: '' };
}

// Post-process extracted text: strip Composer narration artifacts
function postProcessText(text) {
  let result = text;

  // Strip short leaked artifacts at the very start (e.g., "cli\n", "cliYou...")
  result = result.replace(/^cli\s*\n?/, '');

  // Strip Composer bold status headers: standalone bold lines followed by newline.
  // e.g., "**Fixing auth middleware**\n\n" — but NOT inline bold like "**TCP** is..."
  result = result.replace(/^\*\*[A-Z][^*]{3,80}\*\*\s*$/gm, '');

  // Strip trailing lone double-asterisks from partial headers
  result = result.replace(/\*\*\s*$/, '');

  // Strip Composer narration meta-text (the model narrating its own actions)
  // e.g., "I'm providing guidance on fixing expired Google OAuth issues via 3 steps."
  result = result.replace(/^I'm (providing|addressing|explaining|clarifying|analyzing|looking|searching|checking)[^\n]{10,100}\.\s*\n*/i, '');

  // Remove trailing repetition: Composer sometimes appends a partial repeat
  // of earlier content at the end. Scan the last 30% of text for any 20-char
  // segment that also appears in the first 70%.
  if (result.length > 100) {
    const cutoff = Math.floor(result.length * 0.7);
    const tail = result.substring(cutoff);
    for (let start = 0; start < tail.length - 20; start++) {
      const segment = tail.substring(start, start + 20);
      const pos = result.indexOf(segment);
      if (pos >= 0 && pos < cutoff) {
        result = result.substring(0, cutoff + start).trimEnd();
        break;
      }
    }
  }

  // Clean up multiple consecutive newlines
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

function cursorStreamChat(model, messages, onData, onEnd, onError) {
  const effectiveModel = getEffectiveModel(model);
  if (effectiveModel !== model) {
    console.log(`  [REMAP] ${model} → ${effectiveModel}`);
  }

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

  const systemMsgs = messages.filter(m => m.role === 'system');
  const nonSystemMsgs = messages.filter(m => m.role !== 'system');
  const lastUserMsg = nonSystemMsgs.filter(m => m.role === 'user').pop();
  const userPrompt = extractText(lastUserMsg?.content);

  // Build prompt: system messages + user question.
  // No anti-tool injection — Composer ignores it (tool calling is architectural)
  // and it leaks into extracted text as garbage.
  const promptParts = [];

  if (systemMsgs.length > 0) {
    for (const msg of systemMsgs) {
      promptParts.push(extractText(msg.content));
    }
  }

  promptParts.push(userPrompt);

  const prompt = promptParts.join('\n\n');

  const historyMsgs = nonSystemMsgs.slice(0, -1);
  let context = '';
  if (historyMsgs.length > 0) {
    context = historyMsgs
      .map(m => `${m.role}: ${extractText(m.content)}`)
      .join('\n');
  }

  const { payload } = buildProtobufRequest(prompt, effectiveModel, context);
  const frame = createFrame(payload);

  const client = http2.connect(`https://${AGENT_BASE}`);

  let responseData = Buffer.alloc(0);
  let lastDataTime = Date.now();
  let ended = false;
  let responseContentType = '';

  const finish = (source) => {
    if (ended) return;
    ended = true;
    clearInterval(idleCheck);
    console.log(`  [${source}] Response: ${responseData.length} bytes, Content-Type: ${responseContentType}`);
    const result = extractTextFromResponse(responseData, prompt);
    if (result.error) {
      console.log(`  [ERROR] ${result.error.status}: ${result.error.body?.error?.message || 'Unknown'}`);
      const err = new Error(result.error.body?.error?.message || 'Cursor API error');
      err.status = result.error.status;
      err.body = result.error.body;
      onError(err);
      try { client.close(); } catch (_) {}
      return;
    }
    const text = result.text;
    console.log(`  Extracted text (${text.length} chars): "${text.substring(0, 150)}${text.length > 150 ? '...' : ''}"`);
    if (text) onData(text);
    onEnd();
    try { client.close(); } catch (_) {}
  };

  client.on('error', (err) => {
    console.error('  HTTP/2 client error:', err.message);
    if (!ended) {
      ended = true;
      clearInterval(idleCheck);
      onError(err);
      try { client.close(); } catch (_) {}
    }
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
      finish('idle');
    }
  }, 500);

  stream.on('response', (headers) => {
    responseContentType = headers['content-type'] || '';
    console.log(`  Cursor API status: ${headers[':status']} content-type: ${responseContentType}`);
    if (headers[':status'] !== 200) {
      if (!ended) {
        ended = true;
        clearInterval(idleCheck);
        onError(new Error(`HTTP ${headers[':status']}`));
        try { client.close(); } catch (_) {}
      }
    }
  });

  stream.on('data', (chunk) => {
    lastDataTime = Date.now();
    responseData = Buffer.concat([responseData, chunk]);
  });

  stream.on('end', () => {
    finish('stream-end');
  });

  stream.on('error', (err) => {
    if (!ended) {
      ended = true;
      clearInterval(idleCheck);
      onError(err);
      try { client.close(); } catch (_) {}
    }
  });

  stream.write(frame);
  stream.end();

  setTimeout(() => {
    finish('hard-timeout');
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
        const status = err.status || 502;
        const body = err.body || { error: { message: err.message, type: "upstream_error" } };
        console.error(`  Stream error (${status}):`, err.message);
        try {
          if (!res.writableEnded) {
            if (!res.headersSent) {
              res.writeHead(status, { "Content-Type": "application/json" });
              res.end(JSON.stringify(body));
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
        const status = err.status || 502;
        const body = err.body || { error: { message: err.message, type: "upstream_error" } };
        console.error(`  Error (${status}):`, err.message);
        try {
          if (!res.writableEnded) {
            if (!res.headersSent) {
              res.writeHead(status, { "Content-Type": "application/json" });
            }
            res.end(JSON.stringify(body));
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
server.listen(PORT, async () => {
  // Prefetch Cursor model list for routing decisions
  if (cursorAvailable) {
    try {
      const models = await getCursorModels();
      cursorModelIds = new Set(models.map(m => m.id.toLowerCase()));
      console.log(`  Cached ${cursorModelIds.size} Cursor models`);
    } catch (err) {
      console.error(`  Failed to cache Cursor models: ${err.message}`);
    }
  }
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
