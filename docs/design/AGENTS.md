# docs/design — design principles and system

The standing home for how Better News looks and behaves. Unlike the feature
folders in `docs/`, nothing here is tied to one piece of work: it is
reference that every UI change is built against.

## Layout

```
docs/design/
  AGENTS.md              # this file: how to use and extend the docs, plus the index
  principles/<topic>.md  # general, reusable rules (why + what), independent of any one component
  components/<name>.md   # how the principles apply to one component, and where it deviates
```

Add a new file rather than growing an existing one past its topic. Use
kebab-case names. Add every new file to the index below.

## Rules for agents

- Read the relevant principles and component docs before building or
  changing UI. If a component doc exists, it is the source of truth for that
  component.
- Principles are defaults. A project-specific constraint may override one,
  but record the override and the reason in the component doc so it isn't
  rediscovered later.
- When a UI decision is settled in conversation or review, write it down
  here in the same change.
- Record only rules we actually follow. Don't paste in external guides
  wholesale; extract the part that applies and say where it came from.
- Status of work lives in a feature's `plan.md`, never here.

## Index

| Doc | Covers |
| --- | --- |
| [principles/layout-and-sizing.md](principles/layout-and-sizing.md) | How containers are sized: width from the layout, height from the content |
| [components/story-card.md](components/story-card.md) | The story card on `/admin/stories` |
