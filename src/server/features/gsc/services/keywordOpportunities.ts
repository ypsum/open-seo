// Fork (ypsum): where impressions should turn into clicks. Joins Search
// Console queries (with the page that ranks) to DataForSEO search volume and
// the latest tracked position, and ranks them by click potential: the clicks
// the query would bring at position 3 minus the clicks it brings today.
import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { GscService } from "@/server/features/gsc/services/GscService";
import type { GscDateRange } from "@/server/features/gsc/searchAnalytics";
import { RankTrackingService } from "@/server/features/rank-tracking/services/RankTrackingService";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";

/** Volume moves slowly; a month keeps weekly reviews free. */
const VOLUME_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Queries priced per call: Labs keyword_overview takes up to 700. */
const MAX_VOLUME_LOOKUPS = 300;
const TARGET_POSITION = 3;

/** Organic CTR by position, a conservative blend of public CTR studies. */
const CTR_BY_POSITION = [
  0.28, 0.15, 0.11, 0.08, 0.07, 0.05, 0.04, 0.03, 0.03, 0.025,
];

function ctrAt(position: number | null): number {
  if (position == null) return 0;
  const rounded = Math.max(1, Math.round(position));
  if (rounded <= CTR_BY_POSITION.length) return CTR_BY_POSITION[rounded - 1];
  return rounded <= 20 ? 0.01 : 0.002;
}

type QueryAggregate = {
  query: string;
  clicks: number;
  impressions: number;
  weightedPosition: number;
  pages: Map<string, number>;
};

function aggregateByQuery(
  rows: {
    keys?: string[];
    clicks: number;
    impressions: number;
    position: number;
  }[],
) {
  const byQuery = new Map<string, QueryAggregate>();
  for (const row of rows) {
    const [query, page] = row.keys ?? [];
    if (!query) continue;
    const entry = byQuery.get(query) ?? {
      query,
      clicks: 0,
      impressions: 0,
      weightedPosition: 0,
      pages: new Map<string, number>(),
    };
    entry.clicks += row.clicks;
    entry.impressions += row.impressions;
    entry.weightedPosition += row.position * row.impressions;
    if (page)
      entry.pages.set(page, (entry.pages.get(page) ?? 0) + row.impressions);
    byQuery.set(query, entry);
  }
  return [...byQuery.values()];
}

// Wrapped so a cached "no volume" (null) differs from a cache miss (null).
const volumeSchema = z.object({ volume: z.number().nullable() });

async function getVolumes(
  queries: string[],
  market: { locationCode: number; languageCode: string; projectId: string },
  billingCustomer: BillingCustomerContext,
): Promise<Map<string, number | null>> {
  const volumes = new Map<string, number | null>();
  const keys = await Promise.all(
    queries.map(async (query) => ({
      query,
      key: await buildCacheKey("ypsum:keyword-volume", {
        organizationId: billingCustomer.organizationId,
        locationCode: market.locationCode,
        languageCode: market.languageCode,
        query,
      }),
    })),
  );
  const missing: typeof keys = [];
  await Promise.all(
    keys.map(async (entry) => {
      const cached = volumeSchema.safeParse(await getCached(entry.key));
      if (cached.success) volumes.set(entry.query, cached.data.volume);
      else missing.push(entry);
    }),
  );
  if (missing.length === 0) return volumes;

  const dataforseo = createDataforseoClient(billingCustomer);
  const items = await dataforseo.labs.keywordOverview({
    keywords: missing.map((entry) => entry.query),
    locationCode: market.locationCode,
    languageCode: market.languageCode,
  });
  const found = new Map(
    items.map((item) => [
      (item.keyword ?? "").toLowerCase(),
      item.keyword_info?.search_volume ?? null,
    ]),
  );
  for (const entry of missing) {
    // Labs answers only the keywords it knows; the rest have no volume.
    const volume = found.get(entry.query.toLowerCase()) ?? null;
    volumes.set(entry.query, volume);
    waitUntil(
      setCached(entry.key, { volume }, VOLUME_TTL_SECONDS).catch((error) => {
        console.error("keyword-opportunities.volume-cache failed:", error);
      }),
    );
  }
  return volumes;
}

async function getTrackedPositions(projectId: string) {
  const positions = new Map<string, number>();
  const configs = await RankTrackingService.getConfigs(projectId);
  const trackers = await Promise.all(
    configs.map((config) =>
      RankTrackingService.getTracker(config.id, projectId),
    ),
  );
  for (const { results } of trackers) {
    for (const row of results.rows) {
      const best = [row.mobile?.position, row.desktop?.position]
        .filter((position) => position != null)
        .reduce<
          number | null
        >((min, position) => (min == null ? position : Math.min(min, position)), null);
      if (best == null) continue;
      const key = row.keyword.toLowerCase();
      positions.set(key, Math.min(positions.get(key) ?? best, best));
    }
  }
  return positions;
}

async function getKeywordOpportunities(
  input: {
    projectId: string;
    locationCode: number;
    languageCode: string;
    dateRange: GscDateRange;
    minImpressions: number;
    limit: number;
  },
  billingCustomer: BillingCustomerContext,
) {
  const performance = await GscService.getPerformance({
    projectId: input.projectId,
    dimensions: ["query", "page"],
    dateRange: input.dateRange,
    rowLimit: 5000,
  });
  const startDate = performance.request.startDate;
  const endDate = performance.request.endDate;
  const days =
    startDate && endDate
      ? Math.max(
          1,
          Math.round(
            (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000,
          ) + 1,
        )
      : 28;

  const queries = aggregateByQuery(performance.rows).filter(
    (entry) => entry.impressions >= input.minImpressions,
  );
  queries.sort((a, b) => b.impressions - a.impressions);
  const priced = queries.slice(0, MAX_VOLUME_LOOKUPS);

  const [volumes, tracked] = await Promise.all([
    getVolumes(
      priced.map((entry) => entry.query),
      input,
      billingCustomer,
    ),
    getTrackedPositions(input.projectId),
  ]);

  const rows = priced.map((entry) => {
    const position = entry.impressions
      ? Math.round((entry.weightedPosition / entry.impressions) * 10) / 10
      : null;
    const pages = [...entry.pages.entries()];
    pages.sort((a, b) => b[1] - a[1]);
    const volume = volumes.get(entry.query) ?? null;
    // Demand in the same window as the clicks: monthly volume scaled to the
    // window, or the impressions Google reported when Labs has no volume.
    const demand = volume != null ? (volume * days) / 30 : entry.impressions;
    const potential = Math.max(
      0,
      Math.round(demand * ctrAt(TARGET_POSITION) - entry.clicks),
    );
    return {
      query: entry.query,
      clickPotential: potential,
      searchVolume: volume,
      impressions: entry.impressions,
      clicks: entry.clicks,
      ctr: entry.impressions
        ? Math.round((entry.clicks / entry.impressions) * 1000) / 1000
        : 0,
      gscPosition: position,
      trackedPosition: tracked.get(entry.query.toLowerCase()) ?? null,
      page: pages[0]?.[0] ?? null,
      otherPages: pages.length - 1,
    };
  });
  rows.sort((a, b) => b.clickPotential - a.clickPotential);

  return {
    siteUrl: performance.siteUrl,
    startDate,
    endDate,
    days,
    targetPosition: TARGET_POSITION,
    queriesConsidered: priced.length,
    rows: rows.slice(0, input.limit),
  };
}

export const KeywordOpportunityService = {
  getKeywordOpportunities,
} as const;
