// Maps consolidated clusters onto existing story ids (story-clustering-v2 TDD part 6), under the reader-safety rules:
//   1. An article that was never placed in any story may join any story, even an old one.
//   2. When two visible stories merge, the newer one survives and the older is retired into it.
//   3. An article can always move out of a story, into its own story or another.
// Pure: it returns the changes and leaves writing them (and recomputing story aggregates) to the store.
import type { Merge } from "./consolidate";

export type ReconcileCluster = {
  members: string[];
  // The story a frozen or pinned cluster must keep.
  identity: string | null;
  merges: Merge[];
};

export type CurrentArticle = { storyId: string | null; placed: boolean };

export type Move = {
  articleId: string;
  from: string | null;
  // An existing story id, or `new:<lowest article id>` for a story to be created.
  to: string;
  newStory: boolean;
  evidence: Merge[];
};

export type Changes = {
  moves: Move[];
  newStories: { key: string; members: string[] }[];
  retired: { storyId: string; mergedInto: string }[];
};

export function reconcile(
  clusters: ReconcileCluster[],
  current: Map<string, CurrentArticle>,
  stories: Map<string, { createdAt: number }>,
): Changes {
  // Identity clusters claim their stories first; then the biggest clusters, then by lowest article id.
  const lowest = (c: ReconcileCluster) => [...c.members].sort()[0];
  const ordered = [...clusters].sort(
    (x, y) =>
      Number(!!y.identity) - Number(!!x.identity) ||
      y.members.length - x.members.length ||
      lowest(x).localeCompare(lowest(y)),
  );

  const taken = new Set<string>();
  const moves: Move[] = [];
  const newStories: Changes["newStories"] = [];
  const targetOf = new Map<string, string>(); // article -> story it ends up in

  for (const c of ordered) {
    const members = [...c.members].sort();
    let survivor: string | null = null;
    if (c.identity) {
      survivor = c.identity;
    } else {
      const held = new Set<string>();
      for (const m of members) {
        const cur = current.get(m);
        if (cur?.placed && cur.storyId) held.add(cur.storyId);
      }
      // Newest first; the story id breaks a tie in creation time.
      const candidates = [...held].sort(
        (x, y) => (stories.get(y)?.createdAt ?? 0) - (stories.get(x)?.createdAt ?? 0) || y.localeCompare(x),
      );
      survivor = candidates.find((s) => !taken.has(s)) ?? null;
    }

    const newKey = `new:${members[0]}`;
    const target = survivor ?? newKey;
    if (survivor) taken.add(survivor);
    else newStories.push({ key: newKey, members });

    for (const m of members) {
      targetOf.set(m, target);
      const from = current.get(m)?.storyId ?? null;
      if (from !== target) moves.push({ articleId: m, from, to: target, newStory: survivor === null, evidence: c.merges });
    }
  }

  // A story that lost every member it had here is retired into the survivor that took most of them (newest on a tie).
  const members = new Map<string, string[]>();
  for (const [id, cur] of current) if (cur.storyId) members.set(cur.storyId, [...(members.get(cur.storyId) ?? []), id]);
  const retired: Changes["retired"] = [];
  for (const [storyId, ids] of [...members].sort((x, y) => x[0].localeCompare(y[0]))) {
    if (!ids.every((id) => targetOf.has(id) && targetOf.get(id) !== storyId)) continue;
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(targetOf.get(id)!, (counts.get(targetOf.get(id)!) ?? 0) + 1);
    const [mergedInto] = [...counts].sort(
      (x, y) => y[1] - x[1] || (stories.get(y[0])?.createdAt ?? Infinity) - (stories.get(x[0])?.createdAt ?? Infinity) || x[0].localeCompare(y[0]),
    )[0];
    retired.push({ storyId, mergedInto });
  }

  moves.sort((x, y) => x.articleId.localeCompare(y.articleId));
  return { moves, newStories: newStories.sort((x, y) => x.key.localeCompare(y.key)), retired };
}
