/**
 * GatewayClient
 *
 * Connects to the local OpenClaw gateway (default: ws://127.0.0.1:18789)
 * using the Gateway WebSocket Protocol (NOT JSON-RPC).
 *
 * Protocol flow:
 *   1. Open WebSocket
 *   2. Receive connect.challenge {nonce, ts} from gateway
 *   3. Send connect request with auth token + signed device identity
 *   4. Receive hello-ok → connection ready
 *   5. Send chat.send requests, receive chat events for streamed responses
 *
 * Frame format:
 *   Request:  { type: "req", id, method, params }
 *   Response: { type: "res", id, ok, payload | error }
 *   Event:    { type: "event", event, payload }
 */

import WebSocket from 'ws';
import crypto from 'node:crypto';

const GATEWAY_CONNECT_TIMEOUT = 15000;

export class GatewayClient {
  /**
   * @param {object} opts
   * @param {string}  opts.url        - OpenClaw gateway WS URL
   * @param {string}  opts.agentId    - Agent ID to target in gateway (e.g. "main")
   * @param {string}  [opts.token]    - Gateway auth token (OPENCLAW_GATEWAY_TOKEN)
   * @param {boolean} [opts.skipDeviceAuth] - Skip device auth (for dangerouslyDisableDeviceAuth gateways)
   * @param {boolean} opts.verbose
   */
  constructor(opts) {
    this.url     = opts.url     || 'ws://127.0.0.1:18789';
    this.agentId = opts.agentId || 'main';
    this.token   = opts.token   || process.env.OPENCLAW_GATEWAY_TOKEN || '';
    this.verbose = opts.verbose || false;
    this.skipDeviceAuth = opts.skipDeviceAuth || false;

    /** @type {WebSocket|null} */
    this.ws = null;
    this.connected = false;

    /** pending requests: id → { resolve, reject, timeoutHandle } */
    this._pending = new Map();

    /** active chat sessions: sessionKey → { onChunk, onDone, onError } */
    this._chatSessions = new Map();

    /** relay sessionId → gateway sessionKey */
    this._sessionMap = new Map();

    this._connectPromise = null;
    this._reqId = 1;

    // Generate Ed25519 device keypair unless device auth is skipped
    this._deviceKeyPair = this.skipDeviceAuth ? null : crypto.generateKeyPairSync('ed25519');
    if (this._deviceKeyPair) {
      const spkiDer = this._deviceKeyPair.publicKey.export({ type: 'spki', format: 'der' });
      const rawPublicKey = spkiDer.subarray(spkiDer.length - 32);
      this._devicePublicKeyB64 = rawPublicKey.toString('base64');
      this._deviceId = crypto.createHash('sha256')
        .update(rawPublicKey)
        .digest('hex');
    } else {
      this._devicePublicKeyB64 = null;
      this._deviceId = null;
    }
    this._rawPublicKey = rawPublicKey;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Send a prompt to the gateway via chat.send, streaming responses via callbacks.
   */
  async sendPrompt(opts) {
    const { sessionId, content, role, metadata, onChunk, onDone, onError, timeoutMs } = opts;

    // Map relay session → gateway session key
    if (!this._sessionMap.has(sessionId)) {
      this._sessionMap.set(sessionId, `relay:${sessionId}`);
    }
    const sessionKey = this._sessionMap.get(sessionId);

    this.verbose && console.log(`[Gateway] sendPrompt session=${sessionKey}`);

    try {
      await this._ensureConnected();
    } catch (err) {
      onError(`Gateway not available: ${err.message}`);
      return;
    }

    // Register chat session handlers for streaming events
    this._chatSessions.set(sessionKey, { onChunk, onDone, onError });

    // Send chat.send request
    const text = role === 'system' ? `/system ${content}` : content;

    try {
      const result = await this._sendRequest('chat.send', {
        sessionKey,
        text,
        idempotencyKey: crypto.randomUUID(),
      }, timeoutMs || 300000);

      this.verbose && console.log('[Gateway] chat.send ack:', JSON.stringify(result).slice(0, 200));
      // chat.send is non-blocking — it acks immediately, response streams via chat events
    } catch (err) {
      this._chatSessions.delete(sessionKey);
      onError(`Gateway chat.send failed: ${err.message}`);
    }
  }

  /** Close a specific relay session. */
  closeSession(relaySessionId) {
    const sessionKey = this._sessionMap.get(relaySessionId);
    if (sessionKey) {
      this._chatSessions.delete(sessionKey);
      this._sessionMap.delete(relaySessionId);
    }
  }

  /** Close all sessions and the gateway connection. */
  closeAll() {
    this._chatSessions.clear();
    this._sessionMap.clear();
    for (const { reject } of this._pending.values()) {
      reject(new Error('Gateway client shutting down'));
    }
    this._pending.clear();
    if (this.ws) {
      this.ws.close(1000, 'Shutdown');
      this.ws = null;
    }
    this.connected = false;
  }

  // ─── Internal: Connection + Handshake ───────────────────────────────────────

  _ensureConnected() {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
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
        this.verbose && console.log('[Gateway] WebSocket open, waiting for connect.challenge...');
        // Don't resolve yet — wait for handshake to complete
      });

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); }
        catch { return; }

        this.verbose && console.log('[Gateway] ←', JSON.stringify(msg).slice(0, 300));

        // Handle connect.challenge → send connect request
        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          this._handleChallenge(ws, msg.payload, resolve, reject, timeout);
          return;
        }

        // Handle hello-ok response
        if (msg.type === 'res' && msg.id === 'connect-1') {
          clearTimeout(timeout);
          if (msg.ok && msg.payload?.type === 'hello-ok') {
            console.log('[Gateway] Connected (protocol ' + msg.payload.protocol + ')');
            this.ws = ws;
            this.connected = true;
            this._connectPromise = null;

            // Re-attach the full message handler
            ws.removeAllListeners('message');
            ws.on('message', (raw2) => this._onMessage(raw2));
            ws.on('close', (code, reason) => this._onClose(code, reason));
            ws.on('error', (err) => console.error('[Gateway] WS error:', err.message));

            resolve();
          } else {
            const errMsg = msg.error?.message || 'Gateway connect rejected';
            console.error(`[Gateway] Connect failed: ${errMsg}`);
            ws.close();
            this._connectPromise = null;
            reject(new Error(errMsg));
          }
          return;
        }
      });

      ws.on('close', (code, reason) => {
        clearTimeout(timeout);
        this._connectPromise = null;
        reject(new Error(`Gateway closed during handshake: code=${code} reason=${reason}`));
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

  _handleChallenge(ws, challenge, resolve, reject, timeout) {
    const { nonce, ts } = challenge;

    this.verbose && console.log(`[Gateway] Received challenge nonce=${nonce}`);

    const signedAt = Date.now();

    // Build connect params
    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'cli',
        version: '1.0.0',
        platform: 'linux',
        mode: 'cli',
      },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      caps: [],
      commands: [],
      permissions: {},
      auth: { token: this.token },
      locale: 'en-US',
      userAgent: 'cli/1.0.0',
    };

    // Include device identity with Ed25519 signature if we have a keypair.
    // If gateway has dangerouslyDisableDeviceAuth=true, the device field
    // can be omitted for localhost connections.
    if (this._deviceKeyPair) {
      // Sign the v2 payload
      const signPayload = JSON.stringify({
        version: 'v2',
        deviceId: this._deviceId,
        publicKey: this._devicePublicKeyB64,
        clientId: 'cli',
        role: 'operator',
        scopes: ['operator.read', 'operator.write'],
        token: this.token,
        nonce,
        signedAt,
      });

      const signature = crypto.sign(null, Buffer.from(signPayload), this._deviceKeyPair.privateKey)
        .toString('base64');

      params.device = {
        id: this._deviceId,
        publicKey: this._devicePublicKeyB64,
        signature,
        signedAt,
        nonce,
      };
    }

    const connectReq = {
      type: 'req',
      id: 'connect-1',
      method: 'connect',
      params,
    };

    this.verbose && console.log('[Gateway] → connect request');
    ws.send(JSON.stringify(connectReq));
  }

  // ─── Internal: Message Handling ─────────────────────────────────────────────

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return; }

    this.verbose && console.log('[Gateway] ←', JSON.stringify(msg).slice(0, 300));

    // Response to a pending request
    if (msg.type === 'res' && msg.id != null) {
      const pending = this._pending.get(msg.id);
      if (pending) {
        this._pending.delete(msg.id);
        clearTimeout(pending.timeoutHandle);
        if (msg.ok) {
          pending.resolve(msg.payload);
        } else {
          pending.reject(new Error(msg.error?.message || 'Gateway request failed'));
        }
      }
      return;
    }

    // Chat events (streamed response chunks)
    if (msg.type === 'event' && msg.event === 'chat') {
      this._handleChatEvent(msg.payload);
      return;
    }

    // Tick keepalive — respond if needed
    if (msg.type === 'event' && msg.event === 'tick') {
      return; // no-op
    }

    this.verbose && console.log(`[Gateway] Unhandled: ${msg.type}/${msg.event || msg.method || msg.id}`);
  }

  _handleChatEvent(payload) {
    if (!payload) return;

    const sessionKey = payload.sessionKey;
    const handlers = this._chatSessions.get(sessionKey);

    if (!handlers) {
      // Try matching by checking all sessions (fallback for 'main' session key mapping)
      // The gateway may use a different sessionKey than what we sent
      this.verbose && console.log(`[Gateway] Chat event for unknown session: ${sessionKey}`);
      return;
    }

    // Chat events contain streamed text chunks and completion signals
    if (payload.text || payload.content) {
      handlers.onChunk(payload.text || payload.content || '');
    }

    if (payload.done || payload.status === 'completed' || payload.status === 'ok') {
      const finalText = payload.finalText || payload.text || payload.content || '';
      handlers.onDone(finalText);
      this._chatSessions.delete(sessionKey);
    }

    if (payload.error) {
      handlers.onError(payload.error?.message || payload.error || 'Chat error');
      this._chatSessions.delete(sessionKey);
    }
  }

  _onClose(code, reason) {
    console.log(`[Gateway] Disconnected: code=${code} reason=${reason}`);
    this.ws = null;
    this.connected = false;
    this._connectPromise = null;

    // Fail all pending requests
    for (const { reject, timeoutHandle } of this._pending.values()) {
      clearTimeout(timeoutHandle);
      reject(new Error('Gateway disconnected'));
    }
    this._pending.clear();

    // Notify all active chat sessions
    for (const [key, handlers] of this._chatSessions.entries()) {
      handlers.onError('Gateway disconnected unexpectedly');
      this._chatSessions.delete(key);
    }
  }

  // ─── Internal: Request Helper ───────────────────────────────────────────────

  _sendRequest(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = `req-${this._reqId++}`;

      const timeoutHandle = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Gateway ${method} timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this._pending.set(id, { resolve, reject, timeoutHandle });

      const frame = { type: 'req', id, method, params };
      this.verbose && console.log(`[Gateway] → ${method} id=${id}`);
      this.ws.send(JSON.stringify(frame));
    });
  }
}
