/**
 * BridgeClient
 *
 * Maintains a persistent WebSocket connection to the relay server's /bot endpoint.
 * When a prompt arrives from the relay, it:
 *   1. Opens (or reuses) a session on the local OpenClaw gateway via GatewayClient
 *   2. Forwards the prompt to the gateway
 *   3. Streams the response chunks back to the relay (with the original sessionId)
 *
 * Reconnects automatically using exponential back-off.
 */

import WebSocket from 'ws';

export class BridgeClient {
  /**
   * @param {object} opts
   * @param {string} opts.url              - Relay server WS URL (e.g. wss://relay.example.com/bot)
   * @param {string} opts.token            - Bot token for this tenant
   * @param {number} opts.promptTimeoutMs  - Max ms to wait for a prompt response
   * @param {number} opts.reconnectBaseMs  - Initial reconnect delay
   * @param {number} opts.reconnectMaxMs   - Max reconnect delay
   * @param {boolean} opts.verbose
   * @param {import('./gateway-client.js').GatewayClient} opts.gateway
   * @param {Function} [opts.onStatusChange] - Called with status updates for the plugin
   */
  constructor(opts) {
    this.url             = opts.url;
    this.token           = opts.token;
    this.promptTimeoutMs = opts.promptTimeoutMs || 300000;
    this.reconnectBase   = opts.reconnectBaseMs  || 1000;
    this.reconnectMax    = opts.reconnectMaxMs   || 60000;
    this.verbose         = opts.verbose || false;
    this.gateway         = opts.gateway;
    this.onStatusChange  = opts.onStatusChange || (() => {});

    this.ws              = null;
    this.reconnectDelay  = this.reconnectBase;
    this.stopped         = false;
    this._reconnTimer    = null;

    // Track connection state for status reporting
    this.connected       = false;
    this.tenantId        = null;
    this.tenantName      = null;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    if (this._reconnTimer) clearTimeout(this._reconnTimer);
    if (this.ws) this.ws.close(1000, 'Stopped');
    this.connected = false;
    this.onStatusChange('disconnected');
  }

  getStatus() {
    return {
      connected: this.connected,
      relayUrl: this.url,
      tenantId: this.tenantId,
      tenantName: this.tenantName,
    };
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _connect() {
    const wsUrl = `${this.url}?token=${encodeURIComponent(this.token)}`;
    this.log(`Connecting to relay: ${this.url}`);

    this.ws = new WebSocket(wsUrl, {
      handshakeTimeout: 10000,
      headers: { 'User-Agent': 'knotie-relay-plugin/1.0' },
    });

    this.ws.on('open', () => {
      this.log('Connected to relay server');
      this.reconnectDelay = this.reconnectBase;
      this.connected = true;
      this.onStatusChange('connected');
    });

    this.ws.on('message', (raw) => this._onMessage(raw));

    this.ws.on('close', (code, reason) => {
      this.log(`Relay WS closed: code=${code} reason=${reason}`);
      this.ws = null;
      this.connected = false;
      this.onStatusChange('disconnected');
      if (!this.stopped) this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.log(`Relay WS error: ${err.message}`);
    });
  }

  _scheduleReconnect() {
    this.log(`Reconnecting in ${this.reconnectDelay}ms…`);
    this.onStatusChange('reconnecting');
    this._reconnTimer = setTimeout(() => {
      this._connect();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectMax);
    }, this.reconnectDelay);
  }

  async _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { this.log('Received non-JSON message, ignoring'); return; }

    this.verbose && console.log('[Bridge] ← relay:', JSON.stringify(msg).slice(0, 200));

    switch (msg.type) {
      case 'registered':
        this.tenantId = msg.tenantId;
        this.tenantName = msg.tenantName;
        console.log(`[Bridge] Registered as bot for tenant: ${msg.tenantId} (${msg.tenantName})`);
        this.onStatusChange('registered');
        break;

      case 'prompt':
        await this._handlePrompt(msg);
        break;

      case 'session_end':
        this.log(`Session ended by relay: ${msg.sessionId}`);
        this.gateway.closeSession(msg.sessionId);
        break;

      case 'error':
        console.error(`[Bridge] Relay error: [${msg.code}] ${msg.message}`);
        break;

      default:
        this.verbose && this.log(`Unhandled relay message type: ${msg.type}`);
    }
  }

  async _handlePrompt(msg) {
    const { sessionId, tenantId, content, role, metadata } = msg;

    this.log(`Prompt received: session=${sessionId} content="${String(content).slice(0, 80)}"`);

    // Send typing indicator back to browser
    this._sendToRelay({ type: 'typing', sessionId, tenantId });

    try {
      await this.gateway.sendPrompt({
        sessionId,
        content,
        role: role || 'user',
        metadata: metadata || {},
        onChunk: (chunk) => {
          this._sendToRelay({ type: 'chunk', sessionId, tenantId, content: chunk });
        },
        onDone: (finalContent) => {
          this._sendToRelay({ type: 'done', sessionId, tenantId, content: finalContent });
        },
        onError: (errMsg) => {
          this._sendToRelay({ type: 'error', sessionId, tenantId, code: 'GATEWAY_ERROR', message: errMsg });
        },
        timeoutMs: this.promptTimeoutMs,
      });
    } catch (err) {
      console.error(`[Bridge] Unhandled prompt error (session=${sessionId}):`, err.message);
      this._sendToRelay({
        type: 'error',
        sessionId,
        tenantId,
        code: 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  }

  _sendToRelay(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.verbose && console.log('[Bridge] → relay:', JSON.stringify(msg).slice(0, 200));
      this.ws.send(JSON.stringify(msg));
    } else {
      this.log(`Cannot send to relay (not connected): ${msg.type}`);
    }
  }

  log(msg) {
    console.log(`[Bridge] ${msg}`);
  }
}
