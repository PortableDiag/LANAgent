---
name: systematic-debugging
description: Debug a failing test, error, crash or wrong behavior by finding the root cause before changing code - reproduce it, trace the data, test one hypothesis at a time, then fix with a regression test - use when asked to debug, fix a bug, or figure out why something fails.
source: hermes-agent
license: MIT
adapted_from: skills/software-development/systematic-debugging/SKILL.md
---

Adapted from Hermes Agent (NousResearch, MIT licence).

## The iron law
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST. A symptom fix is a failure. If Phase 1 is not done, do not propose a fix.

In LANAgent's self-modification pipeline, the red/green loop is a node:test file under tests/unit, run with `node --test --test-force-exit tests/unit/<name>.test.js` (full suite: `npm run test:unit`). `npm test` is jest and is NOT the suite in use.

## Phase 1: Root cause
1. Read the error completely: message, full stack, file paths, line numbers, codes. Search the codebase for the error string.
2. Build a tight feedback loop that goes red on the exact symptom and green only when fixed. Fast, deterministic, specific (not just "doesn't crash"). Try in order: failing node:test at the seam that reaches the bug; calling the exported handler/function directly with stub inputs; replaying a captured payload or log line; a differential run (old vs new version, two configs, two providers). For flaky bugs, raise the reproduction rate first (repeat, stress, pin time and randomness). No red-capable loop means gather more data, not guess.
3. Check recent changes: git.log({ limit: 10, oneline: true }) and git.diff({ staged: false }). New dependencies and config/.env changes count.
4. Multi-component systems (route -> service -> DB, plugin -> provider): log what enters and leaves each boundary, run once, find WHERE it breaks, then dig into that component. For a running host, read-only evidence is available via system.run({ command: "journalctl ..." }) or ps/df/free (system.run only allows read-only commands).
5. Trace data flow upstream from the bad value to where it originates. Fix at the source.

Phase 1 is done when: the error is understood, the loop has been run and is red on the real symptom, recent changes reviewed, and the failure is isolated to a component.

## Phase 2: Pattern
- Minimise the repro: cut inputs, callers, config one at a time, re-running after each. Done when any further cut turns it green. The minimal repro is usually the regression test.
- Find similar working code in the repo and read it completely. List every difference between working and broken, however small.
- List the dependencies, config and assumptions the code relies on.

## Phase 3: Hypotheses
- Write 3-5 falsifiable hypotheses, ranked by likelihood and cost to test. Each states its prediction: "if X, then changing Y makes Z happen".
- Test the top one with the smallest probe; one variable at a time. Tag temporary logs with a unique prefix like `[DEBUG-a4f2]` so cleanup is one search.
- Wrong? Form a new hypothesis. Do not stack fixes.
- Do not know? Say "I don't understand X" and gather more.

## Phase 4: Fix
1. Write the failing regression test first (test-driven-development skill). Watch it fail for the right reason.
2. One change at the root cause. No "while I'm here" edits, no bundled refactors.
3. Run the test green, then the full unit suite. `node --check` alone is not a test; it cannot catch a bad import.
4. Remove all `[DEBUG-...]` lines.
5. Rule of three: if 3 fixes have failed, STOP. Each fix exposing new coupling elsewhere means the design is wrong. Report that instead of trying fix #4.

## Red flags (stop, go back to Phase 1)
"Quick fix for now", "just try X", several changes then run tests, "skip the test, I'll check manually", "it's probably X", proposing fixes before tracing data, "one more attempt" after two failures.

## Pitfalls specific to this repo
- A mock whose shape differs from what the real provider returns sends the code down its error branch; assert the happy path was actually reached.
- A child `node --test` that inherits NODE_TEST_CONTEXT reports as a subtest and exits 0 on failure; the pipeline strips it.
- Logged intent is not execution: confirm the path executed, not just that a log line was written.
