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
| "any unread texts?", "catch me up on the family chat" | `list_threads`, `read_thread`. A question about a conversation ("did Wayne get Orbit's text?") gets an answer from it; "read me the Wayne thread" gets the messages |
| "tell Wayne step one, and walk him through the rest one step at a time" | The text goes out, and the standing job is kept as a note on Wayne that the auto-reply follows when he answers |
| "ok ask him", "text her back" | Who and what come from the conversation you just had with the agent; it writes the text itself when you only said whom to ask |
| "find the text with the gate code" | `search_messages` |
| "what's Sam's number" | `contacts_lookup`. Names in "text Sam …" are also resolved through it. "show my saved contacts" lists what the agent kept |
| "tell me when the landlord replies about the lease" | `watch` (up to 7 days) |
| "what texts are scheduled", "cancel the birthday text", "skip the next Friday reminder" | `list_scheduled`, `cancel_scheduled`, `skip_next`, `update_scheduled`, `send_scheduled_now` (the last two confirmed) |
| "thumbs up Sam's last text", "mark the family chat read" | `react` (confirmed), `mark_read` |
| "block 555-0100" | `block_number` (confirmed) |
| "text the family group…" | `send_sms` to a shared conversation by name (`thread_id`). A file you gave the agent goes out as MMS |
| "reply to Sam's address text: perfect", "text Sam a happy-dance GIF", "text Al and Bo separately" | `send_sms` with `reply_to` (quoted on the phone), a GIF found with `gif_search`, or `individually` (TextX 0.4.32) |
| "mute the family chat until tomorrow", "pin / archive / snooze the Sam thread", "remind me about Wayne's text at 6", "rename the group" | `update_thread` (0.4.32) |
| "make my chat with Sam blue", "reset its look" | `customize_thread` (0.4.32) |
| "pin the address message", "leave a draft for mom saying…" | `pin_message`, `set_draft` (never sends) (0.4.32) |
| "make a Work tab", "add Sam to it", "list my templates", "add a template…" | `manage_tabs`, `templates` (0.4.32) |
| "edit my last text to Sam", "forward Sam's address to mom", "delete the spam conversation" | `edit_message`, `forward_message`, `delete_thread`, each confirmed on the phone (0.4.32) |
| "block texts about car warranties", "what spam got caught" | `block_rules` (clearing all rules is confirmed; caught texts come back as untrusted) (0.4.32) |
| "switch TextX to dark", "add this theme code", "any picture messages waiting?", "back up my texts" | `app_settings` (sensitive ones confirmed), `pending_mms`, `backup` (restore confirmed) (0.4.32); "why is my message list empty?" → `backup` `message_store` (0.4.70) |

The 0.4.32 tools are listed in the agent's `welcome`, which is what lets you switch them on: each is off
until you turn its group on in TextX › the agent's setup screen. Messages show what a reply answers
(`reply_to_quote`), and whether one is pinned or delivered; the conversation list shows pinned, archived,
muted, snoozed and a waiting draft.

The phone itself enforces the guards:

- One-time codes never leave the phone.
- Private conversations don't exist to any assistant.
- Sends are rate-limited.

On the agent side:

- SMS text is wrapped as **untrusted data** and never treated as instructions.
- Watched-conversation events go to a plain model call, never to the command router.

**Messages for the owner** ("tell Pat…", "ask him…", an alert, or anything else that needs them) go to
the owner's conversation with the agent in TextX **and** to Telegram, whether or not auto-reply is on for
that conversation. If one channel fails, the other still delivers. The LANAgent Android app (1.5.0+) gets them
as phone notifications too: its `hello` carries `notify: "owner" | "all" | "off"` (an agent extension; TextX
sends none). At `all` it also gets every agent notification. Messages carry `x_kind: "owner" | "notification"`.

**Contacts the agent sees are kept** (`textx_contacts`: name, numbers, email only): every lookup
result, the people in shared conversations (re-read on connect, at most every 6 hours) and whoever texts
there. A new number also fills the phone field of the one matching card (by name, alias or email) in the
agent's contact book, never replacing one already set. With the phone offline a saved number is used
directly; with it connected the live lookup wins. Turning contact lookup off in TextX stops new lookups.

