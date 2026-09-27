---
name: weekly-review-planning
description: Run a weekly review - look back at the past week's calendar, tasks and email, find overdue, stalled and waiting items, and build a realistic plan for next week - use when asked to run my weekly review, what is slipping, or plan next week.
source: hermes-agent
license: MIT
adapted_from: skills/productivity/weekly-review-planning/SKILL.md
---

Adapted from Hermes Agent (NousResearch, MIT licence).

A bounded weekly reset across the operator's systems. Default to recommendations and drafts; change nothing without approval.

## Procedure
1. Set the window: timezone, the week under review, the planning horizon (usually next 1-2 weeks). Trellis is the task source of truth; the LANAgent tasks list is secondary. If they disagree, say so.
2. Calendar evidence:
   - Past week: calendar.getEvents({ startDate, endDate }).
   - Ahead: calendar.getUpcoming({ days: 14 }).
   Capture follow-ups implied by past meetings, and deadlines, travel, prep and conflicts ahead.
3. Clear capture points:
   - trellis-notes.listTasks({ includeDone: false }) (overdue / today / week / later) and trellis-notes.getKanban({ project }).
   - tasks.list({ status: "pending" }).
   - Recent mail needing action: email.searchEmails({ since, limit }) (thread-level work belongs to the email-inbox-triage skill).
   Sort each item: next action, project, waiting, scheduled, someday, reference, archive/delete proposal. Count what stays unprocessed.
4. Reconcile active projects: for each, outcome, next action, owner, deadline, blocker, last real activity, card reference. Flag no next action, missed dates, duplicates, contradictory status.
5. Waiting and commitments: promises the operator made, items owed by others. Propose a follow-up date and channel for each. Silence is not completion.
6. Capacity-aware plan: estimate fixed calendar load, then pick a small set of weekly outcomes plus next actions. Rank by consequence, deadline, dependency, effort. Do not fill every free hour. Name what is deferred.
7. Apply only approved updates:
   - Status: trellis-notes.setTaskStatus({ basket, card, status }); due dates: trellis-notes.setProperty({ card, key: "due", value: "YYYY-MM-DD" }).
   - New tasks: trellis-notes.createTask({ basket, title, body, due, status: "todo" }).
   - Calendar holds: calendar.createEvent({ title, start, end, description }).
   - Follow-up emails: draft only; send after explicit go.
   Read changed cards back with trellis-notes.readCard({ card }).

Scheduled run: the operator can have this run weekly via the scheduler; on a scheduled tick, produce the review and proposals but apply nothing.

## Output shape
1. Wins and completed commitments
2. Overdue or at risk
3. Waiting / follow-ups
4. Stalled or ambiguous projects
5. Next week: outcomes and calendar constraints
6. Proposed updates awaiting approval
7. Coverage gaps (systems not checked, errors)

## Pitfalls
- Planning from tasks without checking calendar capacity.
- Carrying every unfinished item forward as high priority.
- Projects marked active with no next action.
- Silently rescheduling or deleting personal commitments.
- Treating silence from others as done.

## Verification
- [ ] Both the past week and the horizon covered, or gaps stated.
- [ ] Every stalled/waiting flag cites a card, event or email.
- [ ] Nothing changed without approval; changes read back.
- [ ] The plan names what was deferred.
