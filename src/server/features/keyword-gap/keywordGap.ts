// Fork (ypsum): keyword gap from ranked-keyword rows. A keyword is a gap when
// at least one competitor ranks for it within maxRank and the own domain does
// not rank (missing) or ranks clearly worse (weaker). Computed locally from
// the same Labs ranked_keywords rows the research tools use.
import { sort } from "remeda";
import type { DomainRankedKeywordItem } from "@/server/lib/dataforseo/labs";

export type GapRow = {
  keyword: string;
  volume: number | null;
  position: number | null;
  url: string | null;
};

export type GapCompetitorPosition = {
  domain: string;
  position: number;
  url: string | null;
};

export type KeywordGapEntry = {
  keyword: string;
  volume: number | null;
  status: "missing" | "weaker";
  ownPosition: number | null;
  ownUrl: string | null;
  competitorCount: number;
  bestPosition: number;
  competitors: GapCompetitorPosition[];
};

/** Rows of one domain, keyed by lower-cased keyword, best position wins. */
export function toGapRows(items: readonly DomainRankedKeywordItem[]): GapRow[] {
  const byKeyword = new Map<string, GapRow>();
  for (const item of items) {
    const keyword = (item.keyword_data?.keyword ?? item.keyword ?? "")
      .trim()
      .toLowerCase();
    if (!keyword) continue;
    const position =
      item.ranked_serp_element?.serp_item?.rank_absolute ??
      item.ranked_serp_element?.rank_absolute ??
      null;
    const row: GapRow = {
      keyword,
      volume: item.keyword_data?.keyword_info?.search_volume ?? null,
      position: typeof position === "number" ? position : null,
      url:
        item.ranked_serp_element?.serp_item?.url ??
        item.ranked_serp_element?.url ??
        null,
    };
    const existing = byKeyword.get(keyword);
    if (
      !existing ||
      (row.position != null &&
        (existing.position == null || row.position < existing.position))
    ) {
      byKeyword.set(keyword, {
        ...row,
        volume: row.volume ?? existing?.volume ?? null,
      });
    } else if (existing.volume == null && row.volume != null) {
      existing.volume = row.volume;
    }
  }
  return [...byKeyword.values()];
}

export function computeKeywordGap(input: {
  own: readonly GapRow[];
  competitors: readonly { domain: string; rows: readonly GapRow[] }[];
  maxRank: number;
  /** Own position this many places behind the best competitor counts as weaker. */
  weakerBy?: number;
  minVolume?: number;
  brandTerms?: readonly string[];
}): KeywordGapEntry[] {
  const weakerBy = input.weakerBy ?? 10;
  const brand = (input.brandTerms ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  const own = new Map(input.own.map((row) => [row.keyword, row]));
  const gaps = new Map<string, KeywordGapEntry>();

  for (const competitor of input.competitors) {
    for (const row of competitor.rows) {
      if (row.position == null || row.position > input.maxRank) continue;
      if (brand.some((term) => row.keyword.includes(term))) continue;
      if (input.minVolume != null && (row.volume ?? 0) < input.minVolume) {
        continue;
      }
      let entry = gaps.get(row.keyword);
      if (!entry) {
        const mine = own.get(row.keyword);
        entry = {
          keyword: row.keyword,
          volume: row.volume,
          status: "missing",
          ownPosition: mine?.position ?? null,
          ownUrl: mine?.url ?? null,
          competitorCount: 0,
          bestPosition: row.position,
          competitors: [],
        };
        gaps.set(row.keyword, entry);
      }
      if (entry.volume == null && row.volume != null) entry.volume = row.volume;
      entry.competitors.push({
        domain: competitor.domain,
        position: row.position,
        url: row.url,
      });
      entry.competitorCount = entry.competitors.length;
      entry.bestPosition = Math.min(entry.bestPosition, row.position);
    }
  }

  const result: KeywordGapEntry[] = [];
  for (const entry of gaps.values()) {
    if (entry.ownPosition != null) {
      if (entry.ownPosition - entry.bestPosition < weakerBy) continue;
      entry.status = "weaker";
    }
    result.push({
      ...entry,
      competitors: sort(entry.competitors, (a, b) => a.position - b.position),
    });
  }
  return sort(
    result,
    (a, b) =>
      b.competitorCount - a.competitorCount ||
      (b.volume ?? 0) - (a.volume ?? 0) ||
      a.bestPosition - b.bestPosition ||
      a.keyword.localeCompare(b.keyword),
  );
}
