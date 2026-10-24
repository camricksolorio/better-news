# Story card

Where: the grid on `/admin/stories` (`app/admin/stories/page.tsx`). Follows
[layout-and-sizing](../principles/layout-and-sizing.md).

## Current design

- Fluid grid, one column on mobile, `auto-fill, minmax(320px, 1fr)` from `sm` up.
- Rounded corners (`rounded-2xl`), 1px border, white / zinc-900 background.
- Content: headline (3-line clamp), then a footer pinned to the bottom with a
  divider: article and source counts, time range, status.
- Height is content-driven; row-mates stretch to match.
- No image, summary, or category yet: stories don't carry them.

## Decisions and deviations

| Decision | Reason |
| --- | --- |
| Rounded corners | Requested explicitly |
| No fixed aspect ratio | Tried 3:4 and then 4:3 first; both left empty space or forced a gap between title and metadata. Content-driven height is the rule in the principles doc |
| Text-only card | No imagery or summaries exist yet; revisit when story summaries ship |
