// Fork (ypsum): keyword gap against the project-context competitors. Fetches
// the ranked keywords of each competitor (within maxRank) and of the project
// domain, then lists what the competitors rank for and the project does not.
import { z } from "zod";
import {
  computeKeywordGap,
  toGapRows,
  type KeywordGapEntry,
} from "@/server/features/keyword-gap/keywordGap";
import { listCompetitorDomains } from "@/server/features/rank-tracking/services/rankCompetitorStore";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import { dataforseoPricing } from "@/server/lib/dataforseo/pricing";
import { AppError } from "@/server/lib/errors";
import {
  assertLabsLocationCode,
  assertLanguageForLocation,
} from "@/server/lib/market";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";
import { resolveLabsMarket } from "@/shared/keyword-locations";

const OWN_LIMIT = 1000;

const inputSchema = {
  projectId: projectIdSchema,
  competitors: z
    .array(z.string().min(3))
    .max(10)
    .optional()
    .describe(
      "Competitor domains. Defaults to the competitors saved in the project context (first maxCompetitors).",
    ),
  maxCompetitors: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      "How many project-context competitors to compare. Defaults to 5.",
    ),
  maxRank: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Competitor positions counted as ranking. Defaults to 20."),
  competitorLimit: z
    .number()
    .int()
    .min(10)
    .max(1000)
    .optional()
    .describe(
      "Most ranked-keyword rows fetched per competitor. Defaults to 300.",
    ),
  minVolume: z.number().int().min(0).optional(),
  brandTerms: z
    .array(z.string().min(2))
    .max(30)
    .optional()
    .describe(
      "Keywords containing one of these are skipped (competitor brands).",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Rows returned. Defaults to 50."),
  maxCostUsd: z
    .number()
    .positive()
    .optional()
    .describe(
      "Approved upper bound in USD. Without it the tool only returns the estimate and spends nothing.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

const COLUMNS: McpTableColumn<KeywordGapEntry>[] = [
  { header: "keyword", value: (row) => row.keyword },
  { header: "volume", value: (row) => row.volume },
  { header: "status", value: (row) => row.status },
  { header: "own", value: (row) => row.ownPosition ?? "-" },
  { header: "competitors", value: (row) => row.competitorCount },
  {
    header: "positions",
    value: (row) =>
      row.competitors.map((c) => `${c.domain} ${c.position}`).join(", "),
  },
];

function normalizeDomain(domain: string) {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

export const getKeywordGapTool = {
  name: "get_keyword_gap",
  config: {
    title: "Get keyword gap",
    description:
      "Keyword gap against competitors: keywords at least one competitor ranks for within maxRank (default 20) where the project domain does not rank (missing) or ranks at least 10 places behind the best competitor (weaker). Sorted by how many competitors rank, then search volume. Competitors default to the project context. Uses country-level DataForSEO Labs data for the project market, so volumes are national, not city level. Call without maxCostUsd first: it returns the upper-bound estimate and spends nothing. Then pass the approved estimate as maxCostUsd. Charges credits.",
    inputSchema,
    outputSchema: z
      .object({
        estimatedCostUsd: z.number(),
        ran: z.boolean(),
        domain: z.string(),
        competitors: z.array(z.string()),
        gaps: z.array(z.object({}).passthrough()),
        totalGaps: z.number(),
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
    const ownDomain = normalizeDomain(context.project.domain ?? "");
    if (!ownDomain) {
      throw new AppError("VALIDATION_ERROR", "Project has no domain.");
    }
    const { locationCode, languageCode } = resolveLabsMarket(
      {},
      context.project,
    );
    assertLabsLocationCode(locationCode);
    assertLanguageForLocation(locationCode, languageCode);

    const competitors = args.competitors?.length
      ? [...new Set(args.competitors.map(normalizeDomain))].filter(
          (domain) => domain && domain !== ownDomain,
        )
      : (await listCompetitorDomains(args.projectId, ownDomain)).slice(
          0,
          args.maxCompetitors ?? 5,
        );
    if (competitors.length === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "No competitors. Save competitors in the project context or pass competitors.",
      );
    }

    const maxRank = args.maxRank ?? 20;
    const competitorLimit = args.competitorLimit ?? 300;
    const market = { locationCode, languageCode };
    const estimate = (target: string, limit: number) =>
      dataforseoPricing.domain.rankedKeywords({ target, ...market, limit });
    const estimatedCostUsd =
      Math.round(
        (estimate(ownDomain, OWN_LIMIT) +
          competitors.reduce(
            (sum, domain) => sum + estimate(domain, competitorLimit),
            0,
          )) *
          1000,
      ) / 1000;
    const meta = buildProjectMeta(
      context,
      args.projectId,
      `/p/${args.projectId}/domain`,
    );

    if (args.maxCostUsd == null || estimatedCostUsd > args.maxCostUsd) {
      const reason =
        args.maxCostUsd == null
          ? "Estimate only, nothing was fetched."
          : `Estimate $${estimatedCostUsd} is above maxCostUsd $${args.maxCostUsd}, nothing was fetched.`;
      return mcpResponse({
        text: `${reason} Keyword gap for ${ownDomain} against ${competitors.join(", ")}: at most $${estimatedCostUsd} (own domain up to ${OWN_LIMIT} rows, each competitor up to ${competitorLimit} rows within position ${maxRank}).`,
        meta,
        structuredContent: {
          estimatedCostUsd,
          ran: false,
          domain: ownDomain,
          competitors,
          gaps: [],
          totalGaps: 0,
        },
      });
    }

    const client = createDataforseoClient(context.billing);
    const [own, ...rivals] = await Promise.all([
      client.domain.rankedKeywords({
        target: ownDomain,
        ...market,
        limit: OWN_LIMIT,
      }),
      ...competitors.map((domain) =>
        client.domain.rankedKeywords({
          target: domain,
          ...market,
          limit: competitorLimit,
          filters: [
            "ranked_serp_element.serp_item.rank_absolute",
            "<=",
            maxRank,
          ],
        }),
      ),
    ]);

    const gaps = computeKeywordGap({
      own: toGapRows(own.items),
      competitors: competitors.map((domain, index) => ({
        domain,
        rows: toGapRows(rivals[index]?.items ?? []),
      })),
      maxRank,
      minVolume: args.minVolume,
      brandTerms: args.brandTerms,
    });
    const shown = gaps.slice(0, args.limit ?? 50);
    const text =
      gaps.length === 0
        ? `No keyword gap for ${ownDomain} against ${competitors.join(", ")} within position ${maxRank}.`
        : `${gaps.length} gap keywords for ${ownDomain} against ${competitors.join(", ")} (competitor position <= ${maxRank}; missing = own domain not ranking, weaker = 10+ places behind the best competitor). National volumes. Showing ${shown.length}.\n${formatMcpTable(shown, COLUMNS)}`;
    return mcpResponse({
      text,
      meta,
      structuredContent: {
        estimatedCostUsd,
        ran: true,
        domain: ownDomain,
        competitors,
        gaps: shown,
        totalGaps: gaps.length,
      },
    });
  }),
};
