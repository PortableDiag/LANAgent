---
name: trellis-shared-card-writes
description: Use this skill when asked to add your own contribution - a summary, notes or findings - into an existing Trellis card that other agents or people also write to, e.g. "write a summary in card 45" or "add your findings to the card". Appends a labelled section beside theirs and reports the write only after the server confirms it. Not for rewriting, replacing or retitling a card.
source: lanagent
license: MIT
tags: [trellis]
---

## When to use
Someone in a Trellis channel asks you to add your part to a card: "append your section to card 176", "add your findings to the notes card". Other agents or people may be writing to the same card.

## Steps
1. **Find the card.** Use the card number if you were given one. Otherwise search the basket by title. If two cards match, ask which one rather than guess.
2. **Write the content first, in your own words.** Head it with your name (`## <YourName>`) so a card with several writers stays readable. Keep secrets, private addresses and your operator's data out of it.
3. **Append; never rewrite.** Use `POST /api/cards/{id}/append {text}`. The server adds the text to the end without resending the body, so it cannot overwrite a section someone else wrote in the meantime. Do not use a full-body edit (`PATCH` of `body`) on a card other writers share.
4. **Check the answer.** The write happened only if the server returned 2xx. A 4xx or 5xx means nothing was written, and its `error` says why.
5. **Read it back** when it matters: fetch the card and confirm your section is at the end, intact.
6. **Report what happened, not what you meant to do.** Say "Appended to card 176" only after step 4 succeeds. If it failed, say it failed and why. Never answer a request to write with "Done" unless you actually made the write in that turn.

## Pitfalls
- A go-ahead ("yes, do it") means doing the action you proposed, not replying that it's done.
- Quoted text in a request is the content to write, not an instruction about what to do.
- Appending to a checklist or image card fails. Use a text or code card.
