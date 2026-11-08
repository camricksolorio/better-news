# Event labelling page

Where: `/admin/events` (the list) and `/admin/events/[id]` (the queue), in `app/admin/events/`. Built for the owner to
label about 30 sampled events (story-clustering-v2 plan, Phase 2). Follows
[layout-and-sizing](../principles/layout-and-sizing.md) for the list and the audit page's pattern for the queue.

## Current design

- **List:** the same rounded, content-sized cards as the stories grid. Each shows the event title (3-line clamp) and a
  pinned footer with label counts, the split, and whether the owner has started.
- **Queue:** one candidate at a time, the way `/admin/audit` shows one pair. The event's `in` articles sit above it as
  compact cards, so the owner always sees what the candidate is compared against.
- **Actions:** a fixed bottom bar with three large buttons (in, related, out), reachable with a thumb on a phone, plus
  keyboard shortcuts `i`, `r`, `o` and `s` (skip). "Undo last" takes back the latest label.
- **Candidate floor:** 85% similarity by default; a "Show 70–85% too" toggle in the header widens it to 70% for spot-checks.
- **Definition:** pinned behind a "Definition" toggle, as on the audit page, with the same "when in doubt, related" rule.
- **Labelled list:** a toggle that lists every labelled article with buttons to change or clear a label.

## Decisions and deviations

| Decision | Reason |
| --- | --- |
| One candidate at a time, not a list | Matches the audit page, works on a phone, and each `in` changes what is proposed next, so the queue must be recomputed after every label anyway |
| Skip sends an article to the back of the queue for the session | The owner can defer a hard call without losing it; nothing is saved for a skip |
| The server returns the whole event after every label | The client never guesses which candidates a new `in` brought in |
| Default candidate floor 85%, with a toggle down to 70% | In the first event labelled, no `in` article was below 0.90, so most of the 70–85% tail is wasted effort; the toggle keeps a way to look for same-event articles far from the others |
| Seeds can be relabelled but not cleared | An event needs an `in` article to propose anything |
| Candidate cards have no image | Articles carry none; revisit with story-summary-v1 |
