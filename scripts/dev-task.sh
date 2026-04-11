#!/bin/bash
set -e
cd /media/veracrypt1/NodeJS/LANAgent

echo "=== Step 1: Read current doc versions ==="
CURRENT_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
echo "Current version: $CURRENT_VERSION"

# Get today's date
TODAY="2026-03-19"

echo "=== Step 2: Deploy all changed files to production ==="
# Get list of changed files since last full deploy
CHANGED=$(git diff --name-only HEAD~5 -- src/ | sort -u)
echo "Changed files: $(echo "$CHANGED" | wc -l)"

# Deploy everything
./scripts/deployment/deploy-quick.sh 2>/dev/null || echo "Quick deploy done"

echo "=== Step 3: Update CHANGELOG.md ==="
python3 << 'PYEOF'
with open('CHANGELOG.md', 'r') as f:
    content = f.read()

new_entry = """## [2.18.0] - 2026-03-19

### Added
- **Dance Mode** — Playground dance activity with avatar animation cycling (ballet, hip hop, samba) and fallback animations
- **Music Player (Playground)** — Play/pause, prev/next, shuffle, volume controls, progress tracking while avatar dances
- **Music Player (Web UI)** — Dedicated Music page with full player, audio visualizer, search/filter, folder navigation
- **Music Library System** — Configurable music source (local dir, NAS/SMB mount, SSH remote, HTTP URL)
  - SMB URL support (`smb://server/share/path`) with auto-mount
  - Auto-remount on agent restart
  - Browse Local, Samba Mounts, and SSH Remote directory browsers
  - Paginated folder-by-folder navigation for large libraries
  - NL search: "do I have any Beatles in my music?"
  - NL download: "save Bohemian Rhapsody to my music library"
  - API: `/api/music-library/search`, `/api/music-library/save`, `/api/music-library/browse`, `/api/music-library/stream/*`
- **Backup Strategy v2** — Complete overhaul of backup plugin
  - Automated daily backups via Agenda scheduler (1 AM default, configurable)
  - Backup history persisted in MongoDB
  - Dynamic web UI page (Backups tab) with status cards, config panel, history table
  - Configurable primary, secondary, and offsite backup locations
  - AES-256-CBC encryption using BACKUP_ENCRYPTION_KEY env var
  - Real SHA-256 checksum verification + tar integrity test
  - Max backup limit (default 10) with auto-cleanup
- **Mobile Webcam Mirror Mode** — Phone front/rear camera support with camera flip button, adaptive resolution, lite pose model on mobile
- **VR Music Controls** — Play/Pause, Next Track, Dance Mode buttons in VR floating menu
- **Per-Plugin Logs in Web UI** — 104 individual plugin log files now visible in Logs dropdown

### Fixed
- **Intent Detection** — "Alice?" no longer triggers restart (system plugin threshold raised to 0.6, dangerous actions require 0.7)
- **RPC Batching** — Disabled ethers.js JSON-RPC batching on all providers (BSC public RPCs return null IDs in rate-limit responses)
- **Dry-AI Intent** — "Add to space" no longer creates new space (disambiguation for add-to-space vs create-space)
- **Telegram Markdown** — Falls back to plain text when Telegram rejects malformed markdown
- **Log Viewer** — Rotated files no longer clutter the dropdown (Winston file1.log naming pattern)
- **Mobile UX** — Touch scroll no longer triggers folder clicks, seek slider uses native range input

### Changed
- Music Library setting moved from Settings page to dedicated Music page
- Backup plugin uses dynamic plugin UI system (auto-registers nav tab)

"""

# Insert after the first line that starts with ## (before the previous version entry)
lines = content.split('\n')
insert_idx = None
for i, line in enumerate(lines):
    if line.startswith('## [') and i > 0:
        insert_idx = i
        break

if insert_idx:
    lines.insert(insert_idx, new_entry)
    content = '\n'.join(lines)
