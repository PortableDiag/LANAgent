# LANAgent Documentation

## Core

| Doc | Description |
|-----|-------------|
| [CHANGELOG.md](CHANGELOG.md) | Version history and release notes |
| [LOGGING.md](LOGGING.md) | Log file structure and debugging workflow |
| [SCHEDULING.md](SCHEDULING.md) | Scheduled jobs, Agenda config |
| [PLANNED_FEATURES.md](PLANNED_FEATURES.md) | Roadmap and future development |
| [feature-progress.json](feature-progress.json) | Detailed feature status tracking |

## Development

| Doc | Description |
|-----|-------------|
| [PLUGIN_DEVELOPMENT.md](PLUGIN_DEVELOPMENT.md) | Plugin creation guide |
| [PLUGIN_DATABASE_GUIDE.md](PLUGIN_DATABASE_GUIDE.md) | MongoDB patterns for plugins |
| [SELF_MODIFICATION.md](SELF_MODIFICATION.md) | Self-improvement system, PR workflow |
| [VECTOR_INTENT.md](VECTOR_INTENT.md) | Vector-based intent detection |
| [SECURITY-AUDIT-PRE-PUBLIC.md](SECURITY-AUDIT-PRE-PUBLIC.md) | Security checklist |

## Crypto & Contracts

| Doc | Description |
|-----|-------------|
| [CRYPTO_USER_GUIDE.md](CRYPTO_USER_GUIDE.md) | Wallet, trading, staking, smart contracts |
| [CONTRACT_VERIFICATION.md](CONTRACT_VERIFICATION.md) | BscScan verification process |

## Features

| Doc | Description |
|-----|-------------|
| [VRM_AVATAR_GUIDE.md](VRM_AVATAR_GUIDE.md) | 3D avatar system |
| [HARDWARE_PROJECTS.md](HARDWARE_PROJECTS.md) | Arduino/ESP32 integrations |

## API

| Doc | Description |
|-----|-------------|
| [api/API_README.md](api/API_README.md) | REST API reference |
| [api/LANAgent_API_Collection.postman_collection.json](api/LANAgent_API_Collection.postman_collection.json) | Postman collection |

## Subdirectories

| Directory | Contents |
|-----------|----------|
| [sessions/](sessions/) | Development session reports (49 reports, historical) |
| [proposals/](proposals/) | Design proposals for future features (18 proposals) |
| [archive/](archive/) | Deprecated docs (do not update, reference only) |

## Quick Navigation

- **New?** Start with the project [README.md](../README.md)
- **Deploying?** See [../scripts/README.md](../scripts/README.md)
- **Debugging?** Check [LOGGING.md](LOGGING.md), then recent [sessions/](sessions/)
- **API?** See [api/API_README.md](api/API_README.md)
- **Crypto?** See [CRYPTO_USER_GUIDE.md](CRYPTO_USER_GUIDE.md)

## Standards

- Update [feature-progress.json](feature-progress.json) when implementing features
- Add entries to [CHANGELOG.md](CHANGELOG.md) for releases
- Create session reports in [sessions/](sessions/) after dev sessions
- Move stale docs to [archive/](archive/) instead of deleting