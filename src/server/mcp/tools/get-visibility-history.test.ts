import { beforeEach, describe, expect, it, vi } from "vitest";
import { getVisibilityHistoryTool } from "./get-visibility-history";
import { makeToolContext } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getProjectContext: vi.fn(),
  historicalRankOverview: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ waitUntil: vi.fn() }));
vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: vi.fn(async () => "key"),
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
vi.mock(
  "@/server/features/project-context/services/ProjectContextService",
  () => ({
    ProjectContextService: { getProjectContext: mocks.getProjectContext },
  }),
);
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: () => ({
    domain: { historicalRankOverview: mocks.historicalRankOverview },
  }),
}));

const month = (year: number, m: number, etv: number) => ({
  year,
  month: m,
  metrics: { organic: { etv, count: 10, pos_1: 1, pos_4_10: 2 } },
});

describe("get_visibility_history", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({
      id: "project_1",
      domain: "own.de",
      locationCode: 2276,
      languageCode: "de",
    });
    mocks.getProjectContext.mockResolvedValue({
      competitors: [{ domain: "rival.de" }],
    });
    mocks.historicalRankOverview.mockImplementation(
      async ({ target }: { target: string }) =>
        target === "own.de"
          ? [month(2026, 10, 80), month(2026, 9, 70)]
          : [month(2026, 9, 200)],
    );
  });

  it("compares saved competitors against the own domain in the latest shared month", async () => {
    const result = await getVisibilityHistoryTool.handler(
      { projectId: "project_1" },
      makeToolContext(),
    );

    expect(result.structuredContent?.domains?.[0]).toMatchObject({
      domain: "own.de",
      isOwn: true,
      months: [
        { month: "2026-09", visibility: 70, top3: 1, top10: 3 },
        { month: "2026-10", visibility: 80 },
      ],
    });
    expect(result.structuredContent?.latest).toEqual({
      month: "2026-09",
      rows: [
        { domain: "rival.de", isOwn: false, visibility: 200, gapToOwn: 130 },
        { domain: "own.de", isOwn: true, visibility: 70, gapToOwn: null },
      ],
    });
  });
});
