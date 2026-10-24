// Fork (ypsum): directory listing check. For one business (name, address,
// phone, website) it finds the business's entries on the portals of
// LISTING_PORTALS through Google results and classifies each portal as
// correct, deviating (which fields), duplicate, found but not verifiable, or
// not found. Results live in R2 (no migration that would collide with
// upstream's numbered migrations on every sync).
import { env, waitUntil } from "cloudflare:workers";
import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { dataforseoPricing } from "@/server/lib/dataforseo/pricing";
import type { ListingSerpItem as SerpLiveItem } from "@/server/lib/dataforseo/listingSerp";
import { AppError } from "@/server/lib/errors";
import {
  belongsTo,
  compact,
  compareToNap,
  entryText,
  hostOf,
  mentionsBusiness,
  normalizeUrl,
  phoneDigits,
  POST_PATH,
  type Entry,
  type Status,
} from "@/server/features/listings/listingMatch";
import {
  LISTING_PORTALS,
  type ListingPortal,
} from "@/server/features/listings/portals";

const PREFIX = "ypsum/listings/";
// Google rarely has ten pages for a small business; deeper searches came back
// as partial results.
const BROAD_DEPTH = 50;
const PHONE_DEPTH = 30;
const SITE_DEPTH = 10;
const SITE_DEPTH_SINGLE = 10;
/** Domains per `site:` search; longer OR chains came back as server errors. */
const SITES_PER_QUERY = 3;
/** Headroom in the estimate for one retry of failed searches. */
const RETRY_BUFFER = 1.2;

export const napSchema = z.object({
  name: z.string().trim().min(2).max(200),
  street: z.string().trim().min(2).max(200),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}$/),
  city: z.string().trim().min(2).max(100),
  phone: z.string().trim().min(5).max(40),
  website: z.string().trim().max(300).optional(),
});

type Nap = z.infer<typeof napSchema>;

function siteQuery(nap: Nap, chunk: ListingPortal[], depth: number) {
  const sites = chunk
    .flatMap((portal) => portal.domains)
    .map((domain) => `site:${domain}`)
    .join(" OR ");
  return { keyword: `"${nap.name}" (${sites})`, depth, portals: chunk };
}

function plannedQueries(nap: Nap, portals: ListingPortal[]) {
  const broad = [
    { keyword: `"${nap.name}" ${nap.city}`, depth: BROAD_DEPTH },
    { keyword: `"${nap.phone}"`, depth: PHONE_DEPTH },
  ];
  // Pack portals until a query would carry more than SITES_PER_QUERY domains.
  const site: ReturnType<typeof siteQuery>[] = [];
  let chunk: ListingPortal[] = [];
  let domains = 0;
  for (const portal of portals) {
    if (chunk.length > 0 && domains + portal.domains.length > SITES_PER_QUERY) {
      site.push(siteQuery(nap, chunk, SITE_DEPTH));
      chunk = [];
      domains = 0;
    }
    chunk.push(portal);
    domains += portal.domains.length;
  }
  if (chunk.length > 0) site.push(siteQuery(nap, chunk, SITE_DEPTH));
  return { broad, site };
}

const usdFor = (query: { keyword: string; depth: number }) =>
  dataforseoPricing.serp.listing({
    keyword: query.keyword,
    depth: query.depth,
    locationCode: 2276,
    languageCode: "de",
  });

/** Worst case: every portal needs its own `site:` search. */
export function estimateListingScan(
  nap: Nap,
  extraPortals: ListingPortal[] = [],
) {
  const portals = [...LISTING_PORTALS, ...extraPortals];
  const { broad, site } = plannedQueries(nap, portals);
  const costUsd =
    [...broad, ...site].reduce((sum, q) => sum + usdFor(q), 0) * RETRY_BUFFER;
  return {
    portals: portals.length,
    searches: broad.length + site.length,
    costUsd: Math.round(costUsd * 10000) / 10000,
  };
}

const storedScanSchema = z
  .object({ scanId: z.string(), createdAt: z.string() })
  .passthrough();

