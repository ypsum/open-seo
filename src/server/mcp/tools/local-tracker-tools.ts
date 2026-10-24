// Fork (ypsum): saved Local SEO grid trackers over MCP, so the monthly map
// heatmap can be set up and run by an agent instead of in the app.
import { z } from "zod";
import { LocalSeoService } from "@/server/features/local-seo/services/LocalSeoService";
import { AppError } from "@/server/lib/errors";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import {
  localBusinessSchema,
  localKeywordsSchema,
} from "@/types/schemas/local-seo";

const trackerIdSchema = z.uuid().describe("Local SEO tracker ID.");
const localUrl = (projectId: string) => `/p/${projectId}/local-seo`;

export const listLocalTrackersTool = {
  name: "list_local_trackers",
  config: {
    title: "List local SEO trackers",
    description:
      "Lists the project's saved Local SEO grid trackers (business, grid size, spacing). Uses no credits.",
    inputSchema: { projectId: projectIdSchema },
    outputSchema: z
      .object({
        trackers: z.array(looseObjectOutputSchema),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: { projectId: string }, context) => {
    const trackers = await LocalSeoService.listTrackers(args.projectId);
    return mcpResponse({
      text:
        trackers.length === 0
          ? "No local SEO trackers yet."
          : trackers
              .map(
                (tracker) =>
                  `- ${tracker.id}: ${tracker.title} · ${tracker.gridSize}x${tracker.gridSize} · ${tracker.spacingKm} km`,
              )
              .join("\n"),
      meta: buildProjectMeta(context, args.projectId, localUrl(args.projectId)),
      structuredContent: { trackers },
    });
  }),
};

const createInput = {
  projectId: projectIdSchema,
  business: localBusinessSchema
    .optional()
    .describe(
      "The Google Maps listing: title, cid or placeId, address, latitude, longitude. Omit and pass businessQuery to look it up.",
    ),
  businessQuery: z
    .string()
    .trim()
    .min(2)
    .max(200)
    .optional()
    .describe(
      "Business name and address to look up the listing (charges a small business-info lookup). Ignored when business is given.",
    ),
  keywords: localKeywordsSchema
    .min(1)
    .describe("Searches to check at every grid point, up to 20."),
  gridSize: z
    .union([z.literal(3), z.literal(5), z.literal(7), z.literal(9)])
    .describe("Grid width: 3, 5, 7 or 9 (9x9 = 81 searches per keyword)."),
  spacingKm: z
    .number()
    .min(0.25)
    .max(10)
    .describe("Distance between neighbouring grid points, in km."),
} as const;

type CreateArgs = z.infer<z.ZodObject<typeof createInput>>;

export const createLocalTrackerTool = {
  name: "create_local_tracker",
  config: {
    title: "Create local SEO tracker",
    description:
      "Saves a Local SEO grid tracker for a Google Maps listing, centered on its pin. Saving starts no check and uses no credits (except the optional businessQuery lookup). Run checks with start_local_check after reading the estimate from get_local_tracker.",
    inputSchema: createInput,
    outputSchema: z
      .object({
        trackerId: z.string(),
        tracker: looseObjectOutputSchema,
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: CreateArgs, context) => {
    let business = args.business;
    if (!business && args.businessQuery) {
      business =
        (await LocalSeoService.lookupBusiness(
          args.businessQuery,
          context.project,
          context.billing,
        )) ?? undefined;
    }
    if (!business) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Pass business, or a businessQuery that finds the Google Maps listing.",
      );
    }
    const tracker = await LocalSeoService.createTracker(
      {
        projectId: args.projectId,
        business,
        keywords: args.keywords,
        gridSize: args.gridSize,
        spacingKm: args.spacingKm,
      },
      context.project.languageCode,
    );
    return mcpResponse({
      text: `Created local tracker ${tracker.id} for ${tracker.title} (${tracker.gridSize}x${tracker.gridSize}, ${tracker.spacingKm} km, ${args.keywords.length} keywords). No check was started.`,
      meta: buildProjectMeta(context, args.projectId, localUrl(args.projectId)),
      structuredContent: { trackerId: tracker.id, tracker },
    });
  }),
};

export const getLocalTrackerTool = {
  name: "get_local_tracker",
  config: {
    title: "Get local SEO tracker",
    description:
      "Returns a Local SEO tracker with its keywords, past checks with per-keyword summaries (points found, top-3 share, average rank) and the cost estimate of the next check. Uses no credits.",
    inputSchema: { projectId: projectIdSchema, trackerId: trackerIdSchema },
    outputSchema: z
      .object({
        tracker: looseObjectOutputSchema,
        estimate: looseObjectOutputSchema,
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
    async (args: { projectId: string; trackerId: string }, context) => {
      const state = await LocalSeoService.getTracker(
        args.projectId,
        args.trackerId,
      );
      const keywordById = new Map(
        state.keywords.map((keyword) => [keyword.id, keyword.keyword]),
      );
      const scans = state.scans.map(
        (scan) =>
          `- ${keywordById.get(scan.keywordId) ?? scan.keywordId} (${scan.createdAt}): found ${scan.summary?.found ?? 0}/${scan.summary?.total ?? 0}, top 3 ${scan.summary?.top3Percent ?? "-"}%, avg rank ${scan.summary?.averageRank ?? "-"}`,
      );
      return mcpResponse({
        text: [
          `${state.tracker.title} · ${state.tracker.gridSize}x${state.tracker.gridSize} · ${state.tracker.spacingKm} km · keywords: ${state.keywords.map((keyword) => keyword.keyword).join(", ")}`,
          `Next check: ${state.estimate.searches} searches, up to ${state.estimate.costCredits} credits (~$${state.estimate.costUsd.toFixed(2)}).`,
          ...(scans.length > 0 ? ["Checks:", ...scans] : ["No checks yet."]),
        ].join("\n"),
        meta: buildProjectMeta(
          context,
          args.projectId,
          localUrl(args.projectId),
        ),
        structuredContent: { ...state },
      });
    },
  ),
};

const startInput = {
  projectId: projectIdSchema,
  trackerId: trackerIdSchema,
  maxCostCredits: z
    .number()
    .int()
    .positive()
    .describe(
      "Credits the user approved after seeing get_local_tracker's estimate. A higher fresh estimate is rejected.",
    ),
} as const;

type StartArgs = z.infer<z.ZodObject<typeof startInput>>;

export const startLocalCheckTool = {
  name: "start_local_check",
  config: {
    title: "Start local SEO check",
    description:
      "Runs every keyword of a Local SEO tracker across its grid on Google Maps. Spends credits: read the estimate with get_local_tracker, show it to the user and pass the approved amount as maxCostCredits. Returns the check; results appear in get_local_tracker once it completes.",
    inputSchema: startInput,
    outputSchema: z
      .object({
        check: looseObjectOutputSchema,
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: StartArgs, context) => {
    const check = await LocalSeoService.startCheck(
      {
        projectId: args.projectId,
        trackerId: args.trackerId,
        requestId: crypto.randomUUID(),
        maxCostCredits: args.maxCostCredits,
      },
      context.billing,
    );
    return mcpResponse({
      text: `Local check ${check.id} is ${check.status}. Read the results with get_local_tracker.`,
      meta: buildProjectMeta(context, args.projectId, localUrl(args.projectId)),
      structuredContent: { check },
    });
  }),
};
