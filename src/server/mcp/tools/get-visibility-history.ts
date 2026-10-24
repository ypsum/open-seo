// Fork (ypsum): visibility curve of the project domain against its
// competitors, the MCP side of the visibility comparison.
import { z } from "zod";
import { VisibilityHistoryService } from "@/server/features/domain/services/visibilityHistory";
import { ProjectContextService } from "@/server/features/project-context/services/ProjectContextService";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { resolveLabsMarket } from "@/shared/keyword-locations";
import {
  assertLabsLocationCode,
  assertLanguageForLocation,
} from "@/server/lib/market";
import {
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";

const MAX_DOMAINS = 10;

const inputSchema = {
  projectId: projectIdSchema,
  competitors: z
    .array(z.string().min(1).max(2048))
    .max(MAX_DOMAINS - 1)
    .optional()
    .describe(
      "Competitor domains to compare. Defaults to the competitors saved in the project context.",
    ),
  locationCode: locationCodeSchema.optional(),
  languageCode: languageCodeSchema.optional(),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

const monthPointOutput = z
  .object({
    month: z.string(),
    visibility: z.number(),
    keywords: z.number(),
    top3: z.number(),
    top10: z.number(),
  })
  .passthrough();

export const getVisibilityHistoryTool = {
  name: "get_visibility_history",
  config: {
    title: "Get visibility history",
    description:
      "Returns the monthly visibility curve of the project domain and its competitors in one comparison, like a Sistrix or Semrush visibility index. Visibility is the estimated monthly organic traffic (search volume x click-through rate at each ranking position, summed over all ranked keywords). Also returns ranked keyword counts, top-3 and top-10 counts per month, and each competitor's gap to the project domain in the latest shared month. Competitors default to the project context. Charges credits per domain (~15 each); cached for 7 days per domain.",
    inputSchema,
    outputSchema: z
      .object({
        ownDomain: z.string().nullable().optional(),
        domains: z
          .array(
            z
              .object({
                domain: z.string(),
                isOwn: z.boolean(),
                months: z.array(monthPointOutput),
              })
              .passthrough(),
          )
          .optional(),
        latest: z
          .object({
            month: z.string(),
            rows: z.array(
              z
                .object({
                  domain: z.string(),
                  isOwn: z.boolean(),
                  visibility: z.number(),
                  gapToOwn: z.number().nullable(),
                })
                .passthrough(),
            ),
          })
          .passthrough()
          .nullable()
          .optional(),
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
      args,
      context.project,
    );
    assertLabsLocationCode(locationCode);
    assertLanguageForLocation(locationCode, languageCode);

    const competitorDomains =
      args.competitors ??
      (
        await ProjectContextService.getProjectContext(args.projectId)
      ).competitors
        .map((competitor) => competitor.domain)
        .slice(0, MAX_DOMAINS - 1);

    const result = await VisibilityHistoryService.getVisibilityHistory(
      {
        projectId: args.projectId,
        ownDomain: context.project.domain ?? null,
        competitorDomains,
        locationCode,
        languageCode,
      },
      context.billing,
    );

    const lines = result.domains.map((entry) => {
      const curve = entry.months
        .map((point) => `${point.month}: ${point.visibility}`)
        .join(", ");
      return `${entry.domain}${entry.isOwn ? " (own)" : ""}: ${curve || "no data"}`;
    });
    const latest = result.latest
      ? [
          `Latest shared month ${result.latest.month}:`,
          ...result.latest.rows.map(
            (row) =>
              `- ${row.domain}${row.isOwn ? " (own)" : ""}: ${row.visibility}${
                row.gapToOwn == null
                  ? ""
                  : ` (${row.gapToOwn >= 0 ? "+" : ""}${row.gapToOwn} vs own)`
              }`,
          ),
        ]
      : ["No visibility data for any domain."];
    const text = [
      "Monthly visibility (estimated organic traffic):",
      ...lines,
      "",
      ...latest,
    ].join("\n");

    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/domain`,
        {},
      ),
      structuredContent: result,
    });
  }),
};
