import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getListingScanTool, scanListingsTool } from "./listing-tools";
import { makeToolContext } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  listing:
    vi.fn<
      (input: {
        keyword: string;
      }) => Promise<{ partial: boolean; items: unknown[] }>
    >(),
  put: vi.fn(),
  get: vi.fn(),
  background: [] as Promise<unknown>[],
}));

vi.mock("cloudflare:workers", () => ({
  env: { R2: { put: mocks.put, list: vi.fn(), get: mocks.get } },
  waitUntil: (promise: Promise<unknown>) => mocks.background.push(promise),
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/auth/repositories/AuthRepository", () => ({
  AuthRepository: { getMembership: vi.fn() },
}));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: () => ({ serp: { listing: mocks.listing } }),
}));

const nap = {
  name: "Miss Cherry Coco",
  street: "Am Heiligenhäuschen 3",
  postalCode: "41472",
  city: "Neuss",
  phone: "0152 26501276",
  website: "https://misscherrycoco.de",
};

const organic = (url: string, title: string, description: string) => ({
  type: "organic",
  url,
  title,
  description,
});

const NAME_RESULTS = [
  organic(
    "https://www.dasoertliche.de/a",
    "Miss Cherry Coco Neuss",
    "Miss Cherry Coco, Am Heiligenhäuschen 3, 41472 Neuss",
  ),
  organic(
    "https://www.dasoertliche.de/b",
    "Miss Cherry Coco, Pionierstraße 54, 40215 Düsseldorf",
    "Spa Party",
  ),
  // Posts of one profile are not duplicates.
  organic(
    "https://www.facebook.com/misscherrycoco/posts/1",
    "Miss Cherry Coco",
    "Spa Party",
  ),
  organic(
    "https://www.facebook.com/misscherrycoco/posts/2",
    "Miss Cherry Coco",
    "Mami & Me",
  ),
  // Another company's number further on in the snippet is not ours.
  organic(
    "https://www.instagram.com/misscherrycoco/",
    "Miss Cherry Coco",
    "Spa Partys für Kinder in Neuss. Lots of other kids party ideas from all over the region and beyond, including the PixiePlay indoor playground in Düsseldorf, call 0174 1234567",
  ),
  // Address only in the title.
  organic(
    "https://www.mapquest.com/de/dusseldorf/miss-cherry-coco-1",
    "Miss Cherry Coco, Pionierstraße 54, Düsseldorf",
    "Beauty salon",
  ),
];

const scanSchema = z.object({
  status: z.string(),
  rows: z.array(
    z.object({
      portalId: z.string(),
      status: z.string(),
      mismatches: z.array(z.string()),
    }),
  ),
  searchNotes: z.array(z.object({ keyword: z.string(), status: z.string() })),
});

describe("listing scan", () => {
  beforeEach(() => {
    mocks.background.length = 0;
    mocks.getProjectForOrganization.mockResolvedValue({
      id: "project_1",
      locationCode: 2276,
      languageCode: "de",
    });
    mocks.listing.mockImplementation(
      async ({ keyword }: { keyword: string }) => {
        if (keyword === '"0152 26501276"')
          throw new Error("Internal SE Server Error");
        if (keyword.includes("site:gelbeseiten.de OR"))
          throw new Error("Internal SE Server Error");
        if (keyword === '"Miss Cherry Coco" (site:gelbeseiten.de)')
          return {
            partial: false,
            items: [
              organic(
                "https://www.gelbeseiten.de/gsbiz/1",
                "Miss Cherry Coco",
                "Am Heiligenhäuschen 3, 41472 Neuss, 0152 26501276",
              ),
            ],
          };
        return {
          partial: false,
          items: keyword.startsWith('"Miss Cherry Coco" Neuss')
            ? NAME_RESULTS
            : [],
        };
      },
    );
  });

  it("returns the scan id at once and saves the result when the background work ends", async () => {
    const started = await scanListingsTool.handler(
      { projectId: "project_1", nap, maxCostUsd: 5 },
      makeToolContext(),
    );
    expect(started.structuredContent).toHaveProperty("scan.status", "running");

    await Promise.all(mocks.background);
    const saved: unknown = mocks.put.mock.calls.at(-1)?.[1];
    const scan = scanSchema.parse(JSON.parse(String(saved)));
    const byPortal = Object.fromEntries(
      scan.rows.map((row) => [row.portalId, row]),
    );

    expect(scan.status).toBe("done");
    expect(byPortal.dasoertliche).toMatchObject({ status: "duplicate" });
    expect(byPortal.facebook).toMatchObject({ status: "unverified" });
    expect(byPortal.instagram).toMatchObject({
      status: "unverified",
      mismatches: [],
    });
    expect(byPortal.mapquest).toMatchObject({
      status: "deviating",
      mismatches: ["street"],
    });
    // The failed group was retried portal by portal.
    expect(byPortal.gelbeseiten).toMatchObject({ status: "correct" });
    // The spaced phone failed and was retried without spaces.
    expect(mocks.listing.mock.calls.map(([input]) => input.keyword)).toContain(
      '"015226501276"',
    );
    expect(scan.searchNotes.map((note) => note.status)).toContain("failed");
  });

  it("reports a running scan", async () => {
    mocks.get.mockResolvedValue({
      text: async () =>
        JSON.stringify({
          scanId: "s1",
          createdAt: "2026-10-24T12:00:00Z",
          status: "running",
        }),
    });
    const result = await getListingScanTool.handler(
      {
        projectId: "project_1",
        scanId: "0b9f1c43-6f2a-4d5e-9b1c-2a3b4c5d6e7f",
      },
      makeToolContext(),
    );
    expect(JSON.stringify(result.content)).toContain("still running");
  });
});