**Whole address book** (TextX 0.3.29 `contacts_list`, its own switch "Share the whole address book", off
by default): the first connect copies it page by page, then once a day only changes (`since`), dropping
`deleted` ids; the book's numbers and emails replace older ones. Switched off (gone from `hello`, or
`not_allowed`) the copy is dropped; contacts seen in shared conversations stay. Emailing someone by name
falls back to the one phone contact of that exact name with one email.

If the agent restarts while answering, it says afterwards which message it didn't finish (it doesn't re-run it, since the request may already have acted). A send that you haven't tapped yet returns at once ("it's on your phone"). Its outcome (sent,
declined, expired) is reported back to the conversation the request came from.

**From Telegram or the dashboard, with TextX closed on the phone**, the phone has no live
connection and checks in on its own schedule (at most 15 minutes, unless TextX's "Always connected"
is on). The agent waits up to 25 seconds for it. A phone that checks in by then gets you one normal
answer ("Sent to Wayne: …"). Otherwise you get "it's going to your phone… I'll tell you here when it's
done", and the outcome arrives as a notification once the phone picks it up (the agent keeps the
request open for 20 minutes). Opening TextX makes the phone check in at once.

## People across channels (v2.25.581)

Everyone ALICE talks with is one **person** (`people` collection, `src/models/Person.js`), whatever the
channel: an SMS sender, someone she calls on DialX, an email correspondent. A person is found only by
an exact identifier (phone number by its last 10 digits, email, Telegram id, bot id, P2P fingerprint),
never by name; identifiers that point at two people are recorded as a conflict and never merged.

- **History:** every message ALICE is part of with them goes into `transcripts` under `person:<id>`
  with the channel and who spoke (them, the owner, or ALICE). Incoming texts in shared conversations,
  ALICE's auto-replies, texts the owner had her send, DialX calls (the number recorded at scheduling),
  and email correspondents. Not the owner's personal messages.
- **Every reply knows them:** the TextX auto-reply, a DialX call and an email reply get a block with
  who they are, the channels used, learned facts, and the latest exchanges from every channel. It is
  wrapped as untrusted data; in a group conversation it is never repeated to the others.
- **Facts:** after 3+ new messages (at most every 30 minutes per person) or at a call's end, durable
  facts are extracted and stored as knowledge with `metadata.personId` (`category: person_fact`).
  Codes, passwords, PINs and account details are never stored.

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
that conversation (no card for that one send) and tells you what it said. The mention is you talking to the
agent: it answers you, in front of the others, and addresses them only when you ask it to. Someone else typing
`@<agent>` grants nothing. With TextX 0.3.25+ each message carries `author` (owner, assistant or contact), and the
agent sees the thread labelled that way ("Pat (owner)", "ALICE (you)", "Orbit (assistant)", "Wayne").

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
goes as text and the report says so ("as text: the voice reply failed: …"). Audio over the phone's
`max_attachment_bytes` (the carrier MMS cap, sent in hello) is re-encoded at 16 kbps, then sent as text if
still over. Needs ffmpeg on the agent's host.
- The phone enforces the toggle and its own limits (TextX 0.3.13: one reply per incoming message within 15 minutes, 6 per conversation an hour); the agent can't widen them.

**Pictures the owner sends** (v2.25.572): every picture attached to a message in the agent's conversation
goes to the vision model (up to 8). Its description reaches the router as untrusted data with a note that
text read from a picture can be wrong. This covers TextX 0.4.27's long-press "Ask <agent> about this", which
sends a picture as one still and a video or GIF as four. The first file also stays attached for the
plugins, so "send this to Wayne" still forwards it. Telegram photos with a caption are looked at the same way.

## Phone calls: DialX (v2.25.573)

