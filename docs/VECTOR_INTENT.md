# Vector Intent Detection System

## Overview

LANAgent uses vector embedding search (LanceDB + OpenAI embeddings) to understand user commands semantically instead of rigid pattern matching. When a user says something, the system embeds the input, searches for the most similar intent vectors, and routes to the matched plugin/action.

## How It Works

1. **Startup indexing** — All intents (base, plugin, sub-agent) are embedded and stored in LanceDB
2. **User input** — Text is embedded via OpenAI `text-embedding-3-small`
3. **Similarity search** — LanceDB finds the closest intent vectors by cosine distance
4. **Threshold check** — Match must exceed similarity threshold (0.5 default, 0.6 for system, 0.7 for dangerous actions)
5. **Parameter extraction** — AI extracts parameters from the natural language input
6. **Fallback** — If no vector match, falls through to AI intent detection → plugin chain analysis → regex

## Architecture

```
User Input → Embedding → LanceDB Search → Threshold Check → Action Execution
                                                    ↓ (no match)
                                          AI Intent Detection → Plugin Chain → Regex
```

## Key Files

| File | Purpose |
|------|---------|
| `src/core/vectorIntentDetector.js` | Main detector — search, threshold, overrides |
| `src/utils/intentIndexer.js` | Extracts and indexes intents from plugins + sub-agents |
| `src/services/vectorStore.js` | LanceDB wrapper (addIntent, search, clear) |
| `src/services/embeddingService.js` | OpenAI embedding generation |

## Intent Sources

- **Base intents** — from `AIIntentDetector.intents` (system commands)
- **Plugin intents** — from each plugin's `.intents` and `.commands` definitions
- **Sub-agent intents** — from `SubAgent.getIntents()` (e.g., ServerMaintenanceAgent generates intents dynamically from its configured hostname and monitored apps)

## Configuration

```bash
# .env
ENABLE_VECTOR_INTENT=true    # Default: true if OpenAI key present
OPENAI_API_KEY=your-key      # Required for embeddings
```

## Reindexing

Intents are reindexed on every startup. To force reindex via API:

```bash
curl -X POST http://localhost/api/vector-intent/index -H "X-API-Key: your-key"
```

## Override Rules

The vector detector has hardcoded overrides for known misrouting patterns:
- Song requests without "lyrics" → route to ytdlp instead of lyrics plugin
- Download requests mismatched to transcribe → route to download
- Dangerous system actions require higher confidence (0.7+)
- Govee schedule-related phrases → route to Govee two-step classifier

## Similarity Thresholds

| Plugin Type | Threshold | Reason |
|-------------|-----------|--------|
| Default | 0.5 | Standard confidence |
| System plugin | 0.6 | Prevent accidental system commands |
| Dangerous actions | 0.7 | restart, redeploy, shutdown, stop |
| Low confidence (<80%) | Widened | Confidence penalty applied |