type ScanInput = {
  projectId: string;
  nap: Nap;
  extraPortals?: ListingPortal[];
  maxCostUsd: number;
  locationCode: number;
  languageCode: string;
};

const scanKey = (projectId: string, scanId: string) =>
  `${PREFIX}${projectId}/${scanId}.json`;

async function saveScan(
  projectId: string,
  scan: { scanId: string; [key: string]: unknown },
) {
  await env.R2.put(scanKey(projectId, scan.scanId), JSON.stringify(scan), {
    httpMetadata: { contentType: "application/json" },
  });
}

/**
 * Starts a scan and returns at once: a scan runs a dozen searches one after
 * another and takes longer than an MCP call may stay open. The scan is saved
 * as running, then done (or failed) when the background work finishes.
 */
export async function startListingScan(
  input: ScanInput,
  billingCustomer: BillingCustomerContext,
) {
  const estimate = estimateListingScan(input.nap, input.extraPortals);
  if (estimate.costUsd > input.maxCostUsd) {
    throw new AppError(
      "VALIDATION_ERROR",
      `This scan costs up to $${estimate.costUsd} (${estimate.searches} searches). Show this to the user and retry with maxCostUsd set to the approved amount.`,
    );
  }
  const started = {
    scanId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: "running" as const,
    nap: input.nap,
    estimateUsd: estimate.costUsd,
  };
  await saveScan(input.projectId, started);
  waitUntil(
    runListingScan(input, billingCustomer, started)
      .then((scan) => saveScan(input.projectId, scan))
      .catch((error: unknown) => {
        console.error("[listings] scan failed:", error);
        return saveScan(input.projectId, {
          ...started,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }),
  );
  return started;
}

async function runListingScan(
  input: ScanInput,
  billingCustomer: BillingCustomerContext,
  started: { scanId: string; createdAt: string; estimateUsd: number },
) {
  const portals = [...LISTING_PORTALS, ...(input.extraPortals ?? [])];
  const client = createDataforseoClient(billingCustomer);
  // One failed or partial search must not sink the scan: keep what came
  // back and say which search was incomplete.
  const searchNotes: {
    keyword: string;
    status: "partial" | "failed";
    message?: string;
  }[] = [];
  let searches = 0;
  const search = async (query: { keyword: string; depth: number }) => {
    searches++;
    try {
      const { items, partial } = await client.serp.listing({
        keyword: query.keyword,
        depth: query.depth,
        locationCode: input.locationCode,
        languageCode: input.languageCode,
      });
      if (partial)
        searchNotes.push({ keyword: query.keyword, status: "partial" });
      return items;
    } catch (error) {
      searchNotes.push({
        keyword: query.keyword,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const { broad, site } = plannedQueries(input.nap, portals);
  // One search after the other: throttled on purpose, never a burst.
  const results: SerpLiveItem[] = [];
  const [nameQuery, phoneQuery] = broad;
  results.push(...((await search(nameQuery)) ?? []));
  const phoneItems =
    (await search(phoneQuery)) ??
    // Retry the phone without spaces: Google errors on some spaced numbers.
    (await search({
      keyword: `"${phoneDigits(input.nap.phone)}"`,
      depth: phoneQuery.depth,
    }));
  results.push(...(phoneItems ?? []));

  const seen = () =>
    new Set(
      results
        .filter((item) => item.url && mentionsBusiness(item, input.nap))
        .map((item) => hostOf(item.url ?? "")),
    );
  const missing = (portal: ListingPortal, hosts: Set<string>) =>
    ![...hosts].some((host) => belongsTo(host, portal));
  for (const query of site) {
    const hosts = seen();
    const open = query.portals.filter((portal) => missing(portal, hosts));
    if (open.length === 0) continue;
    const items = await search(query);
    if (items) {
      results.push(...items);
      continue;
    }
    // A failed group gets one more try, one portal at a time.
    for (const portal of open) {
      const single = await search(
        siteQuery(input.nap, [portal], SITE_DEPTH_SINGLE),
      );
      results.push(...(single ?? []));
    }
  }
  return buildScan(input, portals, results, {
    ...started,
    searches,
    searchNotes,
  });
}

function buildScan(
  input: ScanInput,
  portals: ListingPortal[],
  results: SerpLiveItem[],
  meta: {
    scanId: string;
    createdAt: string;
    estimateUsd: number;
    searches: number;
    searchNotes: { keyword: string; status: string; message?: string }[];
  },
) {
  const relevant = results.filter(
    (item) =>
      item.type === "organic" && item.url && mentionsBusiness(item, input.nap),
  );
  const ownHost = input.nap.website ? hostOf(input.nap.website) : "";

  const rows = portals.map((portal) => {
    const byUrl = new Map<string, Entry & { checked: number }>();
    for (const item of relevant) {
      if (!belongsTo(hostOf(item.url ?? ""), portal)) continue;
      const key = normalizeUrl(item.url ?? "");
      if (byUrl.has(key)) continue;
      const { mismatches, checked } = compareToNap(entryText(item), input.nap);
      byUrl.set(key, {
        url: item.url ?? "",
        title: item.title ?? "",
        snippet: item.description ?? "",
        mismatches,
        checked,
      });
    }
    const entries = [...byUrl.values()];
    // A duplicate is a second entry with its own address or phone: posts,
    // reels and offer pages of the same profile do not count.
    const listings = entries.filter(
      (entry) => entry.checked > 0 && !POST_PATH.test(entry.url),
    );
    const mismatches = [...new Set(entries.flatMap((e) => e.mismatches))];
    const status: Status =
      entries.length === 0
        ? "not_found"
        : listings.length > 1
          ? "duplicate"
          : mismatches.length > 0
            ? "deviating"
            : listings.length > 0
              ? "correct"
              : "unverified";
    return {
      portalId: portal.id,
      portal: portal.name,
      group: portal.group,
      status,
      mismatches,
      entries: entries.map(({ checked: _checked, ...entry }) => entry),
    };
  });

  // Websites carrying the business name that are neither its own site nor a
  // known portal: old site builders (Jimdo, Wix) or copies.
  const nameKey = compact(input.nap.name).slice(0, 8);
  const unknownHost = (host: string) =>
    host &&
    host !== ownHost &&
    !host.endsWith(`.${ownHost}`) &&
    !portals.some((portal) => belongsTo(host, portal));
  const otherSites = [
    ...new Set(
      relevant
        .map((item) => item.url ?? "")
        .filter((url) => {
          const host = hostOf(url);
          return unknownHost(host) && compact(host).includes(nameKey);
        }),
    ),
  ];
  // Hosts that list the business but are not on the portal list yet.
  const unlistedHosts = [
    ...new Set(
      relevant
        .map((item) => hostOf(item.url ?? ""))
        .filter(
          (host) => unknownHost(host) && !compact(host).includes(nameKey),
        ),
    ),
  ];

  return {
    ...meta,
    status: "done" as const,
    nap: input.nap,
    summary: {
      portals: rows.length,
      correct: rows.filter((r) => r.status === "correct").length,
      deviating: rows.filter((r) => r.status === "deviating").length,
      duplicate: rows.filter((r) => r.status === "duplicate").length,
      unverified: rows.filter((r) => r.status === "unverified").length,
      notFound: rows.filter((r) => r.status === "not_found").length,
    },
    rows,
    otherSites,
    unlistedHosts,
  };
}

export async function getListingScan(projectId: string, scanId?: string) {
  let key = scanId ? `${PREFIX}${projectId}/${scanId}.json` : null;
  if (!key) {
    const listed = await env.R2.list({ prefix: `${PREFIX}${projectId}/` });
    const objects = [...listed.objects];
    objects.sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime());
    key = objects[0]?.key ?? null;
  }
  if (!key) return null;
  const object = await env.R2.get(key);
  if (!object) return null;
  const parsed = storedScanSchema.safeParse(JSON.parse(await object.text()));
  return parsed.success ? parsed.data : null;
}
