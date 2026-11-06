import { describe, expect, it } from "vitest";
import {
  computeBacklinkGap,
  toReferringDomainRows,
  type ReferringDomainRow,
} from "@/server/features/backlink-gap/backlinkGap";

const row = (domain: string, rank = 30): ReferringDomainRow => ({
  domain,
  rank,
  backlinks: 2,
  spamScore: 0,
});

describe("computeBacklinkGap", () => {
  it("lists domains linking to competitors but not to the project", () => {
    const gaps = computeBacklinkGap({
      ownDomain: "oik-hamburg.de",
      own: [row("jameda.de")],
      competitors: [
        { domain: "a.de", rows: [row("jameda.de"), row("bvo.de", 40)] },
        {
          domain: "https://www.b.de/",
          rows: [row("bvo.de", 40), row("hallo.de")],
        },
      ],
    });
    expect(gaps.map((g) => [g.domain, g.competitorCount])).toEqual([
      ["bvo.de", 2],
      ["hallo.de", 1],
    ]);
    expect(gaps[0]?.competitors.map((c) => c.domain)).toEqual(["a.de", "b.de"]);
  });

  it("skips own, competitor, excluded and low-rank domains", () => {
    const gaps = computeBacklinkGap({
      ownDomain: "oik-hamburg.de",
      own: [],
      competitors: [
        {
          domain: "a.de",
          rows: [
            row("blog.oik-hamburg.de"),
            row("b.de"),
            row("shop.google.com"),
            row("tiny.de", 2),
            row("verband.de", 25),
          ],
        },
        { domain: "b.de", rows: [] },
      ],
      minRank: 10,
      excludeDomains: ["google.com"],
    });
    expect(gaps.map((g) => g.domain)).toEqual(["verband.de"]);
  });
});

describe("toReferringDomainRows", () => {
  it("normalizes and dedupes domains", () => {
    expect(
      toReferringDomainRows([
        {
          domain: "WWW.Jameda.de",
          rank: 50,
          backlinks: 3,
          backlinks_spam_score: 1,
        },
        { domain: "jameda.de", rank: 10 },
        { domain: null },
      ]),
    ).toEqual([{ domain: "jameda.de", rank: 50, backlinks: 3, spamScore: 1 }]);
  });
});
