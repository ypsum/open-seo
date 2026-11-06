// Fork (ypsum): backlink gap from referring-domain rows. A domain is a gap
// when it links to at least one competitor and not to the project domain.
// Computed locally from the same backlinks referring_domains rows the
// backlinks tools use (spam filter applied at the source).
import { sort } from "remeda";

export type ReferringDomainRow = {
  domain: string;
  rank: number | null;
  backlinks: number | null;
  spamScore: number | null;
};

export type BacklinkGapEntry = {
  domain: string;
  rank: number | null;
  spamScore: number | null;
  competitorCount: number;
  competitors: { domain: string; backlinks: number | null }[];
};

export function normalizeLinkDomain(domain: string) {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

export function toReferringDomainRows(
  items: readonly {
    domain?: string | null;
    rank?: number | null;
    backlinks?: number | null;
    backlinks_spam_score?: number | null;
  }[],
): ReferringDomainRow[] {
  const rows = new Map<string, ReferringDomainRow>();
  for (const item of items) {
    const domain = normalizeLinkDomain(item.domain ?? "");
    if (!domain || rows.has(domain)) continue;
    rows.set(domain, {
      domain,
      rank: item.rank ?? null,
      backlinks: item.backlinks ?? null,
      spamScore: item.backlinks_spam_score ?? null,
    });
  }
  return [...rows.values()];
}

export function computeBacklinkGap(input: {
  ownDomain: string;
  own: readonly ReferringDomainRow[];
  competitors: readonly {
    domain: string;
    rows: readonly ReferringDomainRow[];
  }[];
  minRank?: number;
  /** Referring domains to skip, matched as the domain or a parent of it. */
  excludeDomains?: readonly string[];
}): BacklinkGapEntry[] {
  const ownDomain = normalizeLinkDomain(input.ownDomain);
  const competitorDomains = input.competitors.map((c) =>
    normalizeLinkDomain(c.domain),
  );
  const excluded = [
    ownDomain,
    ...competitorDomains,
    ...(input.excludeDomains ?? []).map(normalizeLinkDomain),
  ].filter(Boolean);
  const isExcluded = (domain: string) =>
    excluded.some((ex) => domain === ex || domain.endsWith(`.${ex}`));
  const linksToOwn = new Set(input.own.map((row) => row.domain));
  const gaps = new Map<string, BacklinkGapEntry>();

  input.competitors.forEach((competitor, index) => {
    for (const row of competitor.rows) {
      if (linksToOwn.has(row.domain) || isExcluded(row.domain)) continue;
      if (input.minRank != null && (row.rank ?? 0) < input.minRank) continue;
      let entry = gaps.get(row.domain);
      if (!entry) {
        entry = {
          domain: row.domain,
          rank: row.rank,
          spamScore: row.spamScore,
          competitorCount: 0,
          competitors: [],
        };
        gaps.set(row.domain, entry);
      }
      entry.competitors.push({
        domain: competitorDomains[index] ?? competitor.domain,
        backlinks: row.backlinks,
      });
      entry.competitorCount = entry.competitors.length;
    }
  });

  return sort(
    [...gaps.values()],
    (a, b) =>
      b.competitorCount - a.competitorCount ||
      (b.rank ?? 0) - (a.rank ?? 0) ||
      a.domain.localeCompare(b.domain),
  );
}
