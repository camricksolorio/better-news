// In-memory StoryStore: brute-force kNN, same window and scoring rules as the database store.
// Used by the eval replay harness and the assignment tests.
import {
  cosine,
  fitsWindow,
  nextStoryState,
  type ArticleInput,
  type AssignmentInfo,
  type Candidate,
  type ClusterConfig,
  type StoryState,
  type StoryStore,
} from "./assign";

export type MemoryStore = StoryStore & {
  stories: Map<string, StoryState>;
  members: Map<string, ArticleInput[]>;
  assignments: { articleId: string; storyId: string; info: AssignmentInfo }[];
};

// `memberSim` lets a caller supply precomputed similarities (the explorer UI does); the default
// computes cosine from the vectors.
export function createMemoryStore(
  memberSim: (article: ArticleInput, member: ArticleInput) => number = (a, m) => cosine(a.embedding, m.embedding),
): MemoryStore {
  const stories = new Map<string, StoryState>();
  const members = new Map<string, ArticleInput[]>();
  const assignments: MemoryStore["assignments"] = [];
  let nextId = 1;

  return {
    stories,
    members,
    assignments,

    async candidates(article: ArticleInput, cfg: ClusterConfig): Promise<Candidate[]> {
      // Keep only the k most similar members (a small sorted list) instead of sorting them all.
      const top: { storyId: string; memberId: string; sim: number }[] = [];
      for (const [storyId, story] of stories) {
        if (!fitsWindow(story, article.time, cfg.windowHours)) continue;
        for (const m of members.get(storyId) ?? []) {
          const sim = memberSim(article, m);
          if (top.length === cfg.k && sim <= top[top.length - 1].sim) continue;
          let i = top.length;
          while (i > 0 && top[i - 1].sim < sim) i--;
          top.splice(i, 0, { storyId, memberId: m.id, sim });
          if (top.length > cfg.k) top.pop();
        }
      }
      // `top` is sorted by similarity, so the first entry per story is its best member.
      const bestByStory = new Map<string, { memberId: string; sim: number }>();
      for (const n of top) if (!bestByStory.has(n.storyId)) bestByStory.set(n.storyId, n);
      return [...bestByStory].map(([storyId, best]) => {
        const story = stories.get(storyId)!;
        // The earliest member, ties by id, matching the database store.
        const first = [...members.get(storyId)!].sort((a, b) => a.time.getTime() - b.time.getTime() || a.id.localeCompare(b.id))[0];
        return {
          story,
          topScore: best.sim,
          centroidScore: cosine(article.embedding, story.centroid),
          firstArticleId: first.id,
          topMemberId: best.memberId,
        };
      });
    },

    async createStory(article: ArticleInput, cfg: ClusterConfig): Promise<string> {
      const id = `s${nextId++}`;
      stories.set(id, {
        id,
        firstAt: article.time,
        lastAt: article.time,
        windowEndsAt: new Date(article.time.getTime() + cfg.windowHours * 3_600_000),
        centroid: [...article.embedding],
        articleCount: 1,
        sourceCount: 1,
      });
      members.set(id, [article]);
      return id;
    },

    async addToStory(story: StoryState, article: ArticleInput, cfg: ClusterConfig): Promise<void> {
      const list = members.get(story.id)!;
      const newSource = !list.some((m) => m.sourceId === article.sourceId);
      stories.set(story.id, nextStoryState(story, article, cfg.windowHours, newSource));
      list.push(article);
    },

    async recordAssignment(article: ArticleInput, storyId: string, info: AssignmentInfo): Promise<void> {
      assignments.push({ articleId: article.id, storyId, info });
    },
  };
}
