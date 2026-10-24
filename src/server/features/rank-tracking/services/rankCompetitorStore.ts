// Fork (ypsum): competitor positions read off the same results page as each
// rank check. Stored as one R2 object per run, keyword and device instead of a
// table, so the fork adds no migration that would collide with upstream's
// numbered migrations on every sync.
import { env } from "cloudflare:workers";
import { z } from "zod";
import { ProjectContextRepository } from "@/server/features/project-context/repositories/ProjectContextRepository";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { AppError } from "@/server/lib/errors";
import type { RankCheckResult } from "@/server/lib/dataforseo";

const PREFIX = "ypsum/rank-competitors/";
const MAX_COMPETITORS = 10;

const positionSchema = z.object({
  position: z.number().nullable(),
  url: z.string().nullable(),
});

const storedCheckSchema = z.object({
  runId: z.string(),
  keywordId: z.string(),
  keyword: z.string(),
  device: z.enum(["desktop", "mobile"]),
  checkedAt: z.string(),
  own: positionSchema,
  competitors: z.array(positionSchema.extend({ domain: z.string() })),
});

type StoredCheck = z.infer<typeof storedCheckSchema>;

function normalizeDomain(domain: string) {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

/** Project-context competitors, without the tracked domain itself. */
export async function listCompetitorDomains(
  projectId: string,
  ownDomain: string,
): Promise<string[]> {
  const own = normalizeDomain(ownDomain);
  const rows = await ProjectContextRepository.listCompetitors(projectId);
  const domains = rows
    .map((row) => normalizeDomain(row.domain))
    .filter((domain) => domain && domain !== own);
  return [...new Set(domains)].slice(0, MAX_COMPETITORS);
}

export async function saveCompetitorPositions(
  ctx: { configId: string; runId: string; competitorDomains: string[] },
  results: (RankCheckResult & { device: "desktop" | "mobile" })[],
): Promise<void> {
  if (ctx.competitorDomains.length === 0) return;
  const checkedAt = new Date().toISOString();
  await Promise.all(
    results
      .filter((result) => result.competitors)
      .map((result) => {
        const stored: StoredCheck = {
          runId: ctx.runId,
          keywordId: result.keywordId,
          keyword: result.keyword,
          device: result.device,
          checkedAt,
          own: { position: result.position, url: result.url },
          competitors: result.competitors ?? [],
        };
        return env.R2.put(
          `${PREFIX}${ctx.configId}/${ctx.runId}/${result.keywordId}:${result.device}.json`,
          JSON.stringify(stored),
          { httpMetadata: { contentType: "application/json" } },
        );
      }),
  );
}

async function listRunKeys(configId: string) {
  const byRun = new Map<string, { keys: string[]; uploaded: number }>();
  let cursor: string | undefined;
  do {
    const page = await env.R2.list({ prefix: `${PREFIX}${configId}/`, cursor });
    for (const object of page.objects) {
      const runId = object.key.slice(PREFIX.length).split("/")[1];
      if (!runId) continue;
      const entry = byRun.get(runId) ?? { keys: [], uploaded: 0 };
      entry.keys.push(object.key);
      entry.uploaded = Math.max(entry.uploaded, object.uploaded.getTime());
      byRun.set(runId, entry);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return byRun;
}

/** Competitor positions of the newest `runs` checks, newest first. */
export async function getCompetitorHistory(input: {
  projectId: string;
  configId: string;
  runs: number;
}) {
  const config = await RankTrackingRepository.getConfigById({
    configId: input.configId,
    projectId: input.projectId,
  });
  if (!config) {
    throw new AppError("NOT_FOUND", "Rank tracking config not found");
  }
  const runs = input.runs;
  const byRun = await listRunKeys(input.configId);
  const entries = [...byRun.entries()];
  entries.sort((a, b) => b[1].uploaded - a[1].uploaded);
  const newest = entries.slice(0, runs);
  return Promise.all(
    newest.map(async ([runId, { keys }]) => {
      const checks = await Promise.all(
        keys.map(async (key) => {
          const object = await env.R2.get(key);
          if (!object) return null;
          const parsed = storedCheckSchema.safeParse(
            JSON.parse(await object.text()),
          );
          return parsed.success ? parsed.data : null;
        }),
      );
      const valid = checks.filter((check) => check != null);
      valid.sort((a, b) => a.keyword.localeCompare(b.keyword));
      return {
        runId,
        checkedAt: valid[0]?.checkedAt ?? null,
        checks: valid,
      };
    }),
  );
}
