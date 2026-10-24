// Fork (ypsum): the listing check's Google search. Unlike fetchLiveSerp it
// keeps a task DataForSEO completed with partial results (some result pages
// could not be retrieved): the delivered items are paid for and useful, so
// they are returned and flagged instead of failing the whole scan.
import { z } from "zod";
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  buildTaskBilling,
  parseTaskItems,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";

const PARTIAL_RESULTS = /partial results/i;

const listingSerpItemSchema = z
  .object({
    type: z.string(),
    url: z.string().nullable().optional(),
    domain: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  })
  .passthrough();

export type ListingSerpItem = z.infer<typeof listingSerpItemSchema>;

export async function fetchListingSerp(input: {
  keyword: string;
  locationCode: number;
  languageCode: string;
  depth: number;
}): Promise<
  DataforseoApiResponse<{ items: ListingSerpItem[]; partial: boolean }>
> {
  const response = await dataforseoPost(
    "/v3/serp/google/organic/live/advanced",
    [
      {
        keyword: input.keyword,
        location_code: input.locationCode,
        language_code: input.languageCode,
        device: "desktop",
        os: "windows",
        depth: input.depth,
      },
    ],
  );
  const first = response?.tasks?.[0];
  if (
    response?.status_code === 20000 &&
    first &&
    first.status_code !== 20000 &&
    PARTIAL_RESULTS.test(first.status_message ?? "") &&
    (first.result?.length ?? 0) > 0
  ) {
    return {
      data: {
        items: parseTaskItems("listing-serp", first, listingSerpItemSchema),
        partial: true,
      },
      billing: buildTaskBilling(first),
    };
  }
  const task = assertOk(response, { treatNoResultsAsEmpty: true });
  return {
    data: {
      items: parseTaskItems("listing-serp", task, listingSerpItemSchema),
      partial: false,
    },
    billing: buildTaskBilling(task),
  };
}
