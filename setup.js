#!/usr/bin/env node

/**
 * Knotie Relay Bridge — Post-install setup script
 *
 * Safely merges relay plugin config into ~/.openclaw/settings.json.
 * Reads existing settings, injects plugin entry with defaults (or user-provided
 * values), and writes back — never clobbering existing keys.
 *
 * Usage:
 *   node setup.js                                           # interactive prompts
 *   node setup.js --url wss://relay.example.com/bot --token sk-relay-bot-xxx
 *   node setup.js --settings /custom/path/settings.json     # custom settings path
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

const PLUGIN_ID = 'knotie-relay-bridge';

// ─── Argument parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--url' && argv[i + 1]) args.url = argv[++i];
    else if (argv[i] === '--token' && argv[i + 1]) args.token = argv[++i];
    else if (argv[i] === '--gateway-url' && argv[i + 1]) args.gatewayUrl = argv[++i];
    else if (argv[i] === '--agent-id' && argv[i + 1]) args.agentId = argv[++i];
    else if (argv[i] === '--settings' && argv[i + 1]) args.settingsPath = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(`
Knotie Relay Bridge — Setup

Usage:
  node setup.js [options]

Options:
  --url <wss://...>       Relay server WebSocket URL (required)
  --token <sk-relay-...>  Bot token from relay admin API (required)
  --gateway-url <ws://..> Local gateway URL (default: ws://127.0.0.1:18789)
  --agent-id <id>         Gateway agent ID (default: main)
  --settings <path>       Path to settings.json (default: ~/.openclaw/settings.json)
  --help, -h              Show this help

Examples:
  node setup.js --url wss://relay.example.com/bot --token sk-relay-bot-abc123
  node setup.js  # will prompt interactively
`);
      process.exit(0);
    }
  }
  return args;
}

// ─── Interactive prompts ─────────────────────────────────────────────────────

function prompt(rl, question, defaultValue) {
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

async function promptForConfig(args) {
  if (args.url && args.token) return args;

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n  Knotie Relay Bridge — Setup\n');
  console.log('  This will add the relay plugin config to your OpenClaw settings.\n');

  const url = args.url || await prompt(rl, '  Relay server WebSocket URL', 'wss://relay.yourdomain.com/bot');
  const token = args.token || await prompt(rl, '  Bot token (from relay admin API)', '');
  const gatewayUrl = args.gatewayUrl || await prompt(rl, '  Local gateway URL', 'ws://127.0.0.1:18789');
  const agentId = args.agentId || await prompt(rl, '  Gateway agent ID', 'main');

  rl.close();

  if (!url || !token) {
    console.error('\n  Error: Both --url and --token are required.\n');
    process.exit(1);
  }

  return { ...args, url, token, gatewayUrl, agentId };
}

// ─── Settings merge ──────────────────────────────────────────────────────────

function resolveSettingsPath(custom) {
  if (custom) return custom;
  return join(homedir(), '.openclaw', 'settings.json');
}

function readSettings(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    console.error(`  Error reading ${path}: ${err.message}`);
    process.exit(1);
  }
}

function mergePluginConfig(settings, config) {
  // Ensure plugins structure exists
  if (!settings.plugins) settings.plugins = {};
  if (!settings.plugins.allow) settings.plugins.allow = [];
  if (!settings.plugins.entries) settings.plugins.entries = {};

  // Add to allow list if not already present
  if (!settings.plugins.allow.includes(PLUGIN_ID)) {
    settings.plugins.allow.push(PLUGIN_ID);
  }

  // Build the plugin config
  const pluginConfig = {
    enabled: true,
    config: {
      bridge: {
        url: config.url,
        token: config.token,
        promptTimeoutMs: 300000,
        reconnectBaseMs: 1000,
        reconnectMaxMs: 60000,
      },
      gateway: {
        url: config.gatewayUrl || 'ws://127.0.0.1:18789',
        agentId: config.agentId || 'main',
      },
      log: {
        verbose: false,
      },
    },
  };

  // Merge — preserve any existing user overrides
  const existing = settings.plugins.entries[PLUGIN_ID];
  if (existing) {
    // Only update bridge url/token if provided, keep other user customizations
    const merged = { ...existing };
    if (!merged.config) merged.config = {};
    if (!merged.config.bridge) merged.config.bridge = {};
    merged.config.bridge.url = config.url || merged.config.bridge.url;
    merged.config.bridge.token = config.token || merged.config.bridge.token;
    if (!merged.config.bridge.promptTimeoutMs) merged.config.bridge.promptTimeoutMs = 300000;
    if (!merged.config.bridge.reconnectBaseMs) merged.config.bridge.reconnectBaseMs = 1000;
    if (!merged.config.bridge.reconnectMaxMs) merged.config.bridge.reconnectMaxMs = 60000;
    if (!merged.config.gateway) {
      merged.config.gateway = pluginConfig.config.gateway;
    }
    if (!merged.config.log) {
      merged.config.log = pluginConfig.config.log;
    }
    merged.enabled = true;
    settings.plugins.entries[PLUGIN_ID] = merged;
  } else {
    settings.plugins.entries[PLUGIN_ID] = pluginConfig;
  }

  return settings;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const config = await promptForConfig(args);
  const settingsPath = resolveSettingsPath(args.settingsPath);

  console.log(`\n  Reading ${settingsPath}...`);
  const settings = readSettings(settingsPath);

  const updated = mergePluginConfig(settings, config);

  writeFileSync(settingsPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');

  console.log(`  Config written to ${settingsPath}\n`);
  console.log('  Plugin config added:');
  console.log(`    plugins.allow: [..., "${PLUGIN_ID}"]`);
  console.log(`    plugins.entries.${PLUGIN_ID}.enabled: true`);
  console.log(`    bridge.url:   ${config.url}`);
  console.log(`    bridge.token: ${config.token.slice(0, 15)}...`);
  console.log(`    gateway.url:  ${config.gatewayUrl || 'ws://127.0.0.1:18789'}`);
  console.log(`    agent ID:     ${config.agentId || 'main'}`);
  console.log('\n  Done! Restart OpenClaw for changes to take effect.\n');
}

main().catch((err) => {
  console.error(`Setup failed: ${err.message}`);
  process.exit(1);
});
