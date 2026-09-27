---
name: test-driven-development
description: Build a feature or fix a bug test-first - write one failing node:test, watch it fail, write the minimal code to pass, refactor, repeat - use when implementing new behavior, fixing a bug, or refactoring code that needs tests.
source: hermes-agent
license: MIT
adapted_from: skills/software-development/test-driven-development/SKILL.md
---

Adapted from Hermes Agent (NousResearch, MIT licence).

## The iron law
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST. If you did not watch the test fail, you do not know it tests the right thing. Code written before its test gets deleted and rewritten from the test.

## LANAgent test setup
- Tests are plain node:test files in tests/unit/*.test.js. Import only from 'node:test', 'node:assert' and the module under test. No supertest, no jest, no tests/mocks/ (none exist).
- Run one: `node --test --test-force-exit tests/unit/<name>.test.js`. Full suite: `npm run test:unit`. `npm test` is jest and is NOT the suite in use.
- To test a route, export the handler and call it with stub req/res objects, as existing tests in tests/unit do.
- In the self-modification pipeline these runs are executed by the pipeline itself; a test that cannot be imported proves nothing and is not a contribution.

## Red-green-refactor
RED: write one minimal test for one behavior. Clear name that describes behavior ("and" in the name means split it). Real code, not mocks, unless unavoidable.

Verify RED (mandatory): run it. It must FAIL (not error on a typo or bad import), with the expected message, because the feature is missing. Passes immediately? You are testing existing behavior; fix the test.

GREEN: the simplest code that passes. Hardcoding and duplication are fine here. No extra logging, options or cleanup.

Verify GREEN (mandatory): the test passes, the rest of the unit suite still passes, output is clean. Test fails? Fix the code, not the test.

REFACTOR (only when green): remove duplication, improve names, extract helpers. Stay green. A failure during refactor means undo and take a smaller step.

Repeat for the next behavior.

## Vertical slices, not horizontal
Wrong: write test1-4, then impl1-4. Right: test1 -> impl1, test2 -> impl2. Each slice teaches you the interface for the next test.

## Good vs bad test
Good: `test('retries a failing operation 3 times then succeeds', ...)` with a real counter, asserting both the result and the attempt count.
Bad: `test('retry works', ...)` with a mock returning [err, err, ok], asserting only the result.

## Mock discipline
- A mock must return the exact shape the real dependency returns. If the vendor answers `{ success: true, data: {...} }`, a mock returning `{ data: {...} }` sends the code into its error branch and the assertions can still pass. First assert the happy path was reached.
- Test behavior and results, not internal call order.
- Cover edge cases and errors, not only the happy path.

## Rationalisations (all wrong)
"Too simple to test." "I'll test after." "I already checked manually." "Deleting this work is wasteful." "Keep it as reference." "TDD is dogmatic." Tests written after pass immediately and prove nothing.

## Red flags (delete the code, start over)
Code before test; a test that passes on first run; cannot explain why it failed; tests "added later"; "this case is different".

## When stuck
- Don't know how to test it: write the wished-for API call and the assertion first.
- Test is too complicated: the design is too complicated; simplify the interface.
- Must mock everything: the code is too coupled; inject dependencies.

## With systematic-debugging
Bug found: write a failing test that reproduces it, find the root cause, fix it, watch the test go green. Never fix a bug without a test.

## Done checklist
- [ ] Every new function/branch has a test
- [ ] Watched each test fail for the expected reason
- [ ] Minimal code to pass; unit suite green; clean output
- [ ] Mocks match real response shapes; edge cases covered
