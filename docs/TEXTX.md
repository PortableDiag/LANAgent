# TextX — your agent in your texting app

TextX is an Android SMS/MMS app. It can hold one or more AI assistants, each shown as its own
conversation. LANAgent is one kind; any agent that speaks the **TextX Agent Protocol v1** can be
another (Hermes, OpenClaw, …). The protocol's source of truth is the TextX repo
(`docs/agent-protocol.md`). This page covers the LANAgent side.

## Pairing

Dashboard → **Settings → TextX → Pair a phone**. It shows a QR code once. In TextX:
Settings › Assistants › Add › Agent › Scan QR. The QR holds

```
textx-agent:<base>#<kid>.<key>
```

- `base` is where the phone connects (below).
- `kid` identifies the pairing.
- `key` is a 32-byte AES key that only the QR carries. Every frame between the phone and the
  agent is AES-256-GCM under it, so nothing in between can read or forge content.

The first phone that says `hello` with a pairing owns it. Anything else holding the same key is refused on every envelope: a WebSocket is answered only after its `hello` names the bound device, and HTTP requests carry `X-TextX-Device: <device>`. A second device never sees a frame and can't knock the real phone's socket off. **Revoke**
in the same Settings card deletes the key, which also cuts off any phone using it.

## How the phone reaches the agent

By default through the **relay at api.lanagent.net**, so it works from anywhere with no open port:

- The agent dials out to `wss://api.lanagent.net/textx/relay/agent` and proves its P2P Ed25519
  identity. The link starts only once a phone is paired.
- The phone uses `https://api.lanagent.net/r/<fingerprint>` as the agent's address.
- The relay forwards encrypted frames and stores nothing.

| Env | Effect |
|---|---|
| `TEXTX_RELAY=off` | No relay link. Phones need the agent's own network, a VPN or `TEXTX_PUBLIC_URL`. |
| `TEXTX_RELAY_URL` | A different relay (default `wss://api.lanagent.net/textx/relay/agent`). |
| `TEXTX_PUBLIC_URL` | Put this origin in pairing QRs instead of the relay (an instance with its own domain). |
| `TEXTX_RELAY_CONNECT_ADDRESS` | Dial this IP for the relay; TLS still checks the relay's hostname. For a host whose firewall only lets traffic out through a tunnel (a VPN kill switch). |

The agent also answers directly at `/textx/v1/*` on its web port, with the same encryption.

## What the agent can do on the phone

Every tool is **off until you turn it on in TextX** for this agent. It reads only the
conversations you shared with it.

| You say (Telegram, dashboard or TextX) | Tool on the phone |
|---|---|
| "text Mom I'm running late" | `send_sms`. **The phone shows the text and you tap Send**, every time |
| "schedule a text to Dad for 9am tomorrow" | `schedule_message`, confirmed the same way |
| "any unread texts?", "catch me up on the family chat" | `list_threads`, `read_thread` |
| "find the text with the gate code" | `search_messages` |
| "what's Sam's number" | `contacts_lookup`. Names in "text Sam …" are also resolved through it |
| "tell me when the landlord replies about the lease" | `watch` (up to 7 days) |
| "what texts are scheduled", "cancel the birthday text", "skip the next Friday reminder" | `list_scheduled`, `cancel_scheduled`, `skip_next`, `update_scheduled`, `send_scheduled_now` (the last two confirmed) |
| "thumbs up Sam's last text", "mark the family chat read" | `react` (confirmed), `mark_read` |
| "block 555-0100" | `block_number` (confirmed) |
| "text the family group…" | `send_sms` to a shared conversation by name (`thread_id`). A file you gave the agent goes out as MMS |

The phone itself enforces the guards:

- One-time codes never leave the phone.
- Private conversations don't exist to any assistant.
- Sends are rate-limited.

On the agent side:

- SMS text is wrapped as **untrusted data** and never treated as instructions.
- Watched-conversation events go to a plain model call, never to the command router.

A send that you haven't tapped yet returns at once ("it's on your phone"). Its outcome (sent,
declined, expired) is reported back to the conversation the request came from.

## Notifications

Each paired phone has **"send my notifications here"** in Settings → TextX. With it on, the
agent's notifications (the ones Telegram gets) also arrive in its TextX conversation.

## API

| Route | Auth | |
|---|---|---|
| `GET /api/textx/status` | JWT / API key | relay state and paired phones |
| `POST /api/textx/pair` `{name}` | JWT / API key | `{id, name, base, uri, qr}`. The only time the key is shown |
| `PATCH /api/textx/devices/:id` `{notify?, name?}` | JWT / API key | |
| `DELETE /api/textx/devices/:id` | JWT / API key | revoke |
| `/textx/v1/messages`, `/textx/v1/files`, `/textx/v1/ws`, `/textx/v1/avatar` | pairing | the phone's endpoint (TextX protocol §3) |

## Relay link (for other agents)

The relay accepts any Ed25519 identity, not only LANAgent. The spec (challenge and signature,
`req`/`res`, `open`/`accept`/`msg`/`close`, limits) is in the api.lanagent.net repo,
`docs/TEXTX_RELAY.md`.

## Code

`src/services/textx/`:
- `textxCrypto.js`: framing, pairing, ULIDs
- `textxHub.js`: protocol, tool calls, watches
- `textxStore.js`: Mongo `textx_devices`, `textx_outbox`, and `textx_inbox` (7-day replay window)
- `textxTransport.js`: HTTP and WebSocket handling, files
- `textxRelayClient.js`: the relay link
- `index.js`: the service and pairing

Also `src/interfaces/web/textx.js` (routes) and `src/api/plugins/textx.js` (what the router calls).
