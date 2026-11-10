import { describe, expect, it } from "vitest";
import {
  businessNameCandidates,
  decodeSerpExtras,
  encodeSerpFeatures,
  readSerpExtras,
} from "@/server/lib/dataforseo/serpExtras";

// Trimmed from the real DataForSEO response for "osteopathie hamburg",
// Hamburg, mobile, 10.11.2026: OIK first in the map pack and first in the AI
// Overview, linked as oik-hamburg.de; every organic link wrapped in goto.
const OIK_ITEMS = [
  {
    type: "ai_overview",
    rank_group: 1,
    markdown:
      "Gute Anlaufstellen sind unter anderem:\n\n- **Osteopathie im Kontor (OIK Hamburg)** \n- **Osteoversum Hamburg**",
    items: [
      {
        type: "ai_overview_element",
        text: "Osteopathie im Kontor (OIK Hamburg) Adresse: Gertrudenkirchhof 10",
        references: [
          {
            type: "ai_overview_reference",
            source: "Google",
            domain: "www.google.com",
            url: "https://www.google.com/searchviewer/10?svid=x",
            title: "Osteopathie im Kontor (OIK Hamburg)",
          },
        ],
      },
    ],
    references: [
      {
        type: "ai_overview_reference",
        source: "osteopathieinhamburg.de",
        domain: "google.com",
        url: "https://google.com/goto?url=abc",
        title: "Osteopathie in Hamburg | Baranowsky & Klöckner-Afram",
      },
      {
        type: "ai_overview_reference",
        source: "Osteopathie im Kontor Hamburg",
        domain: "oik-hamburg.de",
        url: "https://oik-hamburg.de/",
        title: "Osteopathie im Kontor Hamburg | Ganzheitliche Behandlung",
      },
    ],
  },
  {
    type: "local_pack",
    rank_group: 1,
    rank_absolute: 2,
    title: "Osteopathie im Kontor (OIK Hamburg)",
    domain: "www.google.com",
    url: "https://www.google.com/searchviewer/10?svid=x",
    rating: { value: 5, votes_count: 137 },
  },
  {
    type: "local_pack",
    rank_group: 2,
    rank_absolute: 3,
    title: "Osteopathie Hamburg - Praxis Alexander Roth in Uhlenhorst",
    domain: "www.google.com",
  },
  {
    type: "organic",
    rank_group: 1,
    domain: "google.com",
    url: "https://google.com/goto?url=def",
    breadcrumb: "https://www.rehawerk-hamburg.de",
  },
];

const OIK = {
  targetDomain: "oik-hamburg.de",
  targetNames: businessNameCandidates(
    "Osteopathie im Kontor",
    "oik-hamburg.de",
  ),
};

describe("businessNameCandidates", () => {
  it("uses the project name and the domain without its top-level label", () => {
    expect(
      businessNameCandidates(
        "Osteopathie im Kontor",
        "https://www.oik-hamburg.de/",
      ),
    ).toEqual(["osteopathie im kontor", "oik hamburg"]);
  });

  it("skips the placeholder project name and too short names", () => {
    expect(businessNameCandidates("Default", "ab.de")).toEqual([]);
  });
});

describe("readSerpExtras", () => {
  it("finds OIK first in the map pack by name and linked in the AI Overview", () => {
    expect(readSerpExtras(OIK_ITEMS, OIK)).toEqual({
      localPackPosition: 1,
      aiOverview: { mentioned: true, linked: true },
    });
  });

  it("reports a competitor's map place and an unlinked mention", () => {
    expect(
      readSerpExtras(OIK_ITEMS, {
        targetDomain: "osteopathiepraxis-roth.de",
        targetNames: businessNameCandidates(
          "Praxis Alexander Roth",
          "osteopathiepraxis-roth.de",
        ),
      }),
    ).toEqual({
      localPackPosition: 2,
      aiOverview: { mentioned: false, linked: false },
    });
  });

  it("counts a goto-wrapped source by its hostname label as linked", () => {
    expect(
      readSerpExtras(OIK_ITEMS, {
        targetDomain: "osteopathieinhamburg.de",
        targetNames: [],
      }).aiOverview,
    ).toEqual({ mentioned: true, linked: true });
  });

  it("is not in the pack and has no overview on a plain organic page", () => {
    expect(readSerpExtras([OIK_ITEMS[3]], OIK)).toEqual({
      localPackPosition: null,
      aiOverview: null,
    });
  });

  it("reads an AI Overview Google loads later as unknown", () => {
    expect(
      readSerpExtras(
        [{ type: "ai_overview", asynchronous_ai_overview: true, items: [] }],
        OIK,
      ).aiOverview,
    ).toBeNull();
  });

  it("does not match a name inside another word", () => {
    expect(
      readSerpExtras(
        [{ type: "local_pack", rank_group: 1, title: "Kontorhaus Bar" }],
        { targetDomain: "x.de", targetNames: ["kontor"] },
      ).localPackPosition,
    ).toBeNull();
  });
});

describe("serp_features encoding", () => {
  it("round-trips the extras behind the feature strings", () => {
    const extras = {
      localPackPosition: 1,
      aiOverview: { mentioned: true, linked: true },
    };
    const raw = encodeSerpFeatures(["ai_overview", "local_pack"], extras);
    expect(decodeSerpExtras(raw)).toEqual(extras);
    // Upstream's reader keeps only the strings.
    const parsed: unknown = JSON.parse(raw ?? "[]");
    const strings = Array.isArray(parsed)
      ? parsed.filter((item) => typeof item === "string")
      : [];
    expect(strings).toEqual(["ai_overview", "local_pack"]);
  });

  it("keeps a checked miss apart from an old snapshot", () => {
    expect(
      decodeSerpExtras(
        encodeSerpFeatures(["organic"], {
          localPackPosition: null,
          aiOverview: null,
        }),
      ),
    ).toEqual({ localPackPosition: null, aiOverview: null });
    expect(decodeSerpExtras(JSON.stringify(["organic"]))).toBeNull();
    expect(decodeSerpExtras(null)).toBeNull();
  });

  it("stores nothing for a page without results", () => {
    expect(
      encodeSerpFeatures([], { localPackPosition: null, aiOverview: null }),
    ).toBeNull();
  });
});
