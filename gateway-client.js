/**
 * GatewayClient
 *
 * Manages a WebSocket connection to the local OpenClaw gateway (default: ws://127.0.0.1:18789).
 *
 * OpenClaw uses ACP (Agent Communication Protocol) — a JSON-RPC 2.0 style protocol
 * over WebSocket. Each relay sessionId maps to an OpenClaw session key so multiple
 * browser sessions can coexist on the same gateway.
 *
 * ACP message format (outbound to gateway):
 *   { jsonrpc: "2.0", method: "prompt", params: { sessionKey, agentId, role, content }, id }
 *
 * ACP message format (inbound from gateway):
 *   { jsonrpc: "2.0", result: { type, content, done }, id }           ← response
 *   { jsonrpc: "2.0", method: "stream_chunk", params: { sessionKey, content } } ← stream
 *
 * The client maintains a SINGLE persistent WebSocket to the gateway and multiplexes
 * all sessions over it.
 */

import WebSocket from 'ws';

const GATEWAY_CONNECT_TIMEOUT = 10000;

export class GatewayClient {
  /**
   * @param {object} opts
   * @param {string}  opts.url      - OpenClaw gateway WS URL
   * @param {string}  opts.agentId  - Agent ID to target in gateway (e.g. "main")
   * @param {boolean} opts.verbose
   */
  constructor(opts) {
    this.url     = opts.url     || 'ws://127.0.0.1:18789';
    this.agentId = opts.agentId || 'main';
    this.verbose = opts.verbose || false;

    /** @type {WebSocket|null} */
    this.ws = null;

    /** pending JSON-RPC calls: requestId → { resolve, reject, timeoutHandle } */
    this._pending = new Map();

    /** active streaming sessions: sessionKey → { onChunk, onDone, onError } */
    this._streaming = new Map();

    /** relay sessionId → gateway sessionKey */
    this._sessionMap = new Map();

    this._connectPromise = null;
    this._rpcId = 1;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Send a prompt to the gateway, streaming back responses via callbacks.
   *
   * @param {object}   opts
   * @param {string}   opts.sessionId    - relay session ID (browser session)
   * @param {string}   opts.content      - user message text
   * @param {string}   opts.role         - 'user' | 'assistant' | 'system'
   * @param {object}   opts.metadata     - extra metadata to pass through
   * @param {Function} opts.onChunk      - called with each streaming chunk (string)
   * @param {Function} opts.onDone       - called with final content (string) when done
   * @param {Function} opts.onError      - called with error message (string)
   * @param {number}   opts.timeoutMs    - max wait for response
   */
  async sendPrompt(opts) {
    const { sessionId, content, role, metadata, onChunk, onDone, onError, timeoutMs } = opts;

    // Map relay session → gateway session key (persistent per session)
    if (!this._sessionMap.has(sessionId)) {
      this._sessionMap.set(sessionId, `acp:relay:${sessionId}`);
    }
    const sessionKey = this._sessionMap.get(sessionId);

    this.verbose && console.log(`[Gateway] sendPrompt session=${sessionKey}`);

    // Ensure connected
    try {
      await this._ensureConnected();
    } catch (err) {
      onError(`Gateway not available: ${err.message}`);
      return;
    }

    // Register streaming handlers for this session
    this._streaming.set(sessionKey, { onChunk, onDone, onError });

    // Build ACP JSON-RPC request
    const id = this._rpcId++;
    const request = {
      jsonrpc: '2.0',
      method: 'prompt',
      params: {
        sessionKey,
        agentId: this.agentId,
        role: role || 'user',
        content,
        metadata: metadata || {},
        stream: true,
      },
      id,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        this._streaming.delete(sessionKey);
        const msg = `Gateway prompt timeout after ${timeoutMs}ms`;
        onError(msg);
        reject(new Error(msg));
      }, timeoutMs || 300000);

      this._pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
        sessionKey,
      });

      this.ws.send(JSON.stringify(request));
      this.verbose && console.log('[Gateway] → sent prompt RPC id=' + id);
    });
  }

  /** Close a specific relay session's gateway session. */
  closeSession(relaySessionId) {
    const sessionKey = this._sessionMap.get(relaySessionId);
    if (sessionKey) {
      this._streaming.delete(sessionKey);
      this._sessionMap.delete(relaySessionId);
      if (this.ws?.readyState === WebSocket.OPEN) {
        const notification = {
          jsonrpc: '2.0',
          method: 'session_end',
          params: { sessionKey, agentId: this.agentId },
        };
        this.ws.send(JSON.stringify(notification));
      }
    }
  }

  /** Close all sessions and the gateway connection. */
  closeAll() {
    this._streaming.clear();
    this._sessionMap.clear();
    for (const { reject } of this._pending.values()) {
      reject(new Error('Gateway client shutting down'));
    }
    this._pending.clear();
    if (this.ws) {
      this.ws.close(1000, 'Shutdown');
      this.ws = null;
    }
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  _ensureConnected() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = new Promise((resolve, reject) => {
      console.log(`[Gateway] Connecting to ${this.url}`);
      const ws = new WebSocket(this.url, { handshakeTimeout: GATEWAY_CONNECT_TIMEOUT });

      const timeout = setTimeout(() => {
        ws.terminate();
        this._connectPromise = null;
        reject(new Error('Gateway connection timeout'));
      }, GATEWAY_CONNECT_TIMEOUT);

      ws.on('open', () => {
        clearTimeout(timeout);
        console.log('[Gateway] Connected');
        this.ws = ws;
        this._connectPromise = null;
        resolve();
      });

      ws.on('message', (raw) => this._onGatewayMessage(raw));

      ws.on('close', (code, reason) => {
        console.log(`[Gateway] Disconnected: code=${code} reason=${reason}`);
        this.ws = null;
        this._connectPromise = null;
        for (const { reject: rej, sessionKey } of this._pending.values()) {
          rej(new Error('Gateway disconnected'));
          if (sessionKey) {
            const handlers = this._streaming.get(sessionKey);
            handlers?.onError?.('Gateway disconnected unexpectedly');
            this._streaming.delete(sessionKey);
          }
        }
        this._pending.clear();
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        console.error('[Gateway] WS error:', err.message);
        this._connectPromise = null;
        reject(err);
      });
    });

    return this._connectPromise;
  }

  _onGatewayMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { this.verbose && console.log('[Gateway] Non-JSON message, ignoring'); return; }

    this.verbose && console.log('[Gateway] ←', JSON.stringify(msg).slice(0, 300));

    // ── Streaming chunk (notification, no id) ────────────────────────────────
    if (msg.method === 'stream_chunk' && msg.params) {
      const { sessionKey, content } = msg.params;
      const handlers = this._streaming.get(sessionKey);
      if (handlers) {
        handlers.onChunk(content);
      }
      return;
    }

    // ── JSON-RPC response (has id) ───────────────────────────────────────────
    if (msg.id != null) {
      const pending = this._pending.get(msg.id);
      if (!pending) return;

      this._pending.delete(msg.id);
      const handlers = this._streaming.get(pending.sessionKey);

      if (msg.error) {
        const errMsg = msg.error.message || 'Gateway RPC error';
        handlers?.onError?.(errMsg);
        pending.reject(new Error(errMsg));
        this._streaming.delete(pending.sessionKey);
        return;
      }

      const result = msg.result || {};
      if (result.content) {
        handlers?.onDone?.(result.content);
      } else if (result.done) {
        handlers?.onDone?.('');
      }

      this._streaming.delete(pending.sessionKey);
      pending.resolve(result);
      return;
    }

    // ── Gateway notifications (method, no id) ────────────────────────────────
    if (msg.method) {
      switch (msg.method) {
        case 'agent_message': {
          const { sessionKey, content, done } = msg.params || {};
          const handlers = this._streaming.get(sessionKey);
          if (handlers) {
            if (done) {
              handlers.onDone(content || '');
              this._streaming.delete(sessionKey);
              for (const [rpcId, pending] of this._pending.entries()) {
                if (pending.sessionKey === sessionKey) {
                  this._pending.delete(rpcId);
                  pending.resolve({ content, done });
                }
              }
            } else {
              handlers.onChunk(content || '');
            }
          }
          break;
        }
        default:
          this.verbose && console.log(`[Gateway] Unhandled notification method: ${msg.method}`);
      }
    }
  }
}
