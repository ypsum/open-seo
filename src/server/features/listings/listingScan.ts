// Fork (ypsum): directory listing check. For one business (name, address,
// phone, website) it finds the business's entries on the portals of
// LISTING_PORTALS through Google results and classifies each portal as
// correct, deviating (which fields), duplicate, found but not verifiable, or
// not found. Results live in R2 (no migration that would collide with
// upstream's numbered migrations on every sync).
import { env } from "cloudflare:workers";
import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { dataforseoPricing } from "@/server/lib/dataforseo/pricing";
import type { ListingSerpItem as SerpLiveItem } from "@/server/lib/dataforseo/listingSerp";
import { AppError } from "@/server/lib/errors";
import {
  LISTING_PORTALS,
  type ListingPortal,
} from "@/server/features/listings/portals";

const PREFIX = "ypsum/listings/";
// Google rarely has ten pages for a small business; deeper searches came back
// as partial results.
const BROAD_DEPTH = 50;
const PHONE_DEPTH = 30;
const SITE_DEPTH = 20;
/** Portals per `site:` search; keeps the query well under Google's 32 words. */
const SITES_PER_QUERY = 6;

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

type Field = "phone" | "postalCode" | "street";
type Status =
  | "correct"
  | "deviating"
  | "duplicate"
  | "unverified"
  | "not_found";

type Entry = {
  url: string;
  title: string;
  snippet: string;
  mismatches: Field[];
};

const compact = (text: string) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** German numbers to one digit string: +49 / 0049 prefix becomes 0. */
function phoneDigits(text: string) {
  const digits = text.replace(/[^\d+]/g, "");
  return digits.replace(/^(\+49|0049)/, "0").replace(/\D/g, "");
}

const PHONE_PATTERN = /(?:\+49|0049|\b0)[\d\s/()-]{6,}\d/g;
const POSTAL_PATTERN = /\b\d{5}\b/g;
const STREET_PATTERN =
  /([\p{L}.-]+(?:straße|strasse|str\.|weg|platz|allee|gasse|ring|damm|ufer|chaussee))\s*(\d+\s?[a-z]?)\b/giu;