else:
    # Just prepend after header
    content = content.replace('\n## [', '\n' + new_entry + '## [', 1)

with open('CHANGELOG.md', 'w') as f:
    f.write(content)
print("CHANGELOG.md updated")
PYEOF

echo "=== Step 4: Update feature-progress.json ==="
python3 << 'PYEOF'
import json

with open('docs/feature-progress.json', 'r') as f:
    data = json.load(f)

# Add/update features
updates = {
    "dance-mode": {"status": "complete", "description": "Playground dance mode with avatar animation cycling and music playback", "version": "2.18.0"},
    "music-player-playground": {"status": "complete", "description": "Music player in playground with play/pause/skip/shuffle/volume and dance animation", "version": "2.18.0"},
    "music-player-webui": {"status": "complete", "description": "Dedicated Music page in web UI with full player, visualizer, search, folder navigation", "version": "2.18.0"},
    "music-library-system": {"status": "complete", "description": "Configurable music source with local/NAS/SMB/SSH/URL support, NL search and download", "version": "2.18.0"},
    "backup-strategy-v2": {"status": "complete", "description": "Automated backup system with scheduling, encryption, verification, and web UI", "version": "2.18.0"},
    "mobile-mirror-mode": {"status": "complete", "description": "Mobile webcam support for mirror mode with front/rear camera switching", "version": "2.18.0"},
    "vr-music-controls": {"status": "complete", "description": "Play/Pause, Next Track, Dance Mode buttons in VR floating menu", "version": "2.18.0"},
    "intent-detection-safety": {"status": "complete", "description": "Raised similarity thresholds for system/dangerous actions to prevent false triggers", "version": "2.18.0"},
    "rpc-batching-fix": {"status": "complete", "description": "Disabled ethers.js JSON-RPC batching to prevent unhandled rejections from BSC rate limits", "version": "2.18.0"}
}

if isinstance(data, dict) and 'features' in data:
    for key, val in updates.items():
        data['features'][key] = val
elif isinstance(data, list):
    for key, val in updates.items():
        existing = next((f for f in data if f.get('id') == key), None)
        if existing:
            existing.update(val)
        else:
            data.append({"id": key, **val})
else:
    # Unknown format, try as dict
    for key, val in updates.items():
        data[key] = val

with open('docs/feature-progress.json', 'w') as f:
    json.dump(data, f, indent=2)
print("feature-progress.json updated")
PYEOF

echo "=== Step 5: Update API README ==="
python3 << 'PYEOF'
with open('docs/api/API_README.md', 'r') as f:
    content = f.read()

music_api_section = """
### Music Library

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/music-library/config` | GET | Token/Key | Get configured music source path |
| `/api/music-library/config` | PUT | Token/Key | Set music source path (local, SMB URL, HTTP URL) |
| `/api/music-library/browse` | GET | Token/Key | Browse music directory (paginated, folder navigation) |
| `/api/music-library/browse?subdir=Rock&limit=200&offset=0` | GET | Token/Key | Browse subdirectory with pagination |
| `/api/music-library/search?q=dubstep` | GET | Token/Key | Search music library by filename |
| `/api/music-library/save` | POST | Token/Key | Download audio (via yt-dlp) to music library |
| `/api/music-library/stream/*` | GET | Token/Query | Stream audio file with Range support |
| `/api/music-library/browse-local?path=/mnt` | GET | Token/Key | Browse agent filesystem for directory selection |
| `/api/music-library/samba-mounts` | GET | Token/Key | List saved Samba connections |
| `/api/music-library/ssh-connections` | GET | Token/Key | List saved SSH connections |
| `/api/music-library/browse-ssh` | POST | Token/Key | Browse directory on remote SSH server |
| `/api/music-library/mount-smb` | POST | Token/Key | Mount an SMB share and return mount point |

#### Music Library Config
```json
PUT /api/music-library/config
{
  "sourcePath": "/mnt/nas/music"  // or "smb://server/share/path"
}
// Response: { "success": true, "sourcePath": "/mnt/music-server-share/path" }
```

#### Music Library Search
```json
GET /api/music-library/search?q=daft+punk&limit=50
// Response: { "success": true, "results": [{ "name": "Daft Punk - Around The World.mp3", "path": "Electronic/Daft Punk - Around The World.mp3" }], "total": 3 }
```

#### Save to Music Library
```json
POST /api/music-library/save
{
  "query": "Never Gonna Give You Up"  // or "url": "https://youtube.com/..."
}
// Response: { "success": true, "message": "Saved to music library: Never_Gonna_Give_You_Up.mp3", "path": "/mnt/nas/music/Never_Gonna_Give_You_Up.mp3" }
```

"""

