// Fork (ypsum): change an existing tracker's schedule from MCP. Moving to a
// recurring schedule spends credits on every future check, so it needs the
// caller's approved per-check ceiling, like adding keywords to a scheduled
// tracker does.
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { RankTrackingService } from "@/server/features/rank-tracking/services/RankTrackingService";
import { AppError } from "@/server/lib/errors";
import {
  estimateScheduledRankCheckCredits,
  isScheduledRankTrackingInterval,
} from "@/shared/rank-tracking";
import type { RankCheckScheduleTime } from "@/types/schemas/rank-tracking";

type ScheduleInterval = "manual" | "daily" | "weekly" | "monthly";

async function updateSchedule(input: {
  configId: string;
  projectId: string;
  scheduleInterval: ScheduleInterval;
  scheduleTime?: RankCheckScheduleTime;
  maxEstimatedScheduledCheckCredits?: number;
}) {
  const config = await RankTrackingRepository.getConfigById({
    configId: input.configId,
    projectId: input.projectId,
  });
  if (!config) {
    throw new AppError("NOT_FOUND", "Rank tracking config not found");
  }

  let scheduledEstimate:
    | ReturnType<typeof estimateScheduledRankCheckCredits>
    | undefined;
  if (isScheduledRankTrackingInterval(input.scheduleInterval)) {
    const keywords = await RankTrackingRepository.getKeywordsForConfig(
      input.configId,
    );
    scheduledEstimate = estimateScheduledRankCheckCredits(
      keywords.map((kw) => kw.keyword),
      config.devices,
      config.serpDepth,
      input.scheduleInterval,
    );
    if (
      keywords.length > 0 &&
      (input.maxEstimatedScheduledCheckCredits == null ||
        scheduledEstimate.costCredits > input.maxEstimatedScheduledCheckCredits)
    ) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Each ${input.scheduleInterval} check would cost up to ${scheduledEstimate.costCredits} credits including retries (~$${scheduledEstimate.costUsd.toFixed(4)} per check; up to ~${scheduledEstimate.monthlyCostCredits} credits/month). Show this to the user, then retry with maxEstimatedScheduledCheckCredits set to the approved per-check estimate.`,
      );
    }
  }

  await RankTrackingService.updateConfig(input.configId, input.projectId, {
    scheduleInterval: input.scheduleInterval,
    scheduleTime: input.scheduleTime,
  });
  const updated = await RankTrackingRepository.getConfigById({
    configId: input.configId,
    projectId: input.projectId,
  });
  return {
    scheduleInterval: input.scheduleInterval,
    nextCheckAt: updated?.nextCheckAt ?? null,
    scheduledEstimate,
  };
}

export const RankTrackerScheduleService = { updateSchedule } as const;
