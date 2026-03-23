# Knotie Relay Bridge for OpenClaw

**A native OpenClaw plugin by [Knotie AI](https://knotie.ai) that lets you serve AI agents to remote browser and voice clients over a multi-tenant WebSocket relay.**

---

## About Knotie

**Knotie enables agencies to sell AI agents — voice, chat, and now OpenClaw — to business users as a whitelabel service.**

Whether you're an agency building custom AI solutions, a consultancy deploying conversational agents, or a SaaS platform looking to embed AI capabilities — Knotie gives you the infrastructure to run, brand, and sell AI agents at scale. Each of your clients gets their own isolated tenant, their own branding, and their own agent — all managed through a single relay server you control.

This plugin is the bridge that connects your OpenClaw-powered agents to the outside world.

Learn more at **[knotie.ai](https://knotie.ai)**

---

## What This Plugin Does

```
Your Client's Browser / Voice UI
         |
         |  wss://relay.yourdomain.com/chat
         v
+-----------------------------------+
|   Knotie Relay Server (VPS)       |
|   Multi-tenant WebSocket router   |
+-----------------------------------+
         |
         |  wss://relay.yourdomain.com/bot
         v
+-----------------------------------+
|   This Plugin (Knotie Relay       |  <-- runs inside OpenClaw
|   Bridge for OpenClaw)            |
+-----------------------------------+
         |
         |  ws://127.0.0.1:18789 (ACP)
         v
+-----------------------------------+
|   Local OpenClaw Gateway          |
|   (your AI agent)                 |
+-----------------------------------+
```

The plugin runs inside OpenClaw as a native plugin. It:

1. Connects to your Knotie Relay Server as a registered bot for a specific tenant
2. Receives prompts from remote browser/voice clients routed through the relay
3. Forwards prompts to the local OpenClaw gateway via ACP (Agent Communication Protocol)
4. Streams AI responses back through the relay to the client in real-time
5. Reconnects automatically with exponential backoff if the connection drops

---

## Quick Start

### 1. Install the plugin

```bash
# From npm
openclaw plugins install knotie-relay-bridge

# Or from a local directory (development)
openclaw plugins install ./openclaw-relay-plugin
```

### 2. Configure (automatic — recommended)

Run the setup script to safely merge config into your OpenClaw settings:

```bash
# Interactive — prompts for relay URL and bot token
node setup.js

# Or pass values directly (no prompts)
node setup.js --url wss://relay.yourdomain.com/bot --token sk-relay-bot-YOUR_TOKEN_HERE

# Optionally override gateway defaults
node setup.js --url wss://relay.yourdomain.com/bot --token sk-relay-bot-xxx \
  --gateway-url ws://127.0.0.1:18789 --agent-id main
```

The setup script will:
- Read your existing `~/.openclaw/settings.json` (or create it)
- Add the plugin to `plugins.allow` if not already there
- Merge the relay config into `plugins.entries` without overwriting your other settings
- Preserve any existing customizations you've made

### 2b. Configure (manual — alternative)

If you prefer, add to `~/.openclaw/settings.json` manually:

```json
{
  "plugins": {
    "allow": ["knotie-relay-bridge"],
    "entries": {
      "knotie-relay-bridge": {
        "enabled": true,
        "config": {
          "bridge": {
            "url": "wss://relay.yourdomain.com/bot",
            "token": "sk-relay-bot-YOUR_TOKEN_HERE"
          }
        }
      }
    }
  }
}
```

### 3. Start OpenClaw

The plugin starts automatically — no separate process needed. You'll see:

```
[Knotie Relay] Starting relay bridge...
[Knotie Relay] Relay   : wss://relay.yourdomain.com/bot
[Knotie Relay] Gateway : ws://127.0.0.1:18789 (agent: main)
[Knotie Relay] Bridge status: connected
[Bridge] Registered as bot for tenant: my-client (My Client)
```

---

## Configuration Reference

All config goes under `plugins.entries.knotie-relay-bridge.config` in your OpenClaw settings:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| **`bridge.url`** | string | **(required)** | Relay server WebSocket URL (`wss://...`) |
| **`bridge.token`** | string | **(required)** | Bot token from the relay admin API |
| `bridge.promptTimeoutMs` | number | `300000` | Max ms to wait for gateway response (5 min) |
| `bridge.reconnectBaseMs` | number | `1000` | Initial reconnect delay |
| `bridge.reconnectMaxMs` | number | `60000` | Maximum reconnect delay (1 min) |
| `gateway.url` | string | `ws://127.0.0.1:18789` | Local OpenClaw gateway URL |
| `gateway.agentId` | string | `main` | Agent ID to target in the gateway |
| `log.verbose` | boolean | `false` | Enable verbose ACP/WebSocket debug logs |

### Full config example

```json
{
  "bridge": {
    "url": "wss://relay.yourdomain.com/bot",
    "token": "sk-relay-bot-abc123...",
    "promptTimeoutMs": 300000,
    "reconnectBaseMs": 1000,
    "reconnectMaxMs": 60000
  },
  "gateway": {
    "url": "ws://127.0.0.1:18789",
    "agentId": "main"
  },
  "log": {
    "verbose": false
  }
}
```

---

## CLI Commands

Once installed, the plugin registers CLI subcommands:

```bash
# Check connection status
openclaw knotie-relay-status

# Force reconnect to the relay server
openclaw knotie-relay-reconnect
```

## Agent Tools

The plugin also gives your OpenClaw agent two tools it can call during conversations:

| Tool | Description |
|------|-------------|
| `knotie_relay_status` | Check bridge connection status (connected, tenant, relay URL) |
| `knotie_relay_reconnect` | Force disconnect and reconnect to the relay server |

This means the agent can self-diagnose connectivity issues when a user reports problems.

---

## Setting Up the Relay Server

This plugin requires a **Knotie Relay Server** running on a VPS. See the full setup guide at [`config-examples/SETUP.md`](../config-examples/SETUP.md) for:

- Deploying the relay server with systemd or PM2
- Configuring Nginx + TLS for `wss://`
- Creating tenants via the admin API
- Testing with the browser test UI

### Quick relay server setup

```bash
cd relay-server
npm install
cp .env.example .env   # set PORT and ADMIN_KEY

node server.js
# Relay listening on port 8080
```

### Create a tenant

```bash
curl -X POST https://relay.yourdomain.com/admin/tenants \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: your-admin-key" \
  -d '{"name": "My Client", "id": "my-client"}'

# Returns: { botToken: "sk-relay-bot-...", chatApiKey: "sk-relay-chat-..." }
```

Use the `botToken` in the plugin config. Give the `chatApiKey` to your client for their browser UI.

---

## Multi-Tenant Setup (Agency Use Case)

This is where Knotie shines. Run **one relay server**, then deploy **one OpenClaw instance + plugin per client**:

```
                     Knotie Relay Server (single VPS)
                    /           |            \
          Client A Bot    Client B Bot    Client C Bot
               |               |               |
         OpenClaw + Plugin  OpenClaw + Plugin  OpenClaw + Plugin
          (host A)           (host B)           (host C)
```

Each client gets:
- Their own tenant ID and API keys
- Their own OpenClaw agent (with custom system prompts, tools, knowledge)
- Their own whitelabel chat/voice UI connecting via the relay
- Complete isolation from other tenants

---

## Publishing to npm

### Prerequisites

1. Create an npm account at [npmjs.com](https://www.npmjs.com/signup)
2. If using a scoped package (`@knotie/...`), create an npm organization at [npmjs.com/org/create](https://www.npmjs.com/org/create)

### Step-by-step

```bash
cd openclaw-relay-plugin

# 1. Log in to npm
npm login

# 2. If this is a scoped package under @knotie, ensure the org exists
#    and set access to public (scoped packages are private by default)
npm access public knotie-relay-bridge

# 3. Verify package contents before publishing
npm pack --dry-run
#    Review the file list — make sure no secrets, .env, or config files are included

# 4. Publish
npm publish --access public

# 5. Verify it's live
npm info knotie-relay-bridge
```

### Add an .npmignore (recommended)

Create `.npmignore` to exclude dev files from the published package:

```
relay-plugin-config.json
relay-plugin-config.example.json
.env
*.log
node_modules/
.git/
```

### Updating the package

```bash
# Bump version (patch/minor/major)
npm version patch    # 1.0.0 → 1.0.1
npm version minor    # 1.0.0 → 1.1.0
npm version major    # 1.0.0 → 2.0.0

# Publish the update
npm publish --access public
```

---

## Publishing to ClawHub

ClawHub is OpenClaw's native plugin registry. Publishing there makes the plugin discoverable directly from the OpenClaw CLI.

### Step-by-step

```bash
# 1. Ensure you have a ClawHub account
#    Sign up at https://clawhub.openclaw.ai (or via the OpenClaw CLI)
openclaw auth login

# 2. Validate your plugin manifest
openclaw plugins validate ./openclaw-relay-plugin

# 3. Publish to ClawHub
openclaw plugins publish

# 4. Verify it appears on ClawHub
openclaw plugins search knotie-relay
```

### After publishing to ClawHub

Users can install directly:

```bash
openclaw plugins install knotie-relay-bridge
```

OpenClaw checks ClawHub first, then falls back to npm — so publishing to both gives maximum reach.

---

## Pre-Publish Checklist

Before publishing to npm or ClawHub, verify:

- [ ] `package.json` has correct `name`, `version`, `description`, `author`, `license`
- [ ] `package.json` has `"type": "module"` and the `openclaw` metadata block
- [ ] `openclaw.plugin.json` exists with valid `id`, `name`, `configSchema`
- [ ] Entry point (`index.js`) uses `definePluginEntry({...})` from `openclaw/plugin-sdk/plugin-entry`
- [ ] All imports use ESM (`import`/`export`, not `require`)
- [ ] `openclaw.extensions` in package.json points to your entry file (e.g. `["./index.js"]`)
- [ ] `npm pack --dry-run` shows only intended files (no secrets)
- [ ] Plugin loads without errors: test with `openclaw plugins install ./openclaw-relay-plugin`
- [ ] `ws` dependency is listed in `dependencies` (not `devDependencies`)
- [ ] Node engine requirement (`>=18.0.0`) is specified

---

## Development

```bash
cd openclaw-relay-plugin
npm install

# Load from local path in OpenClaw settings:
# "load": { "paths": ["/absolute/path/to/openclaw-relay-plugin"] }

# Watch mode for development
npm run dev
```

---

## Troubleshooting

**Plugin not loading:**
- Run `openclaw plugins list` to verify installation
- Check that `knotie-relay-bridge` is in the `plugins.allow` array
- Ensure `enabled: true` in the plugin entry config

**Bridge not connecting:**
- Run `openclaw knotie-relay-status`
- Verify `bridge.url` and `bridge.token` are correct
- Check that the relay server is running: `curl https://relay.yourdomain.com/health`

**Gateway errors:**
- Ensure OpenClaw gateway is running on the configured port (default 18789)
- Set `"log": { "verbose": true }` to see raw ACP messages

**Timeout errors:**
- Increase `bridge.promptTimeoutMs` for long-running agent responses
- Check gateway is not overloaded

---

## License

MIT - [Knotie AI](https://knotie.ai)
