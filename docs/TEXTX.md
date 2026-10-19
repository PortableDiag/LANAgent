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

The first phone that says `hello` with a pairing owns it. Anything else holding the same key is refused on every envelope: a WebSocket is answered only after its `hello` names the bound device; over HTTP every `POST /messages` batch starts with the device's `hello`, and `GET /messages` and the file routes carry `?device=` (protocol §3.1; `X-TextX-Device` is accepted too). Anything else gets a plaintext 401. A second device never sees a frame and can't knock the real phone's socket off. **Revoke**
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

If the agent restarts while answering, it says afterwards which message it didn't finish (it doesn't re-run it, since the request may already have acted). A send that you haven't tapped yet returns at once ("it's on your phone"). Its outcome (sent,
declined, expired) is reported back to the conversation the request came from.

**From Telegram or the dashboard, with TextX closed on the phone**, the phone has no live
connection and checks in on its own schedule (at most 15 minutes, unless TextX's "Always connected"
is on). The agent waits up to 25 seconds for it. A phone that checks in by then gets you one normal
answer ("Sent to Wayne: …"). Otherwise you get "it's going to your phone… I'll tell you here when it's
done", and the outcome arrives as a notification once the phone picks it up (the agent keeps the
request open for 20 minutes). Opening TextX makes the phone check in at once.

## Shared conversations are watched

Sharing a conversation with the agent in TextX means it is watching it.
- **It always knows.** Every new incoming message there reaches the agent (`event {shared:true, …}`) and joins
  your conversation with it, labelled as someone else's words, so "what did Sam just say?" works. Your own
  outgoing messages are not events.
- **It tells you only when it needs you:** a question or request for you, plans or a time, something urgent.
  It stays quiet for chit-chat and thanks, and sends at most 12 such notes an hour.
- **An explicit watch** ("tell me when the landlord replies about the lease") still works, for its own
  purpose, up to 7 days.

**@-mentions** (TextX 0.3.18+): type `@<agent name>` (or `@` and its first word) in one of your own
conversations and the agent weighs in there. TextX shares the conversation if it wasn't and sends
`event {kind:"mention"}`. The agent reads the conversation, writes one reply as itself, sends it into
that conversation (no card for that one send) and tells you what it said. Someone else typing `@<agent>`
grants nothing.

**Auto-reply** is a separate per-conversation toggle in TextX, **off by default**: "Let <assistant> reply on
its own".
- People in the conversation can talk to the assistant itself ("thanks Alice, say that again flirtatiously").
  It answers every message (your rule for auto-reply conversations). A message meant for you gets a short
  holding reply, and you get a one-line note saying what it needs from you.
  It answers those addressed to it as itself, from the real conversation (it reads the thread, its own earlier messages
  included). It answers for you only with a short holding reply, and never agrees to anything for you,
  shares personal details, or acts because someone in the thread asked.
- With it on, the agent may answer a new message without your tap, in that conversation only, one reply
  per incoming message, at most 6 per conversation an hour and 60 a day. Only sent replies count; when
  a limit stops one, you get a note.
- The reply is written by a plain model call with no tools. The incoming text is untrusted data.
- It never agrees to plans, payments or meetings and never shares codes or personal details.
- Every auto-reply is reported in the agent's conversation ("Replied to Sam: …").

**Voice replies** (TextX 0.3.21+): in TextX, each agent has **Replies: Text · Voice · Both**. The choice
arrives as `reply_mode` in `hello` and on every `incoming` and `mention` event, and applies to auto-replies
and @-mention replies. Voice sends the reply spoken in the agent's TTS voice (`reply.m4a`, mono AAC 32 kbps,
at most 45 s) with no text; Both sends text and audio in one `send_sms`. If speech can't be made, the reply
goes as text and the report says so ("as text: the voice reply failed: …"). Needs ffmpeg on the agent's host.
- The phone enforces the toggle and its own limits (TextX 0.3.13: one reply per incoming message within 15 minutes, 6 per conversation an hour); the agent can't widen them.

## Agent extensions (`x.*`)

Beyond the shared protocol, a paired client can ask this agent for `x.status` (the dashboard's
system status), `x.transcribe {audio_b64, mime}` → `{text}` and `x.speak {text}` → `{mime, audio_b64}`.
Each is answered with `x.result {of, ok, data|error}`. They follow the same rules as everything
else on a pairing: only its bound device, sealed end to end, never through the command router.
`welcome.extensions` lists them. The LANAgent Android app (1.4.0) uses them for Status and voice
when it reaches the agent through the relay; TextX doesn't use them.

## Notifications

Each paired phone has **"send my notifications here"** in Settings → TextX. With it on, the
agent's notifications (the ones Telegram gets) also arrive in its TextX conversation.

## Clients

Two kinds of phone app pair with an agent over this protocol. Each pairing is one install of one of them.

| Client | Uses | Notes |
|---|---|---|
| **TextX** (SMS app) | chat + phone tools (§5) | Pair by QR, or on the same phone via **Open in TextX** (dashboard) / **Use in TextX** (LANAgent app) |
| **LANAgent Android** 1.4.0+ | chat + `x.status` / `x.transcribe` / `x.speak` | Pairs itself the first time it reaches the agent at home; uses the relay only when the home address doesn't answer. No phone tools |

