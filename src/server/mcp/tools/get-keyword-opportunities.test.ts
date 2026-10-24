import { beforeEach, describe, expect, it, vi } from "vitest";
import { getKeywordOpportunitiesTool } from "./get-keyword-opportunities";
import { makeToolContext } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getPerformance: vi.fn(),
  adsSearchVolume: vi.fn(),
  getConfigs: vi.fn(),
  getTracker: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ waitUntil: vi.fn() }));
vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: vi.fn(
    async (_prefix: string, params: { query: string }) => params.query,
  ),
  getCached: vi.fn(async () => null),
  setCached: vi.fn(async () => undefined),
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/auth/repositories/AuthRepository", () => ({
  AuthRepository: { getMembership: vi.fn() },
}));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: { getPerformance: mocks.getPerformance },
}));
vi.mock("@/server/features/rank-tracking/services/RankTrackingService", () => ({
  RankTrackingService: {
    getConfigs: mocks.getConfigs,
    getTracker: mocks.getTracker,
  },
}));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: () => ({
    keywords: { adsSearchVolume: mocks.adsSearchVolume },
  }),
}));

describe("get_keyword_opportunities", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({
      id: "project_1",
      locationCode: 2276,
      languageCode: "de",
    });
    mocks.getPerformance.mockResolvedValue({
      siteUrl: "sc-domain:own.de",
      request: { startDate: "2026-09-24", endDate: "2026-10-21" },
      rows: [
        // Page 2: below page 1, local volume is the demand.
        {
          keys: ["osteopathie hamburg", "https://own.de/"],
          clicks: 4,
          impressions: 800,
          position: 14,
        },
        {
          keys: ["osteopathie hamburg", "https://own.de/team"],
          clicks: 0,
          impressions: 200,
          position: 30,
        },
        // Page 1 with a huge national volume: impressions are the demand.
        {
          keys: ["osteopathie in der nähe", "https://own.de/"],
          clicks: 20,
          impressions: 300,
          position: 3,
        },
        // Already at 1.5 with a weak CTR: measured against its own position.
        {
          keys: ["oik hamburg", "https://own.de/"],
          clicks: 10,
          impressions: 100,
          position: 1.5,
        },
      ],
    });
    mocks.adsSearchVolume.mockResolvedValue([
      { keyword: "osteopathie hamburg", search_volume: 1500 },
      { keyword: "osteopathie in der nähe", search_volume: 40500 },
    ]);
    mocks.getConfigs.mockResolvedValue([
      { id: "cfg_1", locationName: "Hamburg,Hamburg,Germany" },
    ]);
    mocks.getTracker.mockResolvedValue({
      results: {
        rows: [
          {
            keyword: "osteopathie hamburg",
            mobile: { position: 12 },
            desktop: { position: null },
          },
        ],
      },
    });
  });

  it("measures page-1 queries by impressions and the rest by local volume", async () => {
    const result = await getKeywordOpportunitiesTool.handler(
      { projectId: "project_1" },
      makeToolContext(),
    );

    expect(mocks.adsSearchVolume).toHaveBeenCalledWith(
      expect.objectContaining({ locationName: "Hamburg,Hamburg,Germany" }),
    );
    // 28-day window. Hamburg: 1500 x 28 / 30 x 0.11 - 4 = 150.
    // In der Nähe: 300 impressions x 0.11 - 20 = 13, not 40,500 x ...
    // OIK Hamburg: 100 x CTR(position 2) 0.15 - 10 = 5.
    expect(result.structuredContent).toMatchObject({
      ok: true,
      volumeLocation: "Hamburg,Hamburg,Germany",
      rows: [
        expect.objectContaining({
          query: "osteopathie hamburg",
          clickPotential: 150,
          searchVolume: 1500,
          gscPosition: 17.2,
          trackedPosition: 12,
          page: "https://own.de/",
          otherPages: 1,
        }),
        expect.objectContaining({
          query: "osteopathie in der nähe",
          clickPotential: 13,
          searchVolume: 40500,
        }),
        expect.objectContaining({ query: "oik hamburg", clickPotential: 5 }),
      ],
    });
  });
});
