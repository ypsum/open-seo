// Fork (ypsum): where impressions should turn into clicks. Joins Search
// Console queries (with the page that ranks) to local Google Ads search volume
// and the latest tracked position, and ranks them by click potential.
//
// Demand: on page 1 (average position <= 10) the site is shown on nearly every
// search, so its impressions are the real local demand. Below page 1 most
// searches never load the result, so local volume (scaled to the window)
// stands in, falling back to impressions as a lower bound.
// Potential = demand x CTR at the target position - clicks today. The target
// is position 3, or the current position when it is already better, so a top
// result with a weak CTR still shows its snippet gap.
import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { GscService } from "@/server/features/gsc/services/GscService";
import type { GscDateRange } from "@/server/features/gsc/searchAnalytics";
import { RankTrackingService } from "@/server/features/rank-tracking/services/RankTrackingService";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { fetchAdsSearchVolumeForKeywords } from "@/server/lib/dataforseo/keyword-metrics";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";

/** Volume moves slowly; a month keeps weekly reviews free. */
const VOLUME_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Queries priced per call: Google Ads search_volume takes up to 1000. */
const MAX_VOLUME_LOOKUPS = 300;
const PAGE_ONE = 10;
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

const MAP_PACK_GSC_POSITION = 5;
const MAP_PACK_ORGANIC_FLOOR = 20;

function compact(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Brand queries ask for the business by name; they are not opportunities. */
function isBrandQuery(query: string, brandTerms: readonly string[]) {
  const q = compact(query);
  return brandTerms.some((term) => {
    const t = compact(term);
    return t.length >= 3 && q.includes(t);
  });
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
  market: {
    locationCode: number;
    languageCode: string;
    locationName: string | null;
  },
  billingCustomer: BillingCustomerContext,
): Promise<Map<string, number | null>> {
  const volumes = new Map<string, number | null>();
  const keys = await Promise.all(
    queries.map(async (query) => ({
      query,
      key: await buildCacheKey("ypsum:keyword-volume", {
        organizationId: billingCustomer.organizationId,
        locationCode: market.locationCode,
        locationName: market.locationName,
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
  // Google Ads, not Labs: it accepts a city (Labs only knows countries, and a
  // national volume overstates a local business's demand) and covers more
  // long-tail local queries.
  const items = await fetchAdsSearchVolumeForKeywords(dataforseo, {
    keywords: missing.map((entry) => entry.query),
    locationCode: market.locationCode,
    languageCode: market.languageCode,
    ...(market.locationName ? { locationName: market.locationName } : {}),
  });
  const found = new Map(
    items.map((item) => [
      (item.keyword ?? "").toLowerCase(),
      item.search_volume ?? null,
    ]),
  );
  for (const entry of missing) {
    // Keywords Google Ads rejects or does not know have no volume.
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

async function getTrackedPositions(
  configs: Awaited<ReturnType<typeof RankTrackingService.getConfigs>>,
  projectId: string,
) {
  const positions = new Map<string, number>();
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
    brandTerms: string[];
    includeBrand: boolean;
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

  const aboveFloor = aggregateByQuery(performance.rows).filter(
    (entry) => entry.impressions >= input.minImpressions,
  );
  const brandQueries = aboveFloor.filter((entry) =>
    isBrandQuery(entry.query, input.brandTerms),
  );
  const queries = input.includeBrand
    ? aboveFloor
    : aboveFloor.filter((entry) => !brandQueries.includes(entry));
  queries.sort((a, b) => b.impressions - a.impressions);
  const priced = queries.slice(0, MAX_VOLUME_LOOKUPS);

  // The oldest tracker's place is the business's home market (configs come
  // oldest first); without a local tracker volume stays national.
  const configs = await RankTrackingService.getConfigs(input.projectId);
  const volumeLocation =
    configs.find((config) => config.locationName)?.locationName ?? null;
  const [volumes, tracked] = await Promise.all([
    getVolumes(
      priced.map((entry) => entry.query),
      { ...input, locationName: volumeLocation },
      billingCustomer,
    ),
    getTrackedPositions(configs, input.projectId),
  ]);

  const rows = priced.map((entry) => {
    const position = entry.impressions
      ? Math.round((entry.weightedPosition / entry.impressions) * 10) / 10
      : null;
    const pages = [...entry.pages.entries()];
    pages.sort((a, b) => b[1] - a[1]);
    const volume = volumes.get(entry.query) ?? null;
    // Demand in the same window as the clicks (see the header comment).
    const onPageOne = position != null && position <= PAGE_ONE;
    const demand =
      onPageOne || volume == null ? entry.impressions : (volume * days) / 30;
    const target =
      position != null && position < TARGET_POSITION
        ? position
        : TARGET_POSITION;
    const potential = Math.max(
      0,
      Math.round(demand * ctrAt(target) - entry.clicks),
    );
    const trackedPosition = tracked.get(entry.query.toLowerCase()) ?? null;
    // Search Console counts the map pack as a position, so a local business
    // can show a top average while its website ranks nowhere organically.
    const likelyMapPack =
      position != null &&
      position <= MAP_PACK_GSC_POSITION &&
      (trackedPosition == null || trackedPosition > MAP_PACK_ORGANIC_FLOOR);
    return {
      query: entry.query,
      isBrand: brandQueries.includes(entry),
      likelyMapPack,
      clickPotential: potential,
      searchVolume: volume,
      impressions: entry.impressions,
      clicks: entry.clicks,
      ctr: entry.impressions
        ? Math.round((entry.clicks / entry.impressions) * 1000) / 1000
        : 0,
      gscPosition: position,
      trackedPosition,
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
    volumeLocation,
    queriesConsidered: priced.length,
    brandQueriesExcluded: input.includeBrand ? 0 : brandQueries.length,
    rows: rows.slice(0, input.limit),
  };
}

export const KeywordOpportunityService = {
  getKeywordOpportunities,
} as const;
