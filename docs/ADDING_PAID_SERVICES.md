# Adding a New Paid API Service

Step-by-step guide for adding a plugin as a paid external API service. Services are sold through three channels: the external credit API, the P2P Skynet network, and the public gateway at `api.lanagent.net`. All three must be configured or the service will not work end-to-end.

---

## Architecture Overview

A paid service request flows through this chain:

```
Client
  -> api.lanagent.net gateway (routes to agent, charges client credits)
    -> ALICE agent /api/external/service/:plugin/:action (charges gateway credits)
      -> apiManager.apis.get(plugin).execute(params)
```

The gateway is a **separate server** (`137.184.2.62:/opt/scrape-gateway/index.mjs`). It has its own MongoDB, its own credit system, and its own hardcoded routing config. It discovers agent services by calling `GET /api/external/catalog` on the agent and reading the `services` array.

There are **6 files on the agent** and **1 file on the gateway** that must be updated. If any one is missed, the service will not work on that channel.

---

## Files to Modify (Agent — this repo)

### 1. Plugin File

**Path:** `src/api/plugins/<pluginName>.js`

Create the plugin extending `BasePlugin`. See `docs/PLUGIN_DEVELOPMENT.md` for the full guide. The key properties that affect paid service registration:

```javascript
this.name = 'myPlugin';        // Used as lookup key everywhere. Must match in all config files.
this.version = '1.0.0';
this.description = 'What this plugin does';  // Shown in catalog and registration
this.commands = [
  { command: 'action1', description: 'Does X', usage: 'action1({ param: "value" })', offerAsService: true },
  { command: 'action2', description: 'Does Y', usage: 'action2({ param: "value" })', offerAsService: true }
];
```

The plugin is auto-discovered by `apiManager` from the `src/api/plugins/` directory. No manual registration needed. The plugin will load as `enabled: true` unless `initialize()` throws a "Missing required credentials" error.

**Excluded filenames:** Files containing `templates`, `template`, `-enhancements`, `-advanced`, `-helper`, `-providers` are skipped by the loader.

---

### 2. External API Allowlist + Credit Pricing

**File:** `src/api/external/routes/plugins.js`

Two exports must be updated:

**`ALLOWED_PLUGINS`** (line ~8) — Add the plugin name to the Set:

```javascript
export const ALLOWED_PLUGINS = new Set([
  'anime', 'chainlink', /* ... existing ... */,
  'myPlugin'   // <-- add here
]);
```

**`PLUGIN_CREDIT_COSTS`** (line ~30) — Add the credit cost:

```javascript
export const PLUGIN_CREDIT_COSTS = {
  /* ... existing ... */
  myPlugin: 3,   // $0.03 — 1 credit = $0.01 USD
};
```

This enables `POST /api/external/service/myPlugin/:action` and sets the per-call credit cost.

---

### 3. P2P Skynet Eligibility + USD Pricing

**File:** `src/interfaces/web/p2p.js`

Two variables must be updated:

**`SKYNET_ELIGIBLE_CATEGORIES`** (line ~21) — Add the plugin name:

```javascript
const SKYNET_ELIGIBLE_CATEGORIES = new Set([
  /* ... existing ... */,
  'myPlugin'  // <-- add here (alphabetical order)
]);
```

**`SERVICE_USD_TIERS`** (line ~903) — Add the USD price:

```javascript
const SERVICE_USD_TIERS = {
  /* ... existing ... */
  myPlugin: 0.03    // Must equal PLUGIN_CREDIT_COSTS[name] * 0.01
};
```

The relationship between credit costs and USD tiers: `PLUGIN_CREDIT_COSTS.myPlugin * 0.01 === SERVICE_USD_TIERS.myPlugin`. Credits are cents; USD tiers are dollars.

This registers the plugin's commands in the `SkynetServiceConfig` MongoDB collection and enables P2P peers to discover and pay for the service in SKYNET tokens. Prices auto-update every 15 minutes from PancakeSwap LP + Chainlink oracle.

---

## Files to Modify (Gateway — separate server)

### 4. Gateway Plugin Cost Map

**Server:** `137.184.2.62` (ssh root@137.184.2.62)
**File:** `/opt/scrape-gateway/index.mjs`

Find the plugin routing handler (search for `"/service/:plugin/:action"`). It has a hardcoded `costs` object:

```javascript
const costs = { anime: 1, chainlink: 1, /* ... */, myPlugin: 3 };
```

Add the new plugin with its credit cost. This determines how many credits the gateway charges clients.

**After editing, restart:** `pm2 restart scrape-gateway`

**Also update the local source copy** at `/media/veracrypt3/Websites/LANAgent_Website/api-lanagent-net/index.mjs` so it stays in sync with production.

---

## Post-Deployment Steps

### 5. Deploy and Restart Agent

```bash
# Syntax check all modified files
node --check src/api/plugins/myPlugin.js
node --check src/api/external/routes/plugins.js
node --check src/interfaces/web/p2p.js

# Deploy
./scripts/deployment/deploy-files.sh \
  src/api/plugins/myPlugin.js \
  src/api/external/routes/plugins.js \
  src/interfaces/web/p2p.js
```

The deploy script restarts PM2 automatically. Wait ~60 seconds for full startup.

### 6. Re-register Agent with Gateway

The gateway only updates its services list when `POST /admin/agents` is called. It does NOT auto-refresh services from the catalog. You must explicitly re-register:

```bash
curl -X POST https://api.lanagent.net/admin/agents \
  -H "X-Admin-Key: sgw_admin_390fd484c8cb533fdebf5ed9a76c5766" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "http://10.8.0.2:80",
    "name": "ALICE",
    "apiKey": "lsk_9493b303ae295e3a93a9bca4a4362db2",
    "agentId": 2930
  }'
```

