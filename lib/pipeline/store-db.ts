// Database StoryStore: pgvector kNN over clustered articles in stories whose window fits.
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { feedItems, stories, storyAssignments } from "@/db/schema";
import {
  nextStoryState,
  type ArticleInput,
  type AssignmentInfo,
  type Candidate,
  type ClusterConfig,
  type StoryState,
  type StoryStore,
} from "./assign";

export const parseVector = (v: unknown): number[] =>
  Array.isArray(v) ? (v as number[]) : (JSON.parse(String(v)) as number[]);

const vectorLiteral = (v: number[]) => JSON.stringify(v);

type CandidateRow = {
  id: string;
  first_article_at: Date;
  last_article_at: Date;
  window_ends_at: Date;
  centroid: string;
  article_count: number;
  source_count: number;
  top_score: number;
  centroid_score: number;
};

export function createDbStore(db: Db, pipelineVersion: string): StoryStore {
  return {
    async candidates(article: ArticleInput, cfg: ClusterConfig): Promise<Candidate[]> {
      const e = vectorLiteral(article.embedding);
      const rows = (await db.execute(sql`
        WITH nn AS (
          SELECT f.story_id, 1 - (f.embedding <=> ${e}::vector) AS sim
          FROM feed_items f
          JOIN stories s ON s.id = f.story_id
          WHERE f.clustered_at IS NOT NULL
            AND f.embedding_model = ${cfg.model}
            AND s.last_article_at - (${cfg.windowHours}::double precision * interval '1 hour') <= ${article.time.toISOString()}::timestamptz
            AND ${article.time.toISOString()}::timestamptz <= s.window_ends_at
          ORDER BY f.embedding <=> ${e}::vector
          LIMIT ${cfg.k}
        )
        SELECT s.id, s.first_article_at, s.last_article_at, s.window_ends_at, s.centroid::text AS centroid,
               s.article_count, s.source_count,
               max(nn.sim) AS top_score,
               1 - (s.centroid <=> ${e}::vector) AS centroid_score
        FROM nn JOIN stories s ON s.id = nn.story_id
        GROUP BY s.id
      `)) as unknown as CandidateRow[];

      return rows.map((r) => ({
        story: {
          id: r.id,
          firstAt: new Date(r.first_article_at),
          lastAt: new Date(r.last_article_at),
          windowEndsAt: new Date(r.window_ends_at),
          centroid: parseVector(r.centroid),
          articleCount: r.article_count,
          sourceCount: r.source_count,
        },
        topScore: Number(r.top_score),
        centroidScore: Number(r.centroid_score),
      }));
    },

    async createStory(article: ArticleInput, cfg: ClusterConfig): Promise<string> {
      const [row] = await db
        .insert(stories)
        .values({
          firstArticleAt: article.time,
          lastArticleAt: article.time,
          windowEndsAt: new Date(article.time.getTime() + cfg.windowHours * 3_600_000),
          centroid: article.embedding,
        })
        .returning({ id: stories.id });
      return row.id;
    },

    async addToStory(story: StoryState, article: ArticleInput, cfg: ClusterConfig): Promise<void> {
      const [{ n }] = (await db.execute(sql`
        SELECT count(*)::int AS n FROM feed_items WHERE story_id = ${story.id} AND source_id = ${article.sourceId}
      `)) as unknown as { n: number }[];
      const next = nextStoryState(story, article, cfg.windowHours, n === 0);
      await db
        .update(stories)
        .set({
          centroid: next.centroid,
          firstArticleAt: next.firstAt,
          lastArticleAt: next.lastAt,
          windowEndsAt: next.windowEndsAt,
          articleCount: next.articleCount,
          sourceCount: next.sourceCount,
        })
        .where(eq(stories.id, story.id));
    },

    async recordAssignment(article: ArticleInput, storyId: string, info: AssignmentInfo): Promise<void> {
      await db
        .update(feedItems)
        .set({ storyId, clusteredAt: sql`now()` })
        .where(eq(feedItems.id, article.id));
      await db.insert(storyAssignments).values({
        articleId: article.id,
        storyId,
        method: info.method,
        topScore: info.topScore,
        centroidScore: info.centroidScore,
        llmCallId: info.llmCallId ?? null,
        llmVerdict: info.llmVerdict ?? null,
        pipelineVersion,
      });
    },
  };
}
