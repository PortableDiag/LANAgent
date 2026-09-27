---
name: humanizer
description: Rewrite text so it sounds like a person wrote it, stripping AI-isms (puffery, filler, em dashes, rule of three, sycophancy) - use when asked to humanize, de-AI or make a draft sound natural, and on every outgoing email draft written on the operator's behalf.
source: hermes-agent
license: MIT
adapted_from: skills/creative/humanizer/SKILL.md
---

Adapted from Hermes Agent (NousResearch, MIT licence). Original humanizer by Siqi Chen (github.com/blader/humanizer), based on Wikipedia's "Signs of AI writing".

## Use it on outgoing email drafts
Before any email written for the operator goes out (email.send / email.sendWithAI / email.replyToEmail), run this pass on the draft. The recipient should read a note from a person, not a template.

## Procedure
1. Scan the text for the patterns below.
2. Rewrite each hit. Keep the meaning, facts, names, dates and commitments exactly.
3. Match the intended voice. If a sample of the operator's writing exists (e.g. recent mail from email.getEmails({ folder: "Sent", limit: 20 })), copy its sentence length, greeting/sign-off habits, punctuation and plain word choices. Do not upgrade "stuff" to "elements".
4. Add a pulse: vary sentence length, be specific, say what you think where it fits, use "I" when natural. Clean but soulless still reads as AI.
5. Audit: ask "what makes this obviously AI-generated?", list remaining tells in a few words, then revise once more.
6. Output the final text. Show the audit bullets only if the operator asked for an edit review.

## Pattern catalogue (condensed)
Content
- Puffed significance: "stands as a testament", "pivotal role", "evolving landscape", "marks a shift", "indelible mark". State the plain fact.
- Notability name-dropping and vague authorities: "experts argue", "industry reports", "observers note". Name the source or cut it.
- Tacked-on -ing clauses: "..., highlighting its importance", "ensuring...", "showcasing...".
- Promotional tone: vibrant, nestled, boasts, renowned, breathtaking, groundbreaking, commitment to.
- Formulaic "Despite challenges... future outlook" endings.

Language
- AI vocabulary: delve, crucial, pivotal, intricate, tapestry, testament, underscore, foster, garner, showcase, align with, additionally, key (adj), landscape (abstract).
- Blog cliches: at the end of the day, when it comes to, deep dive, game-changer, lean into, unpack, navigate (challenges), moving forward, circle back.
- Copula avoidance: "serves as / stands as / boasts / features" where "is / has" works.
- "Not only X but Y", "it's not just X, it's Y", and clipped tails like "no guessing."
- Forced triplets (rule of three).
- Synonym cycling to avoid repeating a word.
- False ranges: "from X to Y" with no real scale.
- Hidden actors and subjectless fragments ("No setup needed.").

Style
- Em dash overuse. Prefer commas, periods, parentheses.
- Mechanical bold, bolded inline headers in lists, Title Case Headings, emojis as decoration, curly quotes.
- Fragmented headers and outline structure in what should be a normal message.

Communication
- Chatbot artifacts: "I hope this helps", "Certainly!", "Great question", "Let me know if...", "Here is a...".
- Knowledge-cutoff disclaimers: "as of my last update", "based on available information".
- Sycophancy and servile tone.

Filler and hedging
- Filler: "in order to", "it is important to note that", "due to the fact that".
- Stacked hedges: "could potentially possibly".
- Generic upbeat closers: "the future looks bright", "exciting times ahead".
- Hyphenated pair pileups: data-driven, end-to-end, high-quality, cross-functional.
- Authority tropes: "the real question is", "at its core", "fundamentally", "what really matters".
- Signposting: "let's dive in", "here's what you need to know", "without further ado".

Rhetoric
- Forced metaphors and figurative overwriting.
- Dramatic fragments and punchy kickers ("And that changes everything.").
- Rhetorical question answered immediately ("The result? ...").
- Opener tics: "So,", "Look,", "Interestingly,", "Notably,", "Ultimately,".
- Reassurance kickers: "You've got this.", "Don't worry, it's easier than it sounds."

## Email-specific checks
- First line gets to the point; no "I hope this email finds you well".
- One ask per email where possible, stated plainly.
- Sign-off matches the operator's habit, not "Best regards" by default.
- No bullet lists or bold in a short personal note.
- Keep it as short as the purpose allows. Cut any sentence that exists to sound thorough.

## Pitfalls
- Changing facts, numbers, dates or promises while rewriting. The rewrite is style only.
- Swapping one AI tell for another (removing em dashes, adding "Notably,").
- Over-casualising formal mail (legal, billing, a first contact).
- Treating the catalogue as a word ban. A pattern is a tell when it is habitual, not when used once with purpose.
