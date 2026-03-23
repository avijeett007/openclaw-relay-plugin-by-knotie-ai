/**
 * Knotie Relay Bridge Plugin for OpenClaw — Entry Point
 *
 * Native OpenClaw plugin by Knotie AI that connects this instance to a remote
 * relay server, enabling whitelabel browser and voice clients to reach local
 * AI agents via WebSocket.
 *
 * Install:
 *   openclaw plugins install @knotie/openclaw-relay-plugin
 *
 * Data flow:
 *   Browser / Voice Client  <── WS /chat ──>  Knotie Relay Server  <── WS /bot ──>  This Plugin  <── ACP WS ──>  Local OpenClaw Gateway
 *
 * Learn more: https://knotie.ai
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import { BridgeClient } from './bridge-client.js';
import { GatewayClient } from './gateway-client.js';

/** @type {BridgeClient|null} */
let bridge = null;
/** @type {GatewayClient|null} */
let gateway = null;

export default definePluginEntry({
  id: "@knotie/openclaw-relay-plugin",
  name: "Knotie Relay Bridge",
  description: "Multi-tenant relay bridge by Knotie AI — connects your OpenClaw instance to a remote relay server, enabling whitelabel browser and voice clients to reach local AI agents via WebSocket",

  register(api) {
    const config = api.getConfig();

    // Validate required bridge config
    if (!config.bridge?.url || !config.bridge?.token) {
      console.error('[Knotie Relay] Missing required config: bridge.url and bridge.token');
      return;
    }

    const bridgeConfig = config.bridge;
    const gatewayConfig = config.gateway || {};
    const logConfig = config.log || {};

    // ─── Startup Hook: initialize bridge + gateway on plugin load ──────────

    api.registerHook('startup', async () => {
      console.log('[Knotie Relay] Starting relay bridge...');
      console.log(`[Knotie Relay] Relay   : ${bridgeConfig.url}`);
      console.log(`[Knotie Relay] Gateway : ${gatewayConfig.url || 'ws://127.0.0.1:18789'} (agent: ${gatewayConfig.agentId || 'main'})`);

      gateway = new GatewayClient({
        url: gatewayConfig.url || 'ws://127.0.0.1:18789',
        agentId: gatewayConfig.agentId || 'main',
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
          console.log(`[Knotie Relay] Bridge status: ${status}`);
        },
      });

      bridge.start();
      console.log('[Knotie Relay] Relay bridge started');
    });

    // ─── Shutdown Hook: clean up on plugin unload ──────────────────────────

    api.registerHook('shutdown', async () => {
      console.log('[Knotie Relay] Shutting down relay bridge...');
      if (bridge) bridge.stop();
      if (gateway) gateway.closeAll();
      bridge = null;
      gateway = null;
      console.log('[Knotie Relay] Relay bridge stopped');
    });

    // ─── Agent Tool: knotie_relay_status ─────────────────────────────────

    api.registerTool({
      name: 'knotie_relay_status',
      description: 'Check the Knotie relay bridge connection status, including whether the bridge is connected to the relay server and which tenant it is registered as.',
      parameters: Type.Object({}),
      async execute() {
        if (!bridge) {
          return {
            content: [{ type: 'text', text: 'Knotie relay bridge is not running.' }],
          };
        }

        const status = bridge.getStatus();
        const lines = [
          `Connected: ${status.connected ? 'Yes' : 'No'}`,
          `Relay URL: ${status.relayUrl}`,
          status.tenantId ? `Tenant: ${status.tenantName} (${status.tenantId})` : 'Tenant: Not registered yet',
        ];

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
        };
      },
    });

    // ─── Agent Tool: knotie_relay_reconnect ──────────────────────────────

    api.registerTool({
      name: 'knotie_relay_reconnect',
      description: 'Force the Knotie relay bridge to disconnect and reconnect to the relay server.',
      parameters: Type.Object({}),
      async execute() {
        if (!bridge) {
          return {
            content: [{ type: 'text', text: 'Knotie relay bridge is not running.' }],
          };
        }

        bridge.stop();
        bridge.start();
        return {
          content: [{ type: 'text', text: 'Knotie relay bridge reconnecting...' }],
        };
      },
    });

    // ─── CLI Subcommand: openclaw knotie-relay-status ──────────────────────

    api.registerCli({
      command: 'knotie-relay-status',
      description: 'Show the current Knotie relay bridge connection status',
      handler() {
        if (!bridge) {
          console.log('Knotie relay bridge is not running.');
          return;
        }

        const status = bridge.getStatus();
        console.log('Knotie Relay Bridge Status:');
        console.log(`  Connected : ${status.connected ? 'Yes' : 'No'}`);
        console.log(`  Relay URL : ${status.relayUrl}`);
        if (status.tenantId) {
          console.log(`  Tenant    : ${status.tenantName} (${status.tenantId})`);
        } else {
          console.log('  Tenant    : Not registered yet');
        }
      },
    });

    api.registerCli({
      command: 'knotie-relay-reconnect',
      description: 'Force the Knotie relay bridge to reconnect',
      handler() {
        if (!bridge) {
          console.log('Knotie relay bridge is not running.');
          return;
        }

        bridge.stop();
        bridge.start();
        console.log('Knotie relay bridge reconnecting...');
      },
    });
  },
});
