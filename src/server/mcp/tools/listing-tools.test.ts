import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { scanListingsTool } from "./listing-tools";
import { makeToolContext } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  live: vi.fn(),
  put: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { R2: { put: mocks.put, list: vi.fn(), get: vi.fn() } },
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
  createDataforseoClient: () => ({ serp: { live: mocks.live } }),
}));

const nap = {
  name: "Miss Cherry Coco",
  street: "Am Heiligenhäuschen 3",
  postalCode: "41468",
  city: "Neuss",
  phone: "02131 123456",
  website: "https://misscherrycoco.de",
};

const organic = (url: string, title: string, description: string) => ({
  type: "organic",
  url,
  domain: new URL(url).hostname,
  title,
  description,
});

describe("scan_listings", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({
      id: "project_1",
      locationCode: 2276,
      languageCode: "de",
    });
    mocks.live.mockImplementation(async ({ keyword }: { keyword: string }) =>
      keyword.startsWith('"Miss Cherry Coco" Neuss')
        ? [
            organic(
              "https://www.gelbeseiten.de/gsbiz/1",
              "Miss Cherry Coco in Düsseldorf",
              "Pionierstraße 54, 40215 Düsseldorf, Tel. 0176 21030068",
            ),
            organic(
              "https://www.dasoertliche.de/a",
              "Miss Cherry Coco Neuss",
              "Am Heiligenhäuschen 3, 41468 Neuss",
            ),
            organic(
              "https://www.dasoertliche.de/b",
              "Miss Cherry Coco Spa Party",
              "Kindergeburtstag in Neuss",
            ),
            organic(
              "https://www.11880.com/x",
              "Miss Cherry Coco",
              "Am Heiligenhäuschen 3, 41468 Neuss, 02131 123456",
            ),
            organic(
              "https://misscherrycoco.jimdofree.com/",
              "Miss Cherry Coco",
              "Spa Partys",
            ),
            organic(
              "https://kindergeburtstag.events/miss-cherry-coco",
              "Miss Cherry Coco",
              "Wellness Kindergeburtstag",
            ),
            organic("https://misscherrycoco.de/", "Miss Cherry Coco", "Spa"),
          ]
        : [],
    );
  });

  it("returns the estimate without searching when no budget is approved", async () => {
    const result = await scanListingsTool.handler(
      { projectId: "project_1", nap },
      makeToolContext(),
    );
    expect(mocks.live).not.toHaveBeenCalled();
    expect(result.structuredContent).toHaveProperty("estimate.searches");
  });

  it("finds wrong data, duplicates, old sites and unlisted portals", async () => {
    const result = await scanListingsTool.handler(
      { projectId: "project_1", nap, maxCostUsd: 5 },
      makeToolContext(),
    );

    const { scan } = z
      .object({
        scan: z.object({
          rows: z.array(
            z.object({
              portalId: z.string(),
              status: z.string(),
              mismatches: z.array(z.string()),
            }),
          ),
          otherSites: z.array(z.string()),
          unlistedHosts: z.array(z.string()),
        }),
      })
      .parse(result.structuredContent);
    const byPortal = Object.fromEntries(
      scan.rows.map((row) => [row.portalId, row]),
    );
    expect(byPortal.gelbeseiten).toMatchObject({
      status: "deviating",
      mismatches: ["phone", "postalCode", "street"],
    });
    expect(byPortal.dasoertliche).toMatchObject({ status: "duplicate" });
    expect(byPortal["11880"]).toMatchObject({ status: "correct" });
    expect(byPortal.yelp).toMatchObject({ status: "not_found" });
    expect(scan.otherSites).toEqual(["https://misscherrycoco.jimdofree.com/"]);
    expect(scan.unlistedHosts).toEqual(["kindergeburtstag.events"]);
    expect(mocks.put).toHaveBeenCalledOnce();
  });
});
