// Finds and reads the latest eval/v2-run-*.json written by `pnpm eval:v2-dump`. Returns null when there is none
// (production has no eval directory, so the admin page says so instead of failing).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { V2Dump } from "./v2-dump";

export function loadLatestV2Run(dir = path.join(process.cwd(), "eval")): { file: string; dump: V2Dump } | null {
  try {
    const file = readdirSync(dir).filter((f) => /^v2-run-.*\.json$/.test(f)).sort().at(-1);
    if (!file) return null;
    return { file, dump: JSON.parse(readFileSync(path.join(dir, file), "utf8")) as V2Dump };
  } catch {
    return null;
  }
}
