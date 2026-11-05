import { describe, expect, it } from "vitest";
import {
  computeKeywordGap,
  toGapRows,
  type GapRow,
} from "@/server/features/keyword-gap/keywordGap";

const row = (
  keyword: string,
  position: number | null,
  volume: number | null = 100,
): GapRow => ({ keyword, position, volume, url: null });

describe("computeKeywordGap", () => {
  it("lists keywords competitors rank for and the own domain does not", () => {
    const gaps = computeKeywordGap({
      own: [row("osteopathie hamburg", 3)],
      competitors: [
        {
          domain: "a.de",
          rows: [row("osteopathie hamburg", 1), row("cmd hamburg", 4, 50)],
        },
        { domain: "b.de", rows: [row("cmd hamburg", 8, 50)] },
      ],
      maxRank: 20,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      keyword: "cmd hamburg",
      status: "missing",
      ownPosition: null,
      competitorCount: 2,
      bestPosition: 4,
    });
    expect(gaps[0]?.competitors.map((c) => c.domain)).toEqual(["a.de", "b.de"]);
  });

  it("marks keywords where the own domain is far behind as weaker", () => {
    const gaps = computeKeywordGap({
      own: [row("kinderosteopathie hamburg", 25), row("baby osteopathie", 8)],
      competitors: [
        {
          domain: "a.de",
          rows: [
            row("kinderosteopathie hamburg", 2),
            row("baby osteopathie", 3),
          ],
        },
      ],
      maxRank: 20,
    });
    expect(gaps.map((g) => [g.keyword, g.status])).toEqual([
      ["kinderosteopathie hamburg", "weaker"],
    ]);
  });

  it("ignores positions beyond maxRank, brand terms and low volume", () => {
    const gaps = computeKeywordGap({
      own: [],
      competitors: [
        {
          domain: "a.de",
          rows: [
            row("faszien helden hamburg", 1),
            row("osteopathie altona", 30),
            row("osteopathie kosten", 5, 5),
            row("osteopathie baby", 6, 90),
          ],
        },
      ],
      maxRank: 20,
      minVolume: 10,
      brandTerms: ["Faszien Helden"],
    });
    expect(gaps.map((g) => g.keyword)).toEqual(["osteopathie baby"]);
  });

  it("sorts by competitor count, then volume", () => {
    const gaps = computeKeywordGap({
      own: [],
      competitors: [
        { domain: "a.de", rows: [row("x", 1, 10), row("y", 1, 500)] },
        { domain: "b.de", rows: [row("x", 2, 10)] },
      ],
      maxRank: 20,
    });
    expect(gaps.map((g) => g.keyword)).toEqual(["x", "y"]);
  });
});

describe("toGapRows", () => {
  it("keeps the best position per keyword, case-insensitive", () => {
    const rows = toGapRows([
      {
        keyword_data: {
          keyword: "Osteopathie Hamburg",
          keyword_info: { search_volume: 1000 },
        },
        ranked_serp_element: {
          serp_item: { rank_absolute: 9, url: "https://a.de/x" },
        },
      },
      {
        keyword_data: { keyword: "osteopathie hamburg" },
        ranked_serp_element: {
          serp_item: { rank_absolute: 4, url: "https://a.de/" },
        },
      },
      { keyword_data: { keyword: "" } },
    ]);
    expect(rows).toEqual([
      {
        keyword: "osteopathie hamburg",
        position: 4,
        volume: 1000,
        url: "https://a.de/",
      },
    ]);
  });
});
