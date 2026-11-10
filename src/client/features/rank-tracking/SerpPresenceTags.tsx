// Fork (ypsum): where the tracked site shows up in the map pack and the AI
// Overview, read off the same results page as the organic position.
import { MapPin, Sparkles } from "lucide-react";
import { Badge } from "@/client/components/ui/badge";
import type { RankTrackingDeviceResult } from "@/types/schemas/rank-tracking";

export function SerpPresenceTags({
  result,
}: {
  result: RankTrackingDeviceResult;
}) {
  const { localPackPosition, aiOverview } = result;
  const showMap = localPackPosition != null;
  const showAi = aiOverview != null && aiOverview.mentioned;
  if (!showMap && !showAi) return null;
  return (
    <div className="flex gap-1 flex-wrap">
      {showMap && (
        <Badge
          variant="default"
          size="sm"
          className="cursor-help"
          title="Position of your business in the map pack"
        >
          <MapPin />
          Map #{localPackPosition}
        </Badge>
      )}
      {showAi && (
        <Badge
          variant="default"
          size="sm"
          className="cursor-help"
          title={
            aiOverview.linked
              ? "The AI Overview mentions your business and links your site"
              : "The AI Overview mentions your business but does not link your site"
          }
        >
          <Sparkles />
          {aiOverview.linked ? "AI linked" : "AI mentioned"}
        </Badge>
      )}
    </div>
  );
}
