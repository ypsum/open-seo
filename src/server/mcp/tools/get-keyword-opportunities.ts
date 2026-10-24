// Fork (ypsum): Search Console queries ranked by click potential, the
// recurring opportunity list for the weekly SEO review.
import { z } from "zod";
import { KeywordOpportunityService } from "@/server/features/gsc/services/keywordOpportunities";
import { GSC_DATE_RANGES } from "@/server/features/gsc/searchAnalytics";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { resolveLabsMarket } from "@/shared/keyword-locations";
import {
  assertLabsLocationCode,
  assertLanguageForLocation,
} from "@/server/lib/market";
import { GscNotConnectedError } from "@/server/lib/gscErrors";

const inputSchema = {
  projectId: projectIdSchema,
  dateRange: z
    .enum(GSC_DATE_RANGES)
    .optional()
    .describe("Search Console window. Defaults to last_28_days."),
  minImpressions: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Skip queries with fewer impressions. Defaults to 5."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Rows to return. Defaults to 50."),
  brandTerms: z
    .array(z.string().min(1).max(100))
    .max(20)
    .optional()
    .describe(
      "Extra brand names or abbreviations. Queries containing the project name, its domain name or one of these are brand searches.",
    ),
  includeBrand: z
    .boolean()
    .optional()
    .describe(
      "Keep brand searches in the list (marked isBrand). Defaults to false: brand searches are left out.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

const rowOutput = z
  .object({
    query: z.string(),
    clickPotential: z.number(),
    searchVolume: z.number().nullable(),
    impressions: z.number(),
    clicks: z.number(),
    ctr: z.number(),
    gscPosition: z.number().nullable(),
    trackedPosition: z.number().nullable(),
    page: z.string().nullable(),
    otherPages: z.number(),
    isBrand: z.boolean(),
    likelyMapPack: z.boolean(),
  })
  .passthrough();

export const getKeywordOpportunitiesTool = {
  name: "get_keyword_opportunities",
  config: {
    title: "Get keyword opportunities",
    description:
      "Ranks the project's Search Console queries by click potential: demand x CTR at position 3 (or at the current position when it is already better) minus the clicks the query brings today. Demand is the Search Console impressions when the average position is on page 1, since the site is then shown on nearly every search; below page 1 it is the local monthly search volume scaled to the window, or impressions when there is no volume. Volume is Google Ads search volume for the place of the project's oldest local rank tracker (volumeLocation), so a city business is not measured against national demand. Brand searches (project name, domain name, brandTerms) are left out unless includeBrand. likelyMapPack marks queries with a Search Console position of 5 or better whose website is not in the tracked organic top 20: for a local business that position is usually the map pack. Each row has volume, impressions, clicks, CTR, average Search Console position, the latest tracked position, the page that ranks and how many other pages compete for it. Needs a connected Search Console property. Volume lookups charge credits (one Google Ads call for up to 300 queries, about $0.09, cached 30 days per query and place).",
    inputSchema,
    outputSchema: z
      .object({
        ok: z.boolean(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        days: z.number().optional(),
        rows: z.array(rowOutput).optional(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const { locationCode, languageCode } = resolveLabsMarket(
      {},
      context.project,
    );
    assertLabsLocationCode(locationCode);
    assertLanguageForLocation(locationCode, languageCode);
    const meta = buildProjectMeta(
      context,
      args.projectId,
      `/p/${args.projectId}/search-performance`,
    );
    try {
      const result = await KeywordOpportunityService.getKeywordOpportunities(
        {
          projectId: args.projectId,
          locationCode,
          languageCode,
          dateRange: args.dateRange ?? "last_28_days",
          minImpressions: args.minImpressions ?? 5,
          limit: args.limit ?? 50,
          brandTerms: [
            context.project.name,
            ...(context.project.domain
              ? [context.project.domain.replace(/\.[a-z]+$/i, "")]
              : []),
            ...(args.brandTerms ?? []),
          ],
          includeBrand: args.includeBrand ?? false,
        },
        context.billing,
      );
      const lines = result.rows.map(
        (row) =>
          `- ${row.query}: potential ${row.clickPotential} clicks · volume ${row.searchVolume ?? "?"} · ${row.impressions} impr · ${row.clicks} clicks · GSC pos ${row.gscPosition ?? "?"} · tracked ${row.trackedPosition ?? "-"} · ${row.page ?? "no page"}${row.otherPages > 0 ? ` (+${row.otherPages} other pages)` : ""}${row.likelyMapPack ? " · likely map pack, website not in organic top 20" : ""}${row.isBrand ? " · brand" : ""}`,
      );
      return mcpResponse({
        text: [
          `${result.siteUrl} · ${result.startDate}→${result.endDate} · ${result.queriesConsidered} queries · volume for ${result.volumeLocation ?? "the project country"} · potential = clicks at position ${result.targetPosition} (or the current position if better) minus today's clicks`,
          ...(result.brandQueriesExcluded > 0
            ? [
                `${result.brandQueriesExcluded} brand queries left out (includeBrand to show them).`,
              ]
            : []),
          ...(lines.length > 0
            ? lines
            : ["No queries above the impression floor."]),
        ].join("\n"),
        meta,
        structuredContent: { ok: true, ...result },
      });
    } catch (error) {
      if (!(error instanceof GscNotConnectedError)) throw error;
      return mcpResponse({
        text: "Search Console is not connected for this project. Bind a property with set_search_console_site first.",
        meta,
        structuredContent: { ok: false },
      });
    }
  }),
};