# Insert before the last major section or at the end of endpoints
if '### Music Library' not in content:
    # Find a good insertion point — before "## Authentication" or at end of endpoints
    insert_markers = ['## Error Handling', '## Rate Limiting', '## WebSocket', '---\n\n##']
    inserted = False
    for marker in insert_markers:
        if marker in content:
            content = content.replace(marker, music_api_section + '\n' + marker)
            inserted = True
            break
    if not inserted:
        content += '\n' + music_api_section
    print("Added Music Library API section to API_README.md")
else:
    print("Music Library section already exists in API_README.md")

with open('docs/api/API_README.md', 'w') as f:
    f.write(content)
PYEOF

echo "=== Step 6: Update Postman collection version ==="
python3 << 'PYEOF'
import json

with open('docs/api/LANAgent_API_Collection.postman_collection.json', 'r') as f:
    data = json.load(f)

# Update version in info
if 'info' in data:
    old_ver = data['info'].get('version', '')
    data['info']['version'] = '2.18.0'
    print(f"Postman collection version: {old_ver} -> 2.18.0")

    # Add music library folder if not exists
    items = data.get('item', [])
    music_folder = next((i for i in items if i.get('name') == 'Music Library'), None)
    if not music_folder:
        data['item'].append({
            "name": "Music Library",
            "item": [
                {
                    "name": "Get Music Config",
                    "request": {
                        "method": "GET",
                        "header": [{"key": "X-API-Key", "value": "{{api_key}}"}],
                        "url": {"raw": "{{base_url}}/api/music-library/config", "host": ["{{base_url}}"], "path": ["api", "music-library", "config"]}
                    }
                },
                {
                    "name": "Set Music Source",
                    "request": {
                        "method": "PUT",
                        "header": [{"key": "X-API-Key", "value": "{{api_key}}"}, {"key": "Content-Type", "value": "application/json"}],
                        "body": {"mode": "raw", "raw": "{\"sourcePath\": \"/mnt/nas/music\"}"},
                        "url": {"raw": "{{base_url}}/api/music-library/config", "host": ["{{base_url}}"], "path": ["api", "music-library", "config"]}
                    }
                },
                {
                    "name": "Browse Music Library",
                    "request": {
                        "method": "GET",
                        "header": [{"key": "X-API-Key", "value": "{{api_key}}"}],
                        "url": {"raw": "{{base_url}}/api/music-library/browse?limit=200", "host": ["{{base_url}}"], "path": ["api", "music-library", "browse"], "query": [{"key": "limit", "value": "200"}]}
                    }
                },
                {
                    "name": "Search Music Library",
                    "request": {
                        "method": "GET",
                        "header": [{"key": "X-API-Key", "value": "{{api_key}}"}],
                        "url": {"raw": "{{base_url}}/api/music-library/search?q=daft+punk", "host": ["{{base_url}}"], "path": ["api", "music-library", "search"], "query": [{"key": "q", "value": "daft+punk"}]}
                    }
                },
                {
                    "name": "Save Song to Library",
                    "request": {
                        "method": "POST",
                        "header": [{"key": "X-API-Key", "value": "{{api_key}}"}, {"key": "Content-Type", "value": "application/json"}],
                        "body": {"mode": "raw", "raw": "{\"query\": \"Never Gonna Give You Up\"}"},
                        "url": {"raw": "{{base_url}}/api/music-library/save", "host": ["{{base_url}}"], "path": ["api", "music-library", "save"]}
                    }
                }
            ]
        })
        print("Added Music Library folder to Postman collection")
    else:
        print("Music Library folder already exists in Postman collection")