function streetKey(street: string) {
  return compact(
    street.replace(/str(?:\.|asse|aße)/giu, "strasse").replace(/\d.*$/, ""),
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function belongsTo(host: string, portal: ListingPortal) {
  return portal.domains.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

function normalizeUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch {
    return url;
  }
}

/** The fields an entry's title and snippet contradict, if it shows them. */
function compareToNap(text: string, nap: Nap) {
  const mismatches: Field[] = [];
  let checked = 0;
  const phones = (text.match(PHONE_PATTERN) ?? []).map(phoneDigits);
  if (phones.length > 0) {
    checked++;
    if (!phones.includes(phoneDigits(nap.phone))) mismatches.push("phone");
  }
  const postalCodes: string[] = text.match(POSTAL_PATTERN) ?? [];
  if (postalCodes.length > 0) {
    checked++;
    if (!postalCodes.includes(nap.postalCode)) mismatches.push("postalCode");
  }
  const streets = [...text.matchAll(STREET_PATTERN)].map((m) =>
    streetKey(m[1]),
  );
  if (streets.length > 0) {
    checked++;
    if (!streets.includes(streetKey(nap.street))) mismatches.push("street");
  }
  return { mismatches, checked };
}

function mentionsBusiness(item: SerpLiveItem, nap: Nap) {
  const text = `${item.title ?? ""} ${item.description ?? ""} ${item.url ?? ""}`;
  return (
    compact(text).includes(compact(nap.name)) ||
    (text.match(PHONE_PATTERN) ?? [])
      .map(phoneDigits)
      .includes(phoneDigits(nap.phone))
  );
}

function plannedQueries(nap: Nap, portals: ListingPortal[]) {
  const broad = [
    { keyword: `"${nap.name}" ${nap.city}`, depth: BROAD_DEPTH },
    { keyword: `"${nap.phone}"`, depth: PHONE_DEPTH },
  ];
  const site: { keyword: string; depth: number; portals: ListingPortal[] }[] =
    [];
  for (let i = 0; i < portals.length; i += SITES_PER_QUERY) {
    const chunk = portals.slice(i, i + SITES_PER_QUERY);
    const sites = chunk
      .flatMap((portal) => portal.domains)
      .map((domain) => `site:${domain}`)
      .join(" OR ");
    site.push({
      keyword: `"${nap.name}" (${sites})`,
      depth: SITE_DEPTH,
      portals: chunk,
    });
  }
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
  const costUsd = [...broad, ...site].reduce((sum, q) => sum + usdFor(q), 0);
  return {
    portals: portals.length,
    searches: broad.length + site.length,
    costUsd: Math.round(costUsd * 10000) / 10000,
  };
}

const storedScanSchema = z
  .object({ scanId: z.string(), createdAt: z.string() })
  .passthrough();

export async function scanListings(
  input: {
    projectId: string;
    nap: Nap;
    extraPortals?: ListingPortal[];
    maxCostUsd: number;
    locationCode: number;
    languageCode: string;
  },
  billingCustomer: BillingCustomerContext,
) {
  const estimate = estimateListingScan(input.nap, input.extraPortals);
  if (estimate.costUsd > input.maxCostUsd) {
    throw new AppError(
      "VALIDATION_ERROR",
      `This scan costs up to $${estimate.costUsd} (${estimate.searches} searches). Show this to the user and retry with maxCostUsd set to the approved amount.`,
    );
  }
  const portals = [...LISTING_PORTALS, ...(input.extraPortals ?? [])];
  const client = createDataforseoClient(billingCustomer);
  // One failed or partial search must not sink the scan: keep what came
  // back and say which search was incomplete.
  const searchNotes: {
    keyword: string;
    status: "partial" | "failed";
    message?: string;
  }[] = [];
  const search = async (query: { keyword: string; depth: number }) => {
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
      return [];
    }
  };

  const { broad, site } = plannedQueries(input.nap, portals);
  // One search after the other: throttled on purpose, never a burst.
  const results: SerpLiveItem[] = [];
  for (const query of broad) results.push(...(await search(query)));
  const seen = new Set(
    results
      .filter((item) => item.url && mentionsBusiness(item, input.nap))
      .map((item) => hostOf(item.url ?? "")),
  );
  const missing = (portal: ListingPortal) =>
    ![...seen].some((host) => belongsTo(host, portal));
  let searches = broad.length;
  for (const query of site) {
    if (!query.portals.some(missing)) continue;
    results.push(...(await search(query)));
    searches++;
  }

  const relevant = results.filter(
    (item) =>
      item.type === "organic" && item.url && mentionsBusiness(item, input.nap),
  );
  const ownHost = input.nap.website ? hostOf(input.nap.website) : "";

  const rows = portals.map((portal) => {
    const byUrl = new Map<string, Entry>();
    for (const item of relevant) {
      if (!belongsTo(hostOf(item.url ?? ""), portal)) continue;
      const key = normalizeUrl(item.url ?? "");
      if (byUrl.has(key)) continue;
      const text = `${item.title ?? ""} ${item.description ?? ""}`;
      const { mismatches } = compareToNap(text, input.nap);
      byUrl.set(key, {
        url: item.url ?? "",
        title: item.title ?? "",
        snippet: item.description ?? "",
        mismatches,
      });
    }
    const entries = [...byUrl.values()];
    const mismatches = [...new Set(entries.flatMap((e) => e.mismatches))];
    const verified = entries.some(
      (e) => compareToNap(`${e.title} ${e.snippet}`, input.nap).checked > 0,
    );
    const status: Status =
      entries.length === 0
        ? "not_found"
        : entries.length > 1
          ? "duplicate"
          : mismatches.length > 0
            ? "deviating"
            : verified
              ? "correct"
              : "unverified";
    return {
      portalId: portal.id,
      portal: portal.name,
      group: portal.group,
      status,
      mismatches,
      entries,
    };
  });

  // Websites carrying the business name that are neither its own site nor a
  // known portal: old site builders (Jimdo, Wix) or copies.
  const nameKey = compact(input.nap.name);
  const otherSites = [
    ...new Set(
      relevant
        .map((item) => item.url ?? "")
        .filter((url) => {
          const host = hostOf(url);
          return (
            host &&
            host !== ownHost &&
            !host.endsWith(`.${ownHost}`) &&
            !portals.some((portal) => belongsTo(host, portal)) &&
            compact(host).includes(nameKey.slice(0, 8))
          );
        }),
    ),
  ];
  // Hosts that list the business but are not on the portal list yet.
  const unlistedHosts = [
    ...new Set(
      relevant
        .map((item) => hostOf(item.url ?? ""))
        .filter(
          (host) =>
            host &&
            host !== ownHost &&
            !portals.some((portal) => belongsTo(host, portal)) &&
            !compact(host).includes(nameKey.slice(0, 8)),
        ),
    ),
  ];

  const scan = {
    scanId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    nap: input.nap,
    searches,
    estimateUsd: estimate.costUsd,
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
    searchNotes,
  };
  await env.R2.put(
    `${PREFIX}${input.projectId}/${scan.scanId}.json`,
    JSON.stringify(scan),
    { httpMetadata: { contentType: "application/json" } },
  );
  return scan;
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
