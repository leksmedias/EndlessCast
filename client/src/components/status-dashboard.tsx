import { Activity, AlertTriangle, Loader2, Play } from "lucide-react";
import { SiYoutube, SiFacebook } from "react-icons/si";
import type { RtmpEndpoint, StreamingState, RtmpPlatform, StreamStatus } from "@shared/schema";
import { platformInfo } from "@shared/schema";

interface StatusDashboardProps {
  endpoints: RtmpEndpoint[];
  streamingState: StreamingState | undefined;
  onStartEndpoint?: (endpointId: string) => void;
  startingEndpointId?: string | null;
}

function PlatformIcon({ platform, className }: { platform: RtmpPlatform; className?: string }) {
  switch (platform) {
    case "youtube":
      return <SiYoutube className={className} style={{ color: platformInfo.youtube.color }} />;
    case "facebook":
      return <SiFacebook className={className} style={{ color: platformInfo.facebook.color }} />;
    case "rumble":
      return <span className={`font-bold text-xs ${className}`} style={{ color: platformInfo.rumble.color }}>R</span>;
    case "odysee":
      return <span className={`font-bold text-xs ${className}`} style={{ color: platformInfo.odysee.color }}>O</span>;
    case "twitter":
      return <span className={`font-bold text-xs ${className}`}>X</span>;
    default:
      return <Activity className={className} />;
  }
}

function StatusDot({ status }: { status: StreamStatus["status"] }) {
  switch (status) {
    case "live":
      return (
        <span className="relative flex h-2 w-2 flex-shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
        </span>
      );
    case "connecting":
    case "reconnecting":
      return <Loader2 className="w-2.5 h-2.5 text-yellow-500 animate-spin flex-shrink-0" />;
    case "error":
      return <AlertTriangle className="w-2.5 h-2.5 text-destructive flex-shrink-0" />;
    default:
      return <span className="w-2 h-2 rounded-full bg-muted-foreground/20 flex-shrink-0" />;
  }
}

function statusLabel(status: StreamStatus["status"]) {
  switch (status) {
    case "live": return { text: "Live", color: "text-green-500" };
    case "connecting": return { text: "Connecting", color: "text-yellow-500" };
    case "reconnecting": return { text: "Reconnecting", color: "text-yellow-500" };
    case "error": return { text: "Error", color: "text-destructive" };
    case "stopped": return { text: "Stopped", color: "text-muted-foreground/40" };
    default: return { text: "Idle", color: "text-muted-foreground/40" };
  }
}

export function StatusDashboard({ endpoints, streamingState, onStartEndpoint, startingEndpointId }: StatusDashboardProps) {
  const isStreaming = streamingState?.isStreaming || false;
  const endpointStatuses = streamingState?.endpointStatuses || [];

  const getEndpointStatus = (endpointId: string): StreamStatus =>
    endpointStatuses.find(s => s.endpointId === endpointId) ||
    { endpointId, status: "idle" as const, reconnectCount: 0 };

  return (
    <div className="space-y-2">
      {endpoints.map((endpoint) => {
        const epStatus = getEndpointStatus(endpoint.id);
        const { text, color } = statusLabel(epStatus.status);
        const isLive = epStatus.status === "live";

        return (
          <div
            key={endpoint.id}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all ${
              isLive
                ? "border-green-500/20 bg-green-500/5"
                : epStatus.status === "error"
                  ? "border-destructive/20 bg-destructive/5"
                  : "border-border/40 bg-muted/10"
            }`}
            data-testid={`status-card-${endpoint.id}`}
          >
            {/* Platform icon */}
            <div
              className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: `${platformInfo[endpoint.platform].color}18` }}
            >
              <PlatformIcon platform={endpoint.platform} className="w-4 h-4" />
            </div>

            {/* Name */}
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold truncate leading-snug" data-testid={`text-status-name-${endpoint.id}`}>
                {endpoint.name}
              </p>
              {isLive && (epStatus.bitrate || epStatus.fps) && (
                <p className="text-[10px] text-green-500/60 tabular-nums mt-0.5">
                  {epStatus.bitrate ? `${(epStatus.bitrate / 1000).toFixed(0)} kbps` : ""}
                  {epStatus.bitrate && epStatus.fps ? " · " : ""}
                  {epStatus.fps ? `${epStatus.fps} fps` : ""}
                </p>
              )}
              {epStatus.status === "reconnecting" && epStatus.reconnectCount && (
                <p className="text-[10px] text-yellow-500/60 mt-0.5">
                  Attempt {epStatus.reconnectCount}/3
                </p>
              )}
              {epStatus.status === "error" && epStatus.errorMessage && (
                <p className="text-[10px] text-destructive/60 truncate mt-0.5">
                  {epStatus.errorMessage}
                </p>
              )}
            </div>

            {/* Status indicator + Go Live button */}
            <div className="flex items-center gap-2 flex-shrink-0">
              {isStreaming && onStartEndpoint && (epStatus.status === "stopped" || epStatus.status === "idle" || epStatus.status === "error") && (
                <button
                  onClick={() => onStartEndpoint(endpoint.id)}
                  disabled={startingEndpointId === endpoint.id}
                  className="flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded border border-green-500/40 bg-green-500/10 text-green-500 hover:bg-green-500/20 disabled:opacity-50 transition-colors"
                >
                  {startingEndpointId === endpoint.id
                    ? <Loader2 className="w-2.5 h-2.5 animate-spin" />
                    : <Play className="w-2.5 h-2.5" />}
                  Go Live
                </button>
              )}
              <StatusDot status={epStatus.status} />
              <span className={`text-[11px] font-medium ${color}`}>{text}</span>
            </div>
          </div>
        );
      })}

      {!isStreaming && endpoints.length > 0 && (
        <p className="text-[11px] text-muted-foreground/30 text-center pt-1">
          Start streaming to see live status
        </p>
      )}
    </div>
  );
}