The gateway will call `GET /api/external/catalog` on the agent, read the `services` array, and update its DB. The response shows the full services list — verify your new plugin appears as `plugin-myPlugin`.

---

## Testing (Layer by Layer)

### Test 1: Plugin loads

```bash
# On production server:
grep -i 'myPlugin' logs/plugins.log | tail -5
# Should show: "Loaded API plugin: myPlugin v1.0.0"
```

### Test 2: Direct API call (agent, with auth)

```bash
# Get JWT token first
TOKEN=$(curl -s -X POST http://localhost/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password": "your_password"}' | jq -r .token)

# Call plugin directly (internal, no credits)
curl -X POST http://localhost/api/plugin \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"plugin": "myPlugin", "action": "action1", "params": {"key": "value"}}'
```

### Test 3: External credit API (agent)

```bash
curl -X POST http://localhost/api/external/service/myPlugin/action1 \
  -H 'X-API-Key: lsk_your_key' \
  -H 'Content-Type: application/json' \
  -d '{"key": "value"}'

# Expected: success response with creditsCharged field
# If 403: plugin not in ALLOWED_PLUGINS
# If 503: plugin not loaded or disabled (check credentials)
# If 402: insufficient credits
```

### Test 4: Catalog includes the service

```bash
curl -s http://localhost/api/external/catalog | \
  python3 -c "import sys,json; [print(s['serviceId']) for s in json.load(sys.stdin)['services'] if 'myPlugin' in s['serviceId']]"

# Expected: plugin-myPlugin
# If missing: ALLOWED_PLUGINS not updated, or plugin not loaded
```

### Test 5: Gateway advertises the service

```bash
curl -s https://api.lanagent.net/agents/2930/catalog | \
  python3 -c "import sys,json; svcs=json.load(sys.stdin)['services']; print([s for s in svcs if 'myPlugin' in s])"

# Expected: ['plugin-myPlugin']
# If missing: POST /admin/agents not called after deploy
```

### Test 6: Gateway end-to-end

```bash
curl -X POST https://api.lanagent.net/service/myPlugin/action1 \
  -H 'X-API-Key: gsk_your_gateway_key' \
  -H 'Content-Type: application/json' \
  -d '{"key": "value"}'

# Expected: success response proxied from agent
# If "No agents available": services not synced — re-register with POST /admin/agents
# If 402: insufficient gateway credits
```

### Test 7: P2P Skynet catalog

```bash
# Check SkynetServiceConfig DB has the entries
curl -s http://localhost/p2p/api/skynet/services \
  -H "Authorization: Bearer $TOKEN" | \
  python3 -c "import sys,json; [print(s['serviceId']) for s in json.load(sys.stdin).get('services',[]) if 'myPlugin' in s['serviceId']]"

# Expected: myPlugin:action1, myPlugin:action2, etc.
# If missing: not in SKYNET_ELIGIBLE_CATEGORIES, or auto-sync hasn't run yet (wait 30s after restart)
```

---

## Documentation to Update

After the service is working:

1. **`CHANGELOG.md`** — Add entry under the current version
2. **`docs/api/API_README.md`** — Add row to the plugin services table (search for `| Plugin | Actions | Credits |`)
3. **`docs/api/LANAgent_API_Collection.postman_collection.json`** — Bump version, add request folder with example calls
4. **`docs/feature-progress.json`** — Add feature entry

---

## Common Mistakes

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Plugin 'X' is not available as an external service" | Not in `ALLOWED_PLUGINS` | Add to `plugins.js` ALLOWED_PLUGINS set |
| "No agents available for plugin-X" on gateway | Gateway DB not updated | Call `POST /admin/agents` to re-register |
| Plugin loads but returns 503 on external API | Missing API keys | Add credentials via Settings UI or .env |
| Service not in P2P catalog | Not in `SKYNET_ELIGIBLE_CATEGORIES` | Add to `p2p.js` eligible set |
| P2P price shows 0 | Not in `SERVICE_USD_TIERS` | Add USD tier to `p2p.js` |
| Gateway charges wrong credits | Gateway `costs` map outdated | Update `/opt/scrape-gateway/index.mjs` costs object |
| Catalog shows service but gateway doesn't | Gateway only syncs on POST /admin/agents | Re-register after every catalog change |

---

## Quick Reference: All Files for a New Service

| # | File | What to add | Required? |
|---|------|-------------|-----------|
| 1 | `src/api/plugins/<name>.js` | Plugin implementation | Yes |
| 2 | `src/api/external/routes/plugins.js` | ALLOWED_PLUGINS + PLUGIN_CREDIT_COSTS | Yes |
| 3 | `src/interfaces/web/p2p.js` | SKYNET_ELIGIBLE_CATEGORIES + SERVICE_USD_TIERS | If P2P |
| 4 | Gateway: `/opt/scrape-gateway/index.mjs` | costs map in plugin route handler | Yes |
| 5 | Gateway: `POST /admin/agents` | Re-register to sync catalog | Yes |
| 6 | `CHANGELOG.md` | Version entry | Yes |
| 7 | `docs/api/API_README.md` | Plugin table row | Yes |
| 8 | `docs/api/LANAgent_API_Collection.postman_collection.json` | Example requests | Yes |
| 9 | `docs/feature-progress.json` | Feature entry | Yes |
| 10 | SKYNET Bot (`/media/veracrypt1/NodeJS/TelegramBots/SkynetAPIBot/`) | Telegram bot commands | If user-facing |
| 11 | Gateway local copy (`/media/veracrypt3/Websites/LANAgent_Website/api-lanagent-net/index.mjs`) | Keep costs map in sync | Yes |
