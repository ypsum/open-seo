// Fork (ypsum): map pack and AI Overview presence, read off the same organic
// results page the rank check already pays for. No extra DataForSEO call and
// no extra request parameter, so the cost of a check is unchanged.
//
// Stored inside the existing serp_features JSON array as one trailing object
// ({ "ypsum": {...} }), so the fork adds no migration that would collide with
// upstream's numbered migrations. Upstream's reader keeps only the string
// entries of that array and never sees the object.

import { z } from "zod";

export interface RankAiOverviewPresence {
  /** The business name or domain appears in the overview text or a source. */
  mentioned: boolean;
  /** A source of the overview points at the tracked domain. */
  linked: boolean;
}

export interface RankSerpExtras {
  /** Position in the map pack (1 = first), null when not in it or no pack. */
  localPackPosition: number | null;
  /** Null when the page has no AI Overview, or one that was not loaded. */
  aiOverview: RankAiOverviewPresence | null;
}

type LooseItem = Record<string, unknown>;

const looseItemSchema = z.record(z.string(), z.unknown());

function asRecord(value: unknown): LooseItem | null {
  const parsed = looseItemSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function asRecords(value: unknown): LooseItem[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item) => item != null)
    : [];
}

/** Lowercase words without accents or punctuation, padded for whole-word search. */
function normalizeWords(text: string): string {
  const words = text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return words ? ` ${words} ` : "";
}

const MIN_NAME_LENGTH = 4;

function hostname(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
}

/**
 * Names the business is recognised by: the project name and the domain
 * without its top-level label ("oik-hamburg.de" -> "oik hamburg").
 */
export function businessNameCandidates(
  projectName: string | null | undefined,
  domain: string,
): string[] {
  const host = hostname(domain);
  const labels = host.split(".");
  const stem = labels.length > 1 ? labels.slice(0, -1).join(" ") : host;
  const candidates = [projectName ?? "", stem]
    .filter((name) => name.trim().toLowerCase() !== "default")
    .map((name) => normalizeWords(name).trim())
    .filter((name) => name.length >= MIN_NAME_LENGTH);
  return [...new Set(candidates)];
}

function mentionsName(text: string, names: readonly string[]): boolean {
  const haystack = normalizeWords(text);
  return names.some((name) => haystack.includes(` ${name} `));
}

function hostMatches(candidate: string | null, target: string): boolean {
  if (!candidate) return false;
  let host = candidate.toLowerCase();
  if (/^https?:\/\//.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return false;
    }
  }
  host = hostname(host);
  const own = hostname(target);
  return host === own || host.endsWith(`.${own}`);
}

/** A reference or link points at the target, directly or by its source label. */
function pointsAt(entry: LooseItem, target: string): boolean {
  const source = asString(entry.source);
  return (
    hostMatches(asString(entry.domain), target) ||
    hostMatches(asString(entry.url), target) ||
    // Google wraps some sources in google.com/goto redirects; the source label
    // then is often the site's hostname ("osteopathieinhamburg.de").
    (source != null && /^[\w-]+(\.[\w-]+)+$/.test(source)
      ? hostMatches(source, target)
      : false)
  );
}

function readLocalPackPosition(
  items: readonly LooseItem[],
  target: string,
  names: readonly string[],
): number | null {
  for (const item of items) {
    if (item.type !== "local_pack") continue;
    // The pack entry's domain is usually www.google.com (a business profile
    // link), so the business name is what identifies it.
    const title = asString(item.title) ?? "";
    if (
      hostMatches(asString(item.domain), target) ||
      hostMatches(asString(item.url), target) ||
      mentionsName(title, names)
    ) {
      const rank = item.rank_group;
      return typeof rank === "number" ? rank : null;
    }
  }
  return null;
}

function readAiOverview(
  items: readonly LooseItem[],
  target: string,
  names: readonly string[],
): RankAiOverviewPresence | null {
  const overview = items.find((item) => item.type === "ai_overview");
  if (!overview) return null;
  const elements = asRecords(overview.items);
  const texts = [
    asString(overview.markdown),
    ...elements.flatMap((el) => [
      asString(el.title),
      asString(el.text),
      asString(el.markdown),
    ]),
  ].filter((text) => text != null);
  const references = [
    ...asRecords(overview.references),
    ...elements.flatMap((el) => [
      ...asRecords(el.references),
      ...asRecords(el.links),
    ]),
  ];
  // An overview Google loads after the page (asynchronous_ai_overview) comes
  // back empty unless DataForSEO is paid to load it; that reads as unknown.
  if (texts.length === 0 && references.length === 0) return null;

  const linked = references.some((ref) => pointsAt(ref, target));
  const ownDomain = hostname(target);
  const mentioned =
    linked ||
    texts.some(
      (text) =>
        mentionsName(text, names) || text.toLowerCase().includes(ownDomain),
    ) ||
    references.some((ref) =>
      mentionsName(
        [asString(ref.title), asString(ref.source)].filter(Boolean).join(" "),
        names,
      ),
    );
  return { mentioned, linked };
}

export function readSerpExtras(
  items: readonly unknown[],
  input: { targetDomain: string; targetNames?: readonly string[] },
): RankSerpExtras {
  const records = items.map(asRecord).filter((item) => item != null);
  const names = input.targetNames ?? [];
  return {
    localPackPosition: readLocalPackPosition(
      records,
      input.targetDomain,
      names,
    ),
    aiOverview: readAiOverview(records, input.targetDomain, names),
  };
}

const EXTRAS_KEY = "ypsum";

/** serp_features column value: feature strings plus a trailing extras object. */
export function encodeSerpFeatures(
  features: readonly string[],
  extras: RankSerpExtras | undefined,
): string | null {
  if (features.length === 0) return null;
  // Saved even when both are null, so "checked, not in the pack" reads apart
  // from a snapshot taken before the fork read these at all.
  return JSON.stringify(
    extras ? [...features, { [EXTRAS_KEY]: extras }] : features,
  );
}

/** Extras saved with a snapshot, null for snapshots from before the fork. */
export function decodeSerpExtras(raw: string | null): RankSerpExtras | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed) {
    const extras = asRecord(asRecord(entry)?.[EXTRAS_KEY]);
    if (!extras) continue;
    const position = extras.localPackPosition;
    const overview = asRecord(extras.aiOverview);
    return {
      localPackPosition: typeof position === "number" ? position : null,
      aiOverview: overview
        ? {
            mentioned: overview.mentioned === true,
            linked: overview.linked === true,
          }
        : null,
    };
  }
  return null;
}
