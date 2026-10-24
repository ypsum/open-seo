import { beforeEach, describe, expect, it, vi } from "vitest";
import { getKeywordOpportunitiesTool } from "./get-keyword-opportunities";
import { makeToolContext } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getPerformance: vi.fn(),
  keywordOverview: vi.fn(),
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
    labs: { keywordOverview: mocks.keywordOverview },
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
        {
          keys: ["cmd osteopathie", "https://own.de/cmd"],
          clicks: 1,
          impressions: 100,
          position: 9,
        },
      ],
    });
    mocks.keywordOverview.mockResolvedValue([
      { keyword: "osteopathie hamburg", keyword_info: { search_volume: 1500 } },
    ]);
    mocks.getConfigs.mockResolvedValue([{ id: "cfg_1" }]);
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

  it("ranks queries by clicks gained at position 3, falling back to impressions without volume", async () => {
    const result = await getKeywordOpportunitiesTool.handler(
      { projectId: "project_1" },
      makeToolContext(),
    );

    // 28-day window: 1500 x 28 / 30 x 0.11 - 4 = 150; 100 impressions x 0.11 - 1 = 10.
    expect(result.structuredContent).toMatchObject({
      ok: true,
      rows: [
        expect.objectContaining({
          query: "osteopathie hamburg",
          clickPotential: 150,
          searchVolume: 1500,
          impressions: 1000,
          gscPosition: 17.2,
          trackedPosition: 12,
          page: "https://own.de/",
          otherPages: 1,
        }),
        expect.objectContaining({
          query: "cmd osteopathie",
          clickPotential: 10,
          searchVolume: null,
          trackedPosition: null,
        }),
      ],
    });
  });
});
