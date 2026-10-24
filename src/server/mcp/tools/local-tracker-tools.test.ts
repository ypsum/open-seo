import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalTrackerTool } from "./local-tracker-tools";
import { makeToolContext } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  lookupBusiness: vi.fn(),
  createTracker: vi.fn(),
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/auth/repositories/AuthRepository", () => ({
  AuthRepository: { getMembership: vi.fn() },
}));
vi.mock("@/server/features/local-seo/services/LocalSeoService", () => ({
  LocalSeoService: {
    lookupBusiness: mocks.lookupBusiness,
    createTracker: mocks.createTracker,
  },
}));

const business = {
  title: "Osteopathie im Kontor",
  cid: "14442343006071229698",
  placeId: null,
  address: "Gertrudenkirchhof 10, Hamburg",
  latitude: 53.5527,
  longitude: 10.0011,
};

describe("create_local_tracker", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({
      id: "project_1",
      locationCode: 2276,
      languageCode: "de",
    });
    mocks.lookupBusiness.mockResolvedValue(business);
    mocks.createTracker.mockImplementation(
      async (input: { gridSize: number }) => ({
        id: "tracker_1",
        ...business,
        gridSize: input.gridSize,
        spacingKm: 1,
      }),
    );
  });

  it("looks up the listing and saves a 9x9 tracker in the project language", async () => {
    const result = await createLocalTrackerTool.handler(
      {
        projectId: "project_1",
        businessQuery: "Osteopathie im Kontor Hamburg",
        keywords: ["osteopathie hamburg"],
        gridSize: 9,
        spacingKm: 1,
      },
      makeToolContext(),
    );

    expect(mocks.createTracker).toHaveBeenCalledWith(
      {
        projectId: "project_1",
        business,
        keywords: ["osteopathie hamburg"],
        gridSize: 9,
        spacingKm: 1,
      },
      "de",
    );
    expect(result.structuredContent).toMatchObject({ trackerId: "tracker_1" });
  });

  it("refuses without a listing", async () => {
    mocks.lookupBusiness.mockResolvedValue(null);
    await expect(
      createLocalTrackerTool.handler(
        {
          projectId: "project_1",
          businessQuery: "nowhere",
          keywords: ["x"],
          gridSize: 3,
          spacingKm: 1,
        },
        makeToolContext(),
      ),
    ).rejects.toThrow(/Google Maps listing/);
    expect(mocks.createTracker).not.toHaveBeenCalled();
  });
});
