# Layout and sizing

Source: adapted from an external news-card UI guide (2026-10); only the parts
that apply to this project are kept.

## Golden rule

**Never fix a container's height and force its content to fit.** A fixed
height (or fixed aspect ratio on a text container) leaves empty space under
short headlines and forces clipping or overflow on long ones.

## Rules

1. **Width is outside-in.** The parent layout (grid or flex) decides a card's
   width; the card is `width: 100%` of its cell. Prefer fluid grids such as
   `repeat(auto-fill, minmax(320px, 1fr))` over fixed column counts.
2. **Height is inside-out.** A card is as tall as its content. No fixed
   pixel/rem heights, no `aspect-ratio` on cards that hold text.
3. **Rows stay uniform through stretch.** Grid items stretch to the tallest
   card in their row (`items-stretch`, card `h-full`). Inside the card, a
   flex column with `margin-top: auto` on the footer keeps footers aligned at
   the bottom edge.
4. **Bound variable text with line clamps.** Headlines clamp to 3 lines.
   Summaries, when present, clamp to 2–3 lines.
5. **Fixed-size media only via `aspect-ratio`.** When a card has an image,
   declare its aspect ratio (16:9 banner) so the layout doesn't shift while it
   loads. A card without an image lets the text fill the card; no empty
   placeholder.
6. **The whole card is the tap target.** Make the full card surface a single
   link while keeping the text selectable.
7. **Gutters.** 24px between cards on wider screens, 16px on mobile.

## Not yet applicable

These come from the source guide and apply once stories carry images or
summaries (see `docs/story-summary-v1/`):

- On mobile (< 768px), switch to a horizontal row card with a small square
  thumbnail on the right, to fit 3–4 stories above the fold.
- Omit summaries on compact mobile cards.
- Nested image radius: inner radius = outer radius − padding.
