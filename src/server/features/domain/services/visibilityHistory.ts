// Fork (ypsum): monthly visibility curve per domain, own domain and
// competitors side by side, like the Sistrix/Semrush visibility index.
// Visibility = DataForSEO Labs organic etv (search volume x CTR at position,
// summed over every ranked keyword), so domains of different size compare on
// one scale.
import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import type { HistoricalRankOverviewItem } from "@/server/lib/dataforseo/labs";
import { parseResearchTargetOrThrow } from "@/server/lib/domainUtils";

/** Labs refreshes history once a month; a week keeps repeat calls free. */
const VISIBILITY_HISTORY_TTL_SECONDS = 7 * 24 * 60 * 60;

const monthPointSchema = z.object({
  /** YYYY-MM */
  month: z.string(),
  visibility: z.number(),
  keywords: z.number(),
  top3: z.number(),
  top10: z.number(),
});

const domainHistorySchema = z.object({
  domain: z.string(),
  months: z.array(monthPointSchema),
});

type DomainHistory = z.infer<typeof domainHistorySchema>;

type VisibilityHistoryResult = {
  ownDomain: string | null;
  domains: (DomainHistory & { isOwn: boolean })[];
  /** Latest month all domains share, with each domain's distance to the own one. */
  latest: {
    month: string;
    rows: {
      domain: string;
      isOwn: boolean;
      visibility: number;
      gapToOwn: number | null;
    }[];
  } | null;
};

function toMonthPoint(item: HistoricalRankOverviewItem) {
  if (item.year == null || item.month == null) return null;
  const organic = item.metrics?.organic as
    | Record<string, number | null | undefined>
    | null
    | undefined;
  const count = (key: string) => organic?.[key] ?? 0;
  return {
    month: `${item.year}-${String(item.month).padStart(2, "0")}`,
    visibility: Math.round((organic?.etv ?? 0) * 10) / 10,
    keywords: count("count"),
    top3: count("pos_1") + count("pos_2_3"),
    top10: count("pos_1") + count("pos_2_3") + count("pos_4_10"),
  };
}

async function getDomainHistory(
  input: {
    projectId: string;
    domain: string;
    locationCode: number;
    languageCode: string;
  },
  billingCustomer: BillingCustomerContext,
): Promise<DomainHistory> {
  const cacheKey = await buildCacheKey("domain:visibility-history", {
    organizationId: billingCustomer.organizationId,
    projectId: input.projectId,
    domain: input.domain,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
  });
  const cached = domainHistorySchema.safeParse(await getCached(cacheKey));
  if (cached.success) return cached.data;

  const dataforseo = createDataforseoClient(billingCustomer);
  const items = await dataforseo.domain.historicalRankOverview({
    target: input.domain,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
  });
  const months = items.map(toMonthPoint).filter((point) => point != null);
  months.sort((a, b) => a.month.localeCompare(b.month));
  const history = { domain: input.domain, months };

  waitUntil(
    setCached(cacheKey, history, VISIBILITY_HISTORY_TTL_SECONDS).catch(
      (error) => {
        console.error("domain.visibility-history.cache-write failed:", error);
      },
    ),
  );
  return history;
}

function buildLatest(
  domains: VisibilityHistoryResult["domains"],
): VisibilityHistoryResult["latest"] {
  const withData = domains.filter((entry) => entry.months.length > 0);
  if (withData.length === 0) return null;
  // Earliest of the latest months, so every domain is compared on data it has.
  const latestMonths = withData.map(
    (entry) => entry.months[entry.months.length - 1].month,
  );
  latestMonths.sort();
  const month = latestMonths[0];
  const own = withData.find((entry) => entry.isOwn);
  const valueAt = (entry: DomainHistory) =>
    entry.months.find((point) => point.month === month)?.visibility ?? 0;
  const ownValue = own ? valueAt(own) : null;
  const rows = domains.map((entry) => {
    const visibility = valueAt(entry);
    return {
      domain: entry.domain,
      isOwn: entry.isOwn,
      visibility,
      gapToOwn:
        ownValue == null || entry.isOwn
          ? null
          : Math.round((visibility - ownValue) * 10) / 10,
    };
  });
  rows.sort((a, b) => b.visibility - a.visibility);
  return { month, rows };
}

async function getVisibilityHistory(
  input: {
    projectId: string;
    ownDomain: string | null;
    competitorDomains: string[];
    locationCode: number;
    languageCode: string;
  },
  billingCustomer: BillingCustomerContext,
): Promise<VisibilityHistoryResult> {
  const ownDomain = input.ownDomain
    ? parseResearchTargetOrThrow(input.ownDomain).hostname
    : null;
  const competitors = [
    ...new Set(
      input.competitorDomains.map(
        (domain) => parseResearchTargetOrThrow(domain).hostname,
      ),
    ),
  ].filter((domain) => domain !== ownDomain);
  const targets = [
    ...(ownDomain ? [{ domain: ownDomain, isOwn: true }] : []),
    ...competitors.map((domain) => ({ domain, isOwn: false })),
  ];

  const domains = await Promise.all(
    targets.map(async (target) => ({
      ...(await getDomainHistory(
        {
          projectId: input.projectId,
          domain: target.domain,
          locationCode: input.locationCode,
          languageCode: input.languageCode,
        },
        billingCustomer,
      )),
      isOwn: target.isOwn,
    })),
  );

  return { ownDomain, domains, latest: buildLatest(domains) };
}

export const VisibilityHistoryService = {
  getVisibilityHistory,
} as const;