## Security model

What each layer guarantees, and what it doesn't.

### Keys and pairing
- A pairing is a 12-byte public **kid** plus a 32-byte random **key**. The key exists only:
  - in the pairing QR/link, shown once by the dashboard (or handed by intent to TextX on the same phone);
  - on the phone: in TextX's Keystore-backed secret store, or the LANAgent app's Keystore-encrypted prefs;
  - on the agent: in Mongo `textx_devices`, encrypted under the agent's `ENCRYPTION_KEY`. It is never hashed, because the agent needs it to decrypt.
- The key is never sent anywhere, not even during pairing. `Authorization: Bearer <kid>` grants nothing by itself.
- Only the agent's owner can mint a pairing (`POST /api/textx/pair` needs the dashboard's JWT or an API key; where the dashboard is limited to trusted networks, so is pairing).

### Encryption and authenticity
- **Every** body, both ways, is AES-256-GCM under the pairing key with a random 96-bit nonce and AAD `textx1|<kid>|p2a` or `textx1|<kid>|a2p`. This covers WebSocket frames, POST/GET bodies, files and the avatar.
- So a frame can't be read, can't be forged, can't be moved to another pairing, and can't be reflected back in the other direction.
- A frame that fails to decrypt is dropped; three on a socket close it (`4400`).

### One pairing, one device
- The first `hello` binds the pairing to that install's random device id.
- After that:
  - A WebSocket is anonymous (no outbox, no frames) until its own hello names the bound device. Another device's hello closes it with `4401`, and the real phone's socket is never touched.
  - Over HTTP, every POST batch must lead with the bound device's hello, and GET/files/avatar carry `?device=`. Anything else is a plaintext `401` and nothing is acted on.
- Someone who copies the QR to a second phone gets nothing from it once the first phone has paired.

### Replays and restarts
- Envelope ids are deduplicated for **7 days**, persisted (`textx_inbox`, TTL), so a captured ciphertext replayed to the agent is acked and ignored. A `ts` older than 7 days, or more than 10 minutes in the future, is dropped.
- A user message is recorded as pending **before** its ack. If the agent restarts mid-answer, it tells the phone afterwards which message was cut off. It does not re-run it, since the request may already have acted.

### The relay (api.lanagent.net)
- Agents dial out to it and prove an Ed25519 key, so no port is opened on anyone's network.
- **It can see:** which agent fingerprint a request is for, the pairing kid (public), request sizes and status codes, client IPs.
- **It can't:** read any content, forge or alter a frame, or reach a different agent than the fingerprint in the path.
- **It stores** nothing, and logs only fingerprint, kind, status and size.
- A compromised relay could drop or delay traffic, or replay old ciphertext (blocked by the dedupe above). It can't impersonate either side.
- **Tenancy:** a phone session is routed only to the link whose fingerprint is in its URL. Fingerprints come from each agent's own key, proven by signature on every link. One agent can't receive another agent's traffic, and two users' data never share a key, an outbox or a conversation.
- **Limits:** 20 phone sessions per agent, 120 frames/min per session, 5 MB per request, 20 link attempts/min per IP, and `TEXTX_RELAY_MAX_AGENTS` (default 1000).

### What a paired device may do
- **Auto-reply** sends without a tap only in a conversation whose TextX toggle is on, with phone-side limits. The composer has no tools and treats the incoming text as data.
- **Tools run only on the phone that asked.** A request typed in one pairing's conversation can drive tool calls on that pairing alone, even if another paired phone allows the tool. A request from Telegram or the dashboard picks the paired phone that allows it.
- Actions that act on someone's behalf (`block*`, `delete*`, `share*` …) need the stricter intent-match threshold, and the plugin refuses a block the user didn't ask for.
- A pairing is its owner's, so the device talks to the agent as the owner, as on Telegram. Keep pairings to your own phones, and revoke lost ones (Settings → TextX → Revoke, or LANAgent app → Away from home off / sign out).
- Phone tools (TextX) are off until switched on in TextX, per agent.
  - **Every send, schedule edit, reaction, delete or block is confirmed by a tap on the phone.**
  - Reads cover only conversations shared with the agent.
  - One-time codes and private (vault) conversations never leave the phone.
- SMS text from other people reaches the model wrapped as **untrusted data**, never as instructions. Watched-conversation events go to a plain model call, never the command router.
- `x.*` extensions run only for the bound device and never go through the command router.

### Limits to know about
- The agent holds every pairing key, encrypted under `ENCRYPTION_KEY` in the same `.env` as everything else. Anyone with root on the agent's host can decrypt that traffic. That is the same trust as the rest of the agent.
- Text the user sends the agent goes to the agent's AI provider, as any chat does. With OpenRouter, the agent requires zero-data-retention routing.
- The relay is a single point of availability, not of confidentiality. If it's down, phones use the home network (or the agent's own `TEXTX_PUBLIC_URL`).

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