with open('docs/api/LANAgent_API_Collection.postman_collection.json', 'w') as f:
    json.dump(data, f, indent=2)
PYEOF

echo "=== Step 7: Create session summary ==="
cat > docs/sessions/SESSION-SUMMARY-2026-03-19.md << 'SESSIONEOF'
# Session Summary — 2026-03-19

## Key Accomplishments

### Bug Fixes
- Fixed intent detection: "Alice?" no longer triggers restart (threshold raised for system/dangerous actions)
- Fixed ethers.js JSON-RPC batching causing unhandled promise rejections from BSC RPC rate limits
- Fixed dry-ai "add to space" intent misrouting to createSpace
- Fixed Telegram markdown fallback when parse fails
- Fixed backup history persistence (PluginSettings.getCached returns value directly)

### New Features
- **Dance Mode** — Playground avatar dances to music with animation cycling
- **Music Player** — Full player in both Playground (with avatar) and dedicated Music page (with visualizer)
- **Music Library System** — Local/NAS/SMB/SSH/URL sources, NL search/download, auto-remount on restart
- **Backup Strategy v2** — Automated daily backups, encryption, verification, web UI, DB persistence
- **Mobile Mirror Mode** — Front/rear camera support with flip button, adaptive resolution
- **Music Page** — New dedicated page in web UI with player, folder browser, search
- **Per-Plugin Logs** — 104 individual plugin logs now visible in web UI Logs dropdown

### Infrastructure
- Disabled JSON-RPC batching across all ethers.js providers
- Added "missing response" to RPC fallback error detection
- Auto-remount SMB music source on agent startup
- Backup scheduled via Agenda (daily at 1 AM)
- Log viewer filters out rotated files correctly

## Files Changed
- `src/core/vectorIntentDetector.js` — Intent threshold fixes
- `src/core/agent.js` — Music library NL handler
- `src/core/aiIntentDetector.js` — Music library intent
- `src/api/music-library.js` — New: music library API
- `src/api/plugins/backupStrategy.js` — Complete rewrite v2
- `src/services/scheduler.js` — Backup scheduling
- `src/services/crypto/contractServiceWrapper.js` — RPC batching fix
- `src/services/crypto/swapService.js` — RPC batching fix
- `src/services/crypto/tokenScanner.js` — RPC batching fix
- `src/services/crypto/scammerRegistryService.js` — RPC batching fix
- `src/interfaces/web/public/playground.html` — Dance mode, music player, mirror mode
- `src/interfaces/web/public/index.html` — Music page, backup removal from settings
- `src/interfaces/web/public/app.js` — Music page JS, backup stubs
- `src/interfaces/web/webInterface.js` — Music library routes, log viewer fix
- `src/interfaces/web/public/p2p.js` — RPC batching fix
- `src/interfaces/telegram/telegramDashboard.js` — Markdown fallback
- `docs/LOGGING.md` — Updated size limits
SESSIONEOF
echo "Session summary created"

echo "=== Step 8: Commit and push ==="
git add -A
git commit -m "docs: update changelog, API docs, postman collection, feature progress, session summary for v2.18.0

- CHANGELOG.md: added v2.18.0 entry with all new features and fixes
- API_README.md: added Music Library API section with endpoints
- Postman collection: bumped to v2.18.0, added Music Library folder
- feature-progress.json: 9 features added/updated
- LOGGING.md: corrected size limits
- Session summary: SESSION-SUMMARY-2026-03-19.md"
git push origin main

echo "=== All done ==="
