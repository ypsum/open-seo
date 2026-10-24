// Fork (ypsum): directory listing check over MCP.
import { z } from "zod";
import {
  estimateListingScan,
  getListingScan,
  napSchema,
  scanListings,
} from "@/server/features/listings/listingScan";
import { LISTING_PORTALS } from "@/server/features/listings/portals";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

const extraPortalSchema = z.object({
  name: z.string().trim().min(1).max(100),
  domain: z
    .string()
    .trim()
    .min(3)
    .max(253)
    .describe("Host, e.g. kindergeburtstag.events"),
});

const STATUS_LABEL: Record<string, string> = {
  correct: "correct",
  deviating: "DEVIATING",
  duplicate: "DUPLICATE",
  unverified: "found, not verifiable from Google",
  not_found: "not found",
};

export const listListingPortalsTool = {
  name: "list_listing_portals",
  config: {
    title: "List listing portals",
    description:
      "Lists the directories, review sites and industry portals the listing check covers, with their domains and group. Uses no credits.",
    inputSchema: { projectId: projectIdSchema },
    outputSchema: z
      .object({
        portals: z.array(looseObjectOutputSchema),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: { projectId: string }, context) =>
    mcpResponse({
      text: LISTING_PORTALS.map(
        (portal) =>
          `- ${portal.name} (${portal.group}): ${portal.domains.join(", ")}`,
      ).join("\n"),
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
      structuredContent: { portals: LISTING_PORTALS },
    }),
  ),
};

const scanInput = {
  projectId: projectIdSchema,
  nap: napSchema.describe(
    "The business as it should appear everywhere: name, street with number, postal code, city, phone, website.",
  ),
  extraPortals: z
    .array(extraPortalSchema)
    .max(30)
    .optional()
    .describe("Project-specific portals to check in addition to the list."),
  maxCostUsd: z
    .number()
    .positive()
    .optional()
    .describe(
      "Most USD the user approved. Omit to get the estimate without scanning.",
    ),
} as const;

type ScanArgs = z.infer<z.ZodObject<typeof scanInput>>;

export const scanListingsTool = {
  name: "scan_listings",
  config: {
    title: "Scan directory listings",
    description:
      "Checks where a business is listed across German directories, review sites and industry portals, through Google results only (one business at a time, searches run one after another, no crawling of the portals). Per portal: correct, DEVIATING (phone, postal code or street differ from the given data), DUPLICATE (several entries), found but not verifiable, or not found, each with the entry URL and snippet. Also lists other websites carrying the business name (old site builders, copies) and hosts that list the business but are not on the portal list yet. Call without maxCostUsd to get the estimate; spends credits when maxCostUsd covers it. Saved per project; read again with get_listing_scan.",
    inputSchema: scanInput,
    outputSchema: z
      .object({
        estimate: looseObjectOutputSchema.optional(),
        scan: looseObjectOutputSchema.optional(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: ScanArgs, context) => {
    const extraPortals = (args.extraPortals ?? []).map((extra) => ({
      id: `extra:${extra.domain}`,
      name: extra.name,
      group: "branchenbuch" as const,
      domains: [extra.domain.toLowerCase().replace(/^www\./, "")],
    }));
    const meta = buildProjectMeta(
      context,
      args.projectId,
      `/p/${args.projectId}`,
    );
    if (args.maxCostUsd == null) {
      const estimate = estimateListingScan(args.nap, extraPortals);
      return mcpResponse({
        text: `Scanning ${estimate.portals} portals takes up to ${estimate.searches} Google searches, at most $${estimate.costUsd}. Retry with maxCostUsd after the user approves.`,
        meta,
        structuredContent: { estimate },
      });
    }
    const scan = await scanListings(
      {
        projectId: args.projectId,
        nap: args.nap,
        extraPortals,
        maxCostUsd: args.maxCostUsd,
        locationCode: context.project.locationCode,
        languageCode: context.project.languageCode,
      },
      context.billing,
    );
    return mcpResponse({
      text: renderScan(scan),
      meta,
      structuredContent: { scan },
    });
  }),
};

function renderScan(scan: Awaited<ReturnType<typeof scanListings>>) {
  const found = scan.rows.filter((row) => row.status !== "not_found");
  return [
    `Listing scan ${scan.scanId} (${scan.searches} searches): ${scan.summary.correct} correct, ${scan.summary.deviating} deviating, ${scan.summary.duplicate} duplicate, ${scan.summary.unverified} not verifiable, ${scan.summary.notFound} not found.`,
    ...found.map(
      (row) =>
        `- ${row.portal}: ${STATUS_LABEL[row.status]}${row.mismatches.length > 0 ? ` (${row.mismatches.join(", ")})` : ""} · ${row.entries.map((entry) => entry.url).join(" , ")}`,
    ),
    ...(scan.otherSites.length > 0
      ? [`Other websites with the business name: ${scan.otherSites.join(", ")}`]
      : []),
    ...scan.searchNotes.map(
      (note) =>
        `Note: search ${note.keyword} ${note.status === "partial" ? "returned only part of its pages" : `failed (${note.message ?? "unknown error"})`}; portals it would have found may show as not found.`,
    ),
    ...(scan.unlistedHosts.length > 0
      ? [
          `Also listed on (not on the portal list): ${scan.unlistedHosts.join(", ")}`,
        ]
      : []),
  ].join("\n");
}

export const getListingScanTool = {
  name: "get_listing_scan",
  config: {
    title: "Get listing scan",
    description:
      "Returns a saved listing scan of the project: the latest one, or the one with scanId. Uses no credits.",
    inputSchema: {
      projectId: projectIdSchema,
      scanId: z.uuid().optional().describe("Scan ID; defaults to the latest."),
    },
    outputSchema: z
      .object({
        scan: looseObjectOutputSchema.nullable(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: { projectId: string; scanId?: string }, context) => {
      const scan = await getListingScan(args.projectId, args.scanId);
      return mcpResponse({
        text: scan
          ? JSON.stringify(scan).slice(0, 20000)
          : "No listing scan yet for this project.",
        meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
        structuredContent: { scan },
      });
    },
  ),
};
