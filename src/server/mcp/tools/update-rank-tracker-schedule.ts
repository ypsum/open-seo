// Fork (ypsum): switch an existing tracker between manual and recurring checks.
import { z } from "zod";
import { RankTrackerScheduleService } from "@/server/features/rank-tracking/services/rankTrackerSchedule";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { scheduleTimeSchema } from "@/types/schemas/schedule-time";

const inputSchema = {
  projectId: projectIdSchema,
  trackerId: z.uuid().describe("Rank tracker ID from get_rank_tracker."),
  scheduleInterval: z
    .enum(["manual", "daily", "weekly", "monthly"])
    .describe("New check schedule. manual stops recurring checks."),
  scheduleTime: scheduleTimeSchema
    .optional()
    .describe(
      "When scheduled checks run. Pass the user's timeZone with it. Omit it unless the user asks for a specific time. Not valid with a manual schedule.",
    ),
  maxEstimatedScheduledCheckCredits: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Most credits per scheduled check, including retries, that the user approved. Required when switching a tracker with keywords to a recurring schedule; call without it first to get the estimate in the error.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const updateRankTrackerScheduleTool = {
  name: "update_rank_tracker_schedule",
  config: {
    title: "Update rank tracker schedule",
    description:
      "Change an existing rank tracker's schedule (manual, daily, weekly, monthly). Recurring checks use the cheaper task queue and spend credits on every future check: without maxEstimatedScheduledCheckCredits the call is rejected with the per-check and monthly estimate, which you show the user before retrying with the approved ceiling. Switching to manual stops recurring spend. Starts no check itself.",
    inputSchema,
    outputSchema: z
      .object({
        trackerId: z.string(),
        scheduleInterval: z.string(),
        nextCheckAt: z.string().nullable(),
        scheduledEstimate: z
          .looseObject({
            costUsd: z.number(),
            costCredits: z.number(),
            monthlyCostUsd: z.number(),
            monthlyCostCredits: z.number(),
          })
          .optional(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const result = await RankTrackerScheduleService.updateSchedule({
      configId: args.trackerId,
      projectId: args.projectId,
      scheduleInterval: args.scheduleInterval,
      scheduleTime: args.scheduleTime,
      maxEstimatedScheduledCheckCredits: args.maxEstimatedScheduledCheckCredits,
    });
    const estimate = result.scheduledEstimate;
    return mcpResponse({
      text: `Tracker ${args.trackerId} is now ${result.scheduleInterval}.${result.nextCheckAt ? ` Next check: ${result.nextCheckAt}.` : ""}${estimate ? ` Each check costs at most ${estimate.costCredits} credits including retries (~$${estimate.costUsd.toFixed(4)}; up to ~$${estimate.monthlyCostUsd.toFixed(2)}/month).` : ""}`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/rank-tracking/${args.trackerId}`,
      ),
      structuredContent: { trackerId: args.trackerId, ...result },
    });
  }),
};
