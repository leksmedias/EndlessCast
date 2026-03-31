import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { RtmpEndpoint, StreamingState, InsertRtmpEndpoint, Video } from "@shared/schema";
import { RtmpPanel } from "@/components/rtmp-panel";
import { StatusDashboard } from "@/components/status-dashboard";
import { Server, Wifi, Radio } from "lucide-react";

export default function Destinations() {
  const { toast } = useToast();
  const [startingEndpointId, setStartingEndpointId] = useState<string | null>(null);

  const { data: endpoints = [], isLoading: endpointsLoading } = useQuery<RtmpEndpoint[]>({
    queryKey: ["/api/rtmp-endpoints"],
  });

  const { data: videos = [] } = useQuery<Video[]>({
    queryKey: ["/api/videos"],
  });

  const { data: streamingState } = useQuery<StreamingState>({
    queryKey: ["/api/streaming/state"],
    refetchInterval: 2000,
  });

  const enabledEndpoints = endpoints.filter((e) => e.enabled);
  const disabledEndpoints = endpoints.filter((e) => !e.enabled);

  const createEndpointMutation = useMutation({
    mutationFn: async (endpoint: InsertRtmpEndpoint) =>
      apiRequest("POST", "/api/rtmp-endpoints", endpoint),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rtmp-endpoints"] });
      toast({ title: "Endpoint Added", description: "RTMP destination configured." });
    },
  });

  const updateEndpointMutation = useMutation({
    mutationFn: async ({ id, ...data }: RtmpEndpoint) =>
      apiRequest("PATCH", `/api/rtmp-endpoints/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rtmp-endpoints"] });
    },
  });

  const deleteEndpointMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/rtmp-endpoints/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rtmp-endpoints"] });
      toast({ title: "Endpoint Removed", description: "RTMP destination deleted." });
    },
  });

  const handleStartEndpoint = async (endpointId: string) => {
    setStartingEndpointId(endpointId);
    try {
      await apiRequest("POST", `/api/streaming/start-endpoint/${endpointId}`);
      queryClient.invalidateQueries({ queryKey: ["/api/streaming/state"] });
      const ep = endpoints.find(e => e.id === endpointId);
      toast({ title: "Going Live", description: `${ep?.name ?? "Endpoint"} is connecting...` });
    } catch (err: any) {
      toast({ title: "Failed to Start", description: err.message, variant: "destructive" });
    } finally {
      setStartingEndpointId(null);
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-5">
      <div className="rounded-xl border border-border/60 bg-card p-5">
        <div className="flex items-center justify-between gap-3 pb-3 mb-4 border-b border-border/50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Server className="w-4 h-4 text-primary" />
            </div>
            <h3 className="text-sm font-semibold text-foreground">Broadcast Channels</h3>
          </div>
          {endpoints.length > 0 && (
            <div className="flex items-center gap-2">
              {disabledEndpoints.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {disabledEndpoints.length} excluded
                </span>
              )}
              <span className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border ${
                enabledEndpoints.length > 0
                  ? "border-green-500/30 bg-green-500/10 text-green-500"
                  : "border-border text-muted-foreground"
              }`}>
                <Radio className="w-3 h-3" />
                {enabledEndpoints.length} / {endpoints.length} selected
              </span>
            </div>
          )}
        </div>
        <RtmpPanel
          endpoints={endpoints}
          videos={videos}
          isLoading={endpointsLoading}
          onCreate={(endpoint: InsertRtmpEndpoint) => createEndpointMutation.mutate(endpoint)}
          onUpdate={(endpoint: RtmpEndpoint) => updateEndpointMutation.mutate(endpoint)}
          onDelete={(id: string) => deleteEndpointMutation.mutate(id)}
        />
      </div>

      {enabledEndpoints.length > 0 && (
        <div className="rounded-xl border border-border/60 bg-card p-5">
          <div className="flex items-center gap-2.5 pb-3 mb-4 border-b border-border/50">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Wifi className="w-4 h-4 text-primary" />
            </div>
            <h3 className="text-sm font-semibold text-foreground">Endpoint Status</h3>
          </div>
          <StatusDashboard
            endpoints={enabledEndpoints}
            streamingState={streamingState}
            onStartEndpoint={handleStartEndpoint}
            startingEndpointId={startingEndpointId}
          />
        </div>
      )}
    </div>
  );
}
