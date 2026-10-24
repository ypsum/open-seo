import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateRankTrackerScheduleTool } from "./update-rank-tracker-schedule";
import { makeToolContext } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getConfigById: vi.fn(),
  getKeywordsForConfig: vi.fn(),
  updateConfig: vi.fn(),
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
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: {
      getConfigById: mocks.getConfigById,
      getKeywordsForConfig: mocks.getKeywordsForConfig,
    },
  }),
);
vi.mock("@/server/features/rank-tracking/services/RankTrackingService", () => ({
  RankTrackingService: { updateConfig: mocks.updateConfig },
}));

const trackerId = "c1f4c364-c41a-456a-96df-cd3a8c47de01";

describe("update_rank_tracker_schedule", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({ id: "project_1" });
    mocks.getConfigById.mockResolvedValue({
      devices: "mobile",
      serpDepth: 50,
      nextCheckAt: "2026-10-26T03:00:00Z",
    });
    mocks.getKeywordsForConfig.mockResolvedValue([
      { keyword: "osteopathie hamburg" },
    ]);
  });

  it("refuses a recurring schedule without an approved credit ceiling", async () => {
    await expect(
      updateRankTrackerScheduleTool.handler(
        { projectId: "project_1", trackerId, scheduleInterval: "weekly" },
        makeToolContext(),
      ),
    ).rejects.toThrow(/maxEstimatedScheduledCheckCredits/);
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it("switches to weekly within the approved ceiling", async () => {
    const result = await updateRankTrackerScheduleTool.handler(
      {
        projectId: "project_1",
        trackerId,
        scheduleInterval: "weekly",
        maxEstimatedScheduledCheckCredits: 10_000,
      },
      makeToolContext(),
    );

    expect(mocks.updateConfig).toHaveBeenCalledWith(trackerId, "project_1", {
      scheduleInterval: "weekly",
      scheduleTime: undefined,
    });
    expect(result.structuredContent).toMatchObject({
      scheduleInterval: "weekly",
      nextCheckAt: "2026-10-26T03:00:00Z",
    });
  });
});
