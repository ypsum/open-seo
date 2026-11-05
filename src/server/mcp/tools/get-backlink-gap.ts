// Fork (ypsum): backlink gap against the project-context competitors. Fetches
// the referring domains of each competitor and of the project domain (spam
// filtered at the source) and lists the domains that link to competitors only.
import { z } from "zod";
import {
  computeBacklinkGap,
  normalizeLinkDomain,
  toReferringDomainRows,
  type BacklinkGapEntry,
} from "@/server/features/backlink-gap/backlinkGap";
import { listCompetitorDomains } from "@/server/features/rank-tracking/services/rankCompetitorStore";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import { dataforseoPricing } from "@/server/lib/dataforseo/pricing";
import { AppError } from "@/server/lib/errors";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";

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
  competitorLimit: z
    .number()
    .int()
    .min(10)
    .max(1000)
    .optional()
    .describe(
      "Most referring domains fetched per competitor, strongest first. Defaults to 300.",
    ),
  minRank: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe("Skip referring domains below this domain rank (0-100)."),
  excludeDomains: z
    .array(z.string().min(3))
    .max(50)
    .optional()
    .describe("Referring domains to skip, including their subdomains."),
  hideSpam: z
    .boolean()
    .optional()
    .describe("Drop spammy referring domains at the source. Defaults to true."),
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

const COLUMNS: McpTableColumn<BacklinkGapEntry>[] = [
  { header: "domain", value: (row) => row.domain },
  { header: "rank", value: (row) => row.rank },
  { header: "competitors", value: (row) => row.competitorCount },
  {
    header: "links to",
    value: (row) => row.competitors.map((c) => c.domain).join(", "),
  },
];

export const getBacklinkGapTool = {
  name: "get_backlink_gap",
  config: {
    title: "Get backlink gap",
    description:
      "Backlink gap against competitors: referring domains that link to at least one competitor and not to the project domain, sorted by how many competitors they link to, then domain rank (0-100). Spam is filtered at the source unless hideSpam is false. Competitors default to the project context. A link prospect list, not a promise: check each domain by hand before outreach. Call without maxCostUsd first: it returns the upper-bound estimate and spends nothing. Then pass the approved estimate as maxCostUsd. Charges credits.",
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
    const ownDomain = normalizeLinkDomain(context.project.domain ?? "");
    if (!ownDomain) {
      throw new AppError("VALIDATION_ERROR", "Project has no domain.");
    }
    const competitors = args.competitors?.length
      ? [...new Set(args.competitors.map(normalizeLinkDomain))].filter(
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

    const competitorLimit = args.competitorLimit ?? 300;
    const hideSpam = args.hideSpam ?? true;
    const estimate = (target: string, limit: number) =>
      dataforseoPricing.backlinks.referringDomains({ target, limit });
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
      `/p/${args.projectId}/backlinks`,
    );

    if (args.maxCostUsd == null || estimatedCostUsd > args.maxCostUsd) {
      const reason =
        args.maxCostUsd == null
          ? "Estimate only, nothing was fetched."
          : `Estimate $${estimatedCostUsd} is above maxCostUsd $${args.maxCostUsd}, nothing was fetched.`;
      return mcpResponse({
        text: `${reason} Backlink gap for ${ownDomain} against ${competitors.join(", ")}: at most $${estimatedCostUsd} (own domain up to ${OWN_LIMIT} referring domains, each competitor up to ${competitorLimit}).`,
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
    // The own list is fetched without the spam filter so a spammy domain
    // that already links to the project is not reported as a gap.
    const [own, ...rivals] = await Promise.all([
      client.backlinks.referringDomains({
        target: ownDomain,
        limit: OWN_LIMIT,
        hideSpam: false,
      }),
      ...competitors.map((domain) =>
        client.backlinks.referringDomains({
          target: domain,
          limit: competitorLimit,
          orderBy: ["rank,desc"],
          hideSpam,
        }),
      ),
    ]);

    const gaps = computeBacklinkGap({
      ownDomain,
      own: toReferringDomainRows(own.items),
      competitors: competitors.map((domain, index) => ({
        domain,
        rows: toReferringDomainRows(rivals[index]?.items ?? []),
      })),
      minRank: args.minRank,
      excludeDomains: args.excludeDomains,
    });
    const shown = gaps.slice(0, args.limit ?? 50);
    const text =
      gaps.length === 0
        ? `No backlink gap for ${ownDomain} against ${competitors.join(", ")}.`
        : `${gaps.length} referring domains link to ${competitors.join(", ")} but not to ${ownDomain}${hideSpam ? " (spam filtered)" : ""}. Rank is DataForSEO domain rank 0-100. Showing ${shown.length}.\n${formatMcpTable(shown, COLUMNS)}`;
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
