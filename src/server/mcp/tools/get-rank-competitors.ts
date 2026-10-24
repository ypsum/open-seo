// Fork (ypsum): own position against project-context competitors, per tracked
// keyword and check, read off the same results pages as the rank checks.
import { z } from "zod";
import { getCompetitorHistory } from "@/server/features/rank-tracking/services/rankCompetitorStore";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

const inputSchema = {
  projectId: projectIdSchema,
  trackerId: z.uuid().describe("Rank tracker ID from get_rank_tracker."),
  runs: z
    .number()
    .int()
    .min(1)
    .max(26)
    .optional()
    .describe("How many of the newest checks to return. Defaults to 4."),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

const positionOutput = z
  .object({ position: z.number().nullable(), url: z.string().nullable() })
  .passthrough();

const position = (value: number | null) =>
  value == null ? "-" : String(value);

export const getRankCompetitorsTool = {
  name: "get_rank_competitors",
  config: {
    title: "Get rank competitors",
    description:
      "Returns, for each tracked keyword and recent check, the project domain's organic position next to the positions of the competitors saved in the project context, read off the same results page (no extra credits). Only checks run after competitors were saved have data. '-' means not found within the tracker's search depth. Uses no credits.",
    inputSchema,
    outputSchema: z
      .object({
        trackerId: z.string(),
        runs: z.array(
          z
            .object({
              runId: z.string(),
              checkedAt: z.string().nullable(),
              checks: z.array(
                z
                  .object({
                    keyword: z.string(),
                    device: z.string(),
                    own: positionOutput,
                    competitors: z.array(
                      positionOutput
                        .extend({ domain: z.string() })
                        .passthrough(),
                    ),
                  })
                  .passthrough(),
              ),
            })
            .passthrough(),
        ),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const runs = await getCompetitorHistory({
      projectId: args.projectId,
      configId: args.trackerId,
      runs: args.runs ?? 4,
    });
    const text =
      runs.length === 0
        ? "No competitor positions yet. They are saved from the next rank check after competitors are added to the project context."
        : runs
            .map((run) =>
              [
                `Check ${run.checkedAt ?? run.runId}:`,
                ...run.checks.map(
                  (check) =>
                    `- ${check.keyword} (${check.device}): own ${position(check.own.position)}; ${check.competitors
                      .map((c) => `${c.domain} ${position(c.position)}`)
                      .join(", ")}`,
                ),
              ].join("\n"),
            )
            .join("\n\n");
    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/rank-tracking/${args.trackerId}`,
      ),
      structuredContent: { trackerId: args.trackerId, runs },
    });
  }),
};