DialX is a dialer app that lets the agent place a call and hold a short conversation ("call Wayne and tell him
happy birthday at 5pm"). It speaks this same protocol. Pair it in its own section, **Settings → DialX — phone calls → Pair DialX**, and scan
the code in DialX (DialX › Settings › Agents › Scan QR). That code uses the `dialx-agent:` scheme: TextX claims
`textx-agent:` links from the camera or clipboard and would keep the pairing for itself. Its tools and events are "DialX call frames v1" (Trellis card 4293):

- **The agent asks:** `dialx.schedule_call {contact_id, at, purpose, opening, opening_audio_b64?, requested_by_owner}`.
  Only the owner can order a call (a TextX phone of theirs, Telegram as them, or the dashboard). Since DialX
  0.3.4, a contact the owner approved for this agent is called with no card. Anyone else is looked up in the
  phone's contacts (`dialx.contacts_lookup`), sent by number, and the owner approves that one call on the phone.
- **The phone runs the call:**
  - a fixed AI disclosure, then the opening;
  - `event {kind: "call.started" | "call.heard" | "call.ended"}`;
  - the agent answers each `call.heard` with `dialx.say {call_id, seq, text, audio_b64?}` or ends with
    `dialx.hangup`.
- **What the callee says is untrusted data**, as with SMS: the agent answers it in one or two spoken sentences,
  never agrees to anything for the owner, and can't use any tool mid-call except say and hang up.
- **The owner gets the transcript** when the call ends (Telegram and the LANAgent app).
- **Voice** (Settings → TextX → Phone calls, or `PUT /api/textx/dialx`):
  - The agent's own voice (default, the Ara preset) is sent as MP3.
  - If that voice fails, takes longer than the wait (default 5 s), is too big, or the phone can't play MP3, the
    line goes as text and the phone speaks it. The call never stalls on the agent's voice.
  - "The phone's voice" always sends text.
- **Limits are DialX's:** 08:00–21:00 in the owner's time, 3 calls an hour and 10 a day, 5 minutes a call, the
  owner's mic muted with a Take over button. A deploy waits while a call is live (`dialx_calls` with no `endedAt`).
- "Call X" is read as a phone call only while a DialX phone is paired. Until then it means what it did before.
- **Voicemail** (DialX 0.3.0, v2.25.575), behind DialX's own switches for this agent:
  - With **Read voicemail** on, every new voicemail (`event {kind: "voicemail.new"}`) reaches the owner with the
    caller, the length and the transcript. The transcript is never given to a model or acted on.
  - The owner can ask "any new voicemails", "what did Wayne say in his voicemail", "mark Wayne's voicemail read" or
    "delete the voicemail from that spam number". Each delete is confirmed on the phone.
  - **Listen to voicemail audio** is a separate switch. With it on, "send me the voicemail from Mom" returns the
    recording as an audio file.

**Invitations** ("BBQ at mine Saturday at 6, you coming?"): the agent never accepts or declines one on its
own. `TEXTX_INVITES` sets what it does:

| Mode | The sender gets (auto-reply on) | You get |
|---|---|---|
| `ask` (default) | "I'll pass it on" | The invitation, what your calendar holds then, "Want to go?" |
| `pass_on` | "I'll pass it on" | The invitation only. Nothing is sent unless you tap a button (for people who usually don't go, free or not) |
| `decline` | A polite no, no reason given | "I declined politely for you" |

Every notice carries Telegram buttons: **Accept** (texts your yes, in your style for that person, and adds
the event with a reminder an hour before), **Decline** (a polite no), **Add to my calendar**. Sends go
to the phone like any other. With auto-reply off the sender gets nothing; you still get the notice.
Buttons work until a restart or 14 days.

### Voicemail (DialX 0.6.0–0.6.2, v2.25.583)

DialX tells a person from voicemail before anything is said (`call.answered {by}`). Every
`schedule_call` carries:
- `voicemail`: written by the model at scheduling (plugin `extract`, same tone as the opening, the
  name the owner used), the owner's own words when given; `voicemailText()` is only the fallback
  ("Hi <name>, this is ALICE, <owner>'s assistant. <owner> asked me to call you to/about …").
- `voicemail_audio_b64` (0.6.1): the same text in the agent voice, rendered in parallel with the
  opening. Without it (phone voice, TTS failed, clip too big) DialX speaks the text.

A call booked without a message gets it by `dialx.say` on `call.voicemail_ready`, voice capped at
2.5 s (DialX waits 8 s), then a hangup. Nothing heard on voicemail is a turn or is stored as the
person's words (it is their greeting). `call.ended {reason:"voicemail_left", voicemail_audio}`
reports "I left a voicemail", then ALICE fetches `dialx.get_call_audio` (0.6.2), converts the WAV to
MP3 with ffmpeg (WAV as a file if that fails) and sends it to the owner on Telegram.

### Live call quality (v2.25.583)

From the first real conversation call (call 3, 2026-10-23): ALICE transcribes `audio_b64` itself and
prefers that over the phone's text (3 s cap; phone text on failure or unclear). A reply made stale by
newer speech is dropped and rewritten (at most twice in a row). The prompt forbids repeating a line
or question and ends the call once "anything else?" brings nothing new. The owner's notes on how to
talk with the person (`hub.ownerNotesFor`) reach the call. Each turn logs `model N ms` and
`voice N ms`. The aux model (gpt-4.1-nano, 1.8 s) is NOT used: it hung up after the first answer;
the main model answered the same turn in 2.2 s.

### Realtime calls (v2.25.620)

Turn-by-turn calls (heard clip → STT → model → TTS → say) take 6-12 s a reply. On a phone whose
DialX hello lists `dialx.realtime`, and with `OPENAI_API_KEY` set, a call ALICE places goes to the
OpenAI Realtime API instead (`src/services/textx/dialxRealtime.js`; protocol on Trellis 4293 #191-#196,
the same frames Orbit speaks):

- `dialx.schedule_call` carries `realtime: true` (not with a voice effect, which stays on turns).
- On `call.answered {by:"person"}` ALICE mints a 60 s client secret (`POST /v1/realtime/client_secrets`)
  with the whole session fixed: instructions (the turn-mode call rules, the purpose, the opening for the
  model to say, the owner's notes about the person), `gpt-realtime-2.1`, the `realtimeVoice` setting
  (default `marin`, the closest to Ara; realtime cannot use ALICE's TTS voices), semantic VAD,
  far-field noise reduction, pcm 24 kHz, and one tool, `hang_up`. The phone gets only the secret, in
  `dialx.realtime`, and opens OpenAI's WebSocket itself. The API key never leaves ALICE.
- `call.realtime_event` forwards both sides' transcripts and function calls (OpenAI's id as `fn_call_id`).
  `hang_up` is answered with `dialx.realtime_tool_output`, then `dialx.hangup`; DialX lets the goodbye finish.
- While realtime is live, `call.heard` is ignored. `call.realtime_failed`, or a secret that cannot be
  minted, leaves the call on turns. Voicemail is unchanged.
- **Which calls (setting `realtimeCalls`, default `all`):** every placed call; `test` = DialX Test calls only (0.7.30, the
  owner on the phone's mic and speaker); `off` = none. Call 32 (2026-10-25) heard nothing of the callee for 4.5 min: the
  phone's capture returned zeros (not realtime); DialX 0.7.32 reopens a dead capture and falls back to turns after 25 s.
- **Multi-agent calls (4293 #216, DialX building):** `call.started {test:true, contact:{agent:true}}` = agent ↔ agent on the
  owner's topic (`purpose`); `participants:[{name, role, self}]` with more than one other = a group call (speak when addressed,
  instructions only from the owner). DialX holds the floor.
- **Silence guard:** no callee transcript 40 s into a realtime call → ALICE hangs up and tells the owner why.
- Overrides: `DIALX_REALTIME=off`, `DIALX_REALTIME_MODEL`, `DIALX_REALTIME_VOICE`.

## Notifications: NotifX (v2.25.586)

NotifX (the owner's notification history app, frames doc `docs/agent-protocol-notifx.md` in the NotifX repo,
locked 2026-10-24 on Trellis NotifX › Agent Card) speaks this protocol unchanged. Code: `src/services/textx/notifx.js`
(events, alerts) and `src/api/plugins/notifx.js` (watch, unwatch, watches, search, active, apps, channels, reply, tap, dismiss).

- **Pairing:** Settings → NotifX → Pair NotifX mints a `notifx-agent:` code (`POST /api/textx/pair {app:"notifx"}`).
  NotifX has no scanner: the owner pastes the text in NotifX › Agents › Add. Each phone is its own pairing; `hello.phone.name`
  is kept as `phoneName` and used to say which phone when more than one is paired.
- **Watches run on the phone.** A notification that matches no watch never leaves it. The agent keeps its own record of each
  watch (`notifxWatches` on the pairing: name, packages, silent).
- **`notification.posted` goes straight to Telegram**, loud, with the snapshot (`include_picture`) when there is one. No model
  call: notification text is someone else's words. The same notification from two phones within 2 minutes is told once.
- **Choosing a filter:** "tell me when someone rings the doorbell" names the app and a label; with no explicit words, the
  plugin reads the app's channels (`list_channels`, ids + one recent title each) and the model picks the channel. Titles only.
- **Owner-only:** every action. Reply and tap wait on the owner's tap on the phone (`NOTIFX_CONFIRMED`).
- The phone owns the guards: per-agent app list (empty by default), one-time codes withheld, 60 calls and 30 events a minute.

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
