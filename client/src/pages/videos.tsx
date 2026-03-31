import { useState, useCallback, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Video, StreamingState, StorageInfo } from "@shared/schema";
import { VideoLibrary } from "@/components/video-library";
import { MonitorPlay, Database } from "lucide-react";

export interface UploadJob {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: "pending" | "uploading" | "paused" | "done" | "error";
  error?: string;
  sessionId?: string;
  bytesUploaded: number;
  speed?: number; // bytes/sec
}

// localStorage persistence record for each in-progress upload
interface PersistedUpload {
  sessionId: string;
  jobId: string;
  name: string;
  size: number;
  mimeType: string;
  bytesUploaded: number;
}

const STORAGE_KEY = "endlesscast_uploads";
const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB — must match server

function loadPersistedUploads(): PersistedUpload[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch { return []; }
}

function savePersistedUpload(record: PersistedUpload) {
  const all = loadPersistedUploads().filter(r => r.sessionId !== record.sessionId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...all, record]));
}

function removePersistedUpload(sessionId: string) {
  const all = loadPersistedUploads().filter(r => r.sessionId !== sessionId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

const MAX_CONCURRENT = 2;

export default function Videos() {
  const { toast } = useToast();
  const [uploadQueue, _setUploadQueue] = useState<UploadJob[]>([]);
  const activeCount = useRef(0);
  const queueRef = useRef<UploadJob[]>([]);
  const startedIds = useRef(new Set<string>());
  const filesRef = useRef(new Map<string, File>());
  const abortRefs = useRef(new Map<string, AbortController>());

  const { data: videos = [], isLoading: videosLoading } = useQuery<Video[]>({
    queryKey: ["/api/videos"],
  });

  const { data: streamingState } = useQuery<StreamingState>({
    queryKey: ["/api/streaming/state"],
    refetchInterval: 2000,
  });

  const { data: storageInfo } = useQuery<StorageInfo>({ queryKey: ["/api/storage"] });

  const setUploadQueue = useCallback((fn: (prev: UploadJob[]) => UploadJob[]) => {
    _setUploadQueue(prev => {
      const next = fn(prev);
      queueRef.current = next;
      return next;
    });
  }, []);

  const updateJob = useCallback((id: string, patch: Partial<UploadJob>) => {
    setUploadQueue(q => q.map(j => j.id === id ? { ...j, ...patch } : j));
  }, [setUploadQueue]);

  // On mount: check localStorage for sessions left from a previous page load
  useEffect(() => {
    const persisted = loadPersistedUploads();
    if (persisted.length === 0) return;
    const sessionId = localStorage.getItem("sessionId");

    persisted.forEach(async record => {
      try {
        const resp = await fetch(`/api/uploads/${record.sessionId}`, {
          headers: { "x-session-id": sessionId || "" },
        });
        if (!resp.ok) {
          removePersistedUpload(record.sessionId);
          return;
        }
        const data = await resp.json();
        // Add as a paused job — user needs to re-select file to resume
        const job: UploadJob = {
          id: record.jobId,
          name: record.name,
          size: record.size,
          progress: Math.round((data.bytesReceived / record.size) * 100),
          status: "paused",
          sessionId: record.sessionId,
          bytesUploaded: data.bytesReceived,
        };
        setUploadQueue(q => [...q, job]);
      } catch {
        removePersistedUpload(record.sessionId);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const uploadChunked = useCallback(
    async (job: UploadJob, file: File, existingSessionId?: string) => {
      const sessionId = localStorage.getItem("sessionId");

      // Step 1: init or reuse session
      let sid = existingSessionId;
      let startByte = job.bytesUploaded;

      if (!sid) {
        const initResp = await fetch("/api/uploads/init", {
          method: "POST",
          headers: { "x-session-id": sessionId || "", "Content-Type": "application/json" },
          body: JSON.stringify({ originalName: file.name, mimeType: file.type || "video/mp4", totalSize: file.size }),
        });
        if (!initResp.ok) {
          const err = await initResp.json().catch(() => ({}));
          throw new Error(err.message || "Failed to start upload");
        }
        const initData = await initResp.json();
        sid = initData.sessionId as string;
        startByte = 0;
      } else {
        // Resuming — ask server where it left off
        const statusResp = await fetch(`/api/uploads/${sid}`, {
          headers: { "x-session-id": sessionId || "" },
        });
        if (statusResp.ok) {
          const statusData = await statusResp.json();
          startByte = statusData.bytesReceived;
        }
      }

      updateJob(job.id, { sessionId: sid, status: "uploading", bytesUploaded: startByte });
      savePersistedUpload({ sessionId: sid, jobId: job.id, name: file.name, size: file.size, mimeType: file.type || "video/mp4", bytesUploaded: startByte });

      // Step 2: upload chunks
      let bytesSent = startByte;
      let lastTime = Date.now();
      let lastBytes = bytesSent;

      const abortCtrl = new AbortController();
      abortRefs.current.set(job.id, abortCtrl);

      while (bytesSent < file.size) {
        if (abortCtrl.signal.aborted) throw new Error("Cancelled");

        const end = Math.min(bytesSent + CHUNK_SIZE, file.size);
        const chunk = file.slice(bytesSent, end);
        const buffer = await chunk.arrayBuffer();

        let chunkResp: Response;
        try {
          chunkResp = await fetch(`/api/uploads/${sid}/chunk`, {
            method: "POST",
            headers: {
              "x-session-id": sessionId || "",
              "Content-Type": "application/octet-stream",
              "Content-Range": `bytes ${bytesSent}-${end - 1}/${file.size}`,
            },
            body: buffer,
            signal: abortCtrl.signal,
          });
        } catch (fetchErr: any) {
          if (fetchErr.name === "AbortError") throw new Error("Cancelled");
          throw fetchErr;
        }

        if (chunkResp.status === 409) {
          // Server says we're out of sync — jump to where it is
          const d = await chunkResp.json().catch(() => ({}));
          bytesSent = (d as any).bytesReceived ?? bytesSent;
          continue;
        }

        if (!chunkResp.ok) {
          const d = await chunkResp.json().catch(() => ({}));
          throw new Error((d as any).message || "Chunk upload failed");
        }

        const d = await chunkResp.json().catch(() => ({}));
        bytesSent = (d as any).bytesReceived ?? bytesSent;

        // Compute speed
        const now = Date.now();
        const elapsed = (now - lastTime) / 1000;
        const speed = elapsed > 0.5 ? Math.round((bytesSent - lastBytes) / elapsed) : undefined;
        if (elapsed > 0.5) { lastTime = now; lastBytes = bytesSent; }

        const progress = Math.round((bytesSent / file.size) * 100);
        updateJob(job.id, { progress, bytesUploaded: bytesSent, speed });
        savePersistedUpload({ sessionId: sid, jobId: job.id, name: file.name, size: file.size, mimeType: file.type || "video/mp4", bytesUploaded: bytesSent });
      }

      // Step 3: complete
      const completeResp = await fetch(`/api/uploads/${sid}/complete`, {
        method: "POST",
        headers: { "x-session-id": sessionId || "" },
      });
      if (!completeResp.ok) {
        const d = await completeResp.json().catch(() => ({}));
        throw new Error(d.message || "Failed to finalize upload");
      }

      removePersistedUpload(sid);
      abortRefs.current.delete(job.id);
      updateJob(job.id, { progress: 100, status: "done", speed: undefined });
      queryClient.invalidateQueries({ queryKey: ["/api/videos"] });
      queryClient.invalidateQueries({ queryKey: ["/api/storage"] });
    },
    [updateJob]
  );

  const drainQueue = useCallback(() => {
    const queue = queueRef.current;
    const pending = queue.filter(j => j.status === "pending" && !startedIds.current.has(j.id));
    while (activeCount.current < MAX_CONCURRENT && pending.length > 0) {
      const job = pending.shift()!;
      const file = filesRef.current.get(job.id);
      if (!file) continue;
      activeCount.current++;
      startedIds.current.add(job.id);
      updateJob(job.id, { status: "uploading" });
      uploadChunked(job, file).finally(() => {
        activeCount.current--;
        drainQueue();
      }).catch(err => {
        if (err.message !== "Cancelled") {
          updateJob(job.id, { status: "error", error: err.message });
          toast({ title: `Failed: ${job.name}`, description: err.message, variant: "destructive" });
        }
        activeCount.current--;
        drainQueue();
      });
    }
  }, [uploadChunked, updateJob, toast]);

  const handleUpload = useCallback((selectedFiles: File[]) => {
    if (!selectedFiles.length) return;

    const newJobs: UploadJob[] = selectedFiles.map(f => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: f.name,
      size: f.size,
      progress: 0,
      status: "pending" as const,
      bytesUploaded: 0,
    }));

    newJobs.forEach((j, i) => filesRef.current.set(j.id, selectedFiles[i]));
    queueRef.current = [...queueRef.current, ...newJobs];
    setUploadQueue(() => queueRef.current);
    drainQueue();
  }, [drainQueue, setUploadQueue]);

  // Resume a paused job — user has re-selected the file
  const handleResume = useCallback((jobId: string, file: File) => {
    const job = queueRef.current.find(j => j.id === jobId);
    if (!job || !job.sessionId) return;

    // Verify file matches
    if (file.name !== job.name || file.size !== job.size) {
      toast({ title: "File mismatch", description: "Please select the same file to resume.", variant: "destructive" });
      return;
    }

    filesRef.current.set(jobId, file);
    startedIds.current.add(jobId);
    activeCount.current++;
    updateJob(jobId, { status: "uploading" });

    uploadChunked(job, file, job.sessionId)
      .catch(err => {
        if (err.message !== "Cancelled") {
          updateJob(jobId, { status: "error", error: err.message });
          toast({ title: `Resume failed: ${job.name}`, description: err.message, variant: "destructive" });
        }
      })
      .finally(() => {
        activeCount.current--;
        drainQueue();
      });
  }, [uploadChunked, updateJob, drainQueue, toast]);

  const handleCancel = useCallback(async (jobId: string) => {
    const job = queueRef.current.find(j => j.id === jobId);
    if (!job) return;

    // Abort in-flight fetch
    abortRefs.current.get(jobId)?.abort();
    abortRefs.current.delete(jobId);

    // Delete server-side session
    if (job.sessionId) {
      const sessionId = localStorage.getItem("sessionId");
      fetch(`/api/uploads/${job.sessionId}`, {
        method: "DELETE",
        headers: { "x-session-id": sessionId || "" },
      }).catch(() => { /* best-effort */ });
      removePersistedUpload(job.sessionId);
    }

    startedIds.current.delete(jobId);
    filesRef.current.delete(jobId);

    setUploadQueue(q => q.filter(j => j.id !== jobId));
  }, [setUploadQueue]);

  const clearDone = useCallback(() => {
    setUploadQueue(q => {
      q.filter(j => j.status === "done" || j.status === "error").forEach(j => {
        startedIds.current.delete(j.id);
        filesRef.current.delete(j.id);
        abortRefs.current.delete(j.id);
      });
      return q.filter(j => j.status !== "done" && j.status !== "error");
    });
  }, [setUploadQueue]);

  const deleteMutation = useMutation({
    mutationFn: async (videoId: string) => apiRequest("DELETE", `/api/videos/${videoId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/videos"] });
      queryClient.invalidateQueries({ queryKey: ["/api/storage"] });
      toast({ title: "File Deleted", description: "Video removed from storage." });
    },
    onError: () => {
      toast({ title: "Delete Failed", description: "Could not remove the file.", variant: "destructive" });
    },
  });

  const selectVideoMutation = useMutation({
    mutationFn: async (videoId: string) =>
      apiRequest("POST", "/api/streaming/select-video", { videoId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/streaming/state"] });
      toast({ title: "Video Selected", description: "Video queued for broadcast." });
    },
  });

  const activeJobs = uploadQueue.filter(j => j.status !== "done" && j.status !== "error");
  const finishedJobs = uploadQueue.filter(j => j.status === "done" || j.status === "error");
  const storagePct = storageInfo ? Math.round((storageInfo.used / storageInfo.limit) * 100) : 0;

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-5">
      {storageInfo && (
        <div className="flex items-center gap-4 px-5 py-4 rounded-xl border border-border/60 bg-card">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Database className="w-4 h-4 text-primary/60" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-muted-foreground">Storage Usage</span>
              <span className="text-xs text-muted-foreground">
                {formatBytes(storageInfo.used)} / {formatBytes(storageInfo.limit)}
              </span>
            </div>
            <div className="h-1.5 bg-muted/30 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 ${storagePct > 90 ? "bg-destructive" : "bg-primary/60"}`}
                style={{ width: `${storagePct}%` }}
              />
            </div>
          </div>
          <span className={`text-2xl font-bold leading-none flex-shrink-0 tabular-nums ${storagePct > 90 ? "text-destructive" : "text-foreground/70"}`}>
            {storagePct}%
          </span>
          <span className="text-xs text-muted-foreground flex-shrink-0">
            {formatBytes(storageInfo.limit - storageInfo.used)} free
          </span>
        </div>
      )}

      <div className="rounded-xl border border-border/60 bg-card p-5">
        <div className="flex items-center gap-2.5 pb-3 mb-4 border-b border-border/50">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <MonitorPlay className="w-4 h-4 text-primary" />
          </div>
          <h3 className="text-sm font-semibold text-foreground">Video Library</h3>
        </div>
        <VideoLibrary
          videos={videos}
          selectedVideoId={streamingState?.selectedVideoId || null}
          isStreaming={streamingState?.isStreaming || false}
          isLoading={videosLoading}
          uploadQueue={uploadQueue}
          activeJobs={activeJobs}
          finishedJobs={finishedJobs}
          storageUsed={storageInfo?.used ?? 0}
          storageLimit={storageInfo?.limit ?? 1}
          onUpload={handleUpload}
          onDelete={(id: string) => deleteMutation.mutate(id)}
          onSelect={(id: string) => selectVideoMutation.mutate(id)}
          onClearDone={clearDone}
          onCancel={handleCancel}
          onResume={handleResume}
        />
      </div>
    </div>
  );
}
