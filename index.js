/**
 * Knotie Relay Bridge Plugin for OpenClaw — Entry Point
 *
 * Native OpenClaw plugin by Knotie AI that connects this instance to a remote
 * relay server, enabling whitelabel browser and voice clients to reach local
 * AI agents via WebSocket.
 *
 * Install:
 *   openclaw plugins install knotie-relay-bridge
 *
 * Data flow:
 *   Browser / Voice Client  <── WS /chat ──>  Knotie Relay Server  <── WS /bot ──>  This Plugin  <── ACP WS ──>  Local OpenClaw Gateway
 *
 * Learn more: https://knotie.ai
 */

import { BridgeClient } from './bridge-client.js';
import { GatewayClient } from './gateway-client.js';

/** @type {BridgeClient|null} */
let bridge = null;
/** @type {GatewayClient|null} */
let gateway = null;

export default {
  id: "knotie-relay-bridge",
  name: "Knotie Relay Bridge",
  description: "Multi-tenant relay bridge by Knotie AI — connects your OpenClaw instance to a remote relay server, enabling whitelabel browser and voice clients to reach local AI agents via WebSocket",

  register(api) {
    const config = api.pluginConfig || {};
    const log = api.logger;

    // Validate required bridge config
    if (!config.bridge?.url || !config.bridge?.token) {
      log.error('Missing required config: bridge.url and bridge.token. Run: node setup.js --url <relay-url> --token <bot-token>');
      return;
    }

    const bridgeConfig = config.bridge;
    const gatewayConfig = config.gateway || {};
    const logConfig = config.log || {};

    // ─── Service: manages bridge lifecycle (start/stop) ──────────────────

    api.registerService({
      id: 'knotie-relay-bridge',

      async start() {
        log.info('Starting relay bridge...');
        log.info(`Relay   : ${bridgeConfig.url}`);
        log.info(`Gateway : ${gatewayConfig.url || 'ws://127.0.0.1:18789'} (agent: ${gatewayConfig.agentId || 'main'})`);

        gateway = new GatewayClient({
          url: gatewayConfig.url || 'ws://127.0.0.1:18789',
          agentId: gatewayConfig.agentId || 'main',
          token: gatewayConfig.token || '',
          skipDeviceAuth: gatewayConfig.skipDeviceAuth || false,
          verbose: logConfig.verbose || false,
        });

        bridge = new BridgeClient({
          url: bridgeConfig.url,
          token: bridgeConfig.token,
          promptTimeoutMs: bridgeConfig.promptTimeoutMs || 300000,
          reconnectBaseMs: bridgeConfig.reconnectBaseMs || 1000,
          reconnectMaxMs: bridgeConfig.reconnectMaxMs || 60000,
          verbose: logConfig.verbose || false,
          gateway,
          onStatusChange: (status) => {
            log.info(`Bridge status: ${status}`);
          },
        });

        bridge.start();
        log.info('Relay bridge started');
      },

      async stop() {
        log.info('Shutting down relay bridge...');
        if (bridge) bridge.stop();
        if (gateway) gateway.closeAll();
        bridge = null;
        gateway = null;
        log.info('Relay bridge stopped');
      },
    });

    // ─── Command: /relay_status ──────────────────────────────────────────

    api.registerCommand({
      name: 'relay_status',
      description: 'Show the Knotie relay bridge connection status',
      handler() {
        if (!bridge) {
          return { text: 'Knotie relay bridge is not running.' };
        }

        const status = bridge.getStatus();
        const lines = [
          '**Knotie Relay Bridge Status**',
          `Connected: ${status.connected ? 'Yes' : 'No'}`,
          `Relay URL: ${status.relayUrl}`,
          status.tenantId
            ? `Tenant: ${status.tenantName} (${status.tenantId})`
            : 'Tenant: Not registered yet',
        ];

        return { text: lines.join('\n') };
      },
    });

    // ─── Command: /relay_reconnect ───────────────────────────────────────

    api.registerCommand({
      name: 'relay_reconnect',
      description: 'Force the Knotie relay bridge to reconnect',
      handler() {
        if (!bridge) {
          return { text: 'Knotie relay bridge is not running.' };
        }

        bridge.stop();
        bridge.start();
        return { text: 'Knotie relay bridge reconnecting...' };
      },
    });
  },
};
