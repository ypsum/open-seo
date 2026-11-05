import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
}));

import { fetchRankCheckTaskResult } from "@/server/lib/dataforseo/serp";

describe("rank check on redirected mobile SERPs", () => {
  it("unwraps google.com/goto redirects through the breadcrumb", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          status_code: 20000,
          tasks: [
            {
              id: "task-a",
              status_code: 20000,
              cost: 0,
              path: ["v3", "serp", "google", "organic", "task_get", "advanced"],
              result: [
                {
                  items: [
                    {
                      type: "organic",
                      rank_group: 1,
                      domain: "google.com",
                      url: "https://google.com/goto?url=CAESaAHE",
                      breadcrumb: "https://www.rival.de",
                    },
                    {
                      type: "organic",
                      rank_group: 2,
                      domain: "google.com",
                      url: "https://google.com/goto?url=CAESYAHE",
                      breadcrumb: "https://www.example.com › praxis",
                    },
                    {
                      type: "organic",
                      rank_group: 3,
                      domain: "google.com",
                      url: "https://google.com/goto?url=CAESXgHE",
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    );

    const outcome = await fetchRankCheckTaskResult({
      taskId: "task-a",
      keywordId: "kw-1",
      keyword: "alpha",
      targetDomain: "example.com",
      competitorDomains: ["rival.de", "google.com"],
    });

    expect(outcome).toMatchObject({
      status: "completed",
      result: {
        position: 2,
        url: "https://www.example.com/",
        competitors: [
          { domain: "rival.de", position: 1, url: "https://www.rival.de/" },
          // A redirect without breadcrumb still counts as google.com.
          { domain: "google.com", position: 3 },
        ],
      },
    });
  });
});
