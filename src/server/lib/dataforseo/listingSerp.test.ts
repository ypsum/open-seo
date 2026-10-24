import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
}));

import { fetchListingSerp } from "@/server/lib/dataforseo/listingSerp";

describe("listing SERP", () => {
  it("keeps the items of a task completed with partial results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          status_code: 20000,
          tasks: [
            {
              status_code: 40104,
              status_message:
                "Task completed with partial results. Some pages could not be retrieved after several retry attempts.",
              path: ["v3", "serp", "google", "organic", "live", "advanced"],
              cost: 0.006,
              result: [
                {
                  items: [
                    {
                      type: "organic",
                      url: "https://www.gelbeseiten.de/gsbiz/1",
                      title: "Miss Cherry Coco",
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    );

    const response = await fetchListingSerp({
      keyword: '"Miss Cherry Coco" Neuss',
      locationCode: 2276,
      languageCode: "de",
      depth: 50,
    });

    expect(response.data).toEqual({
      partial: true,
      items: [
        {
          type: "organic",
          url: "https://www.gelbeseiten.de/gsbiz/1",
          title: "Miss Cherry Coco",
        },
      ],
    });
    expect(response.billing.costUsd).toBe(0.006);
  });
});
