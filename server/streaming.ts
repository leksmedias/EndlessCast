import { spawn, ChildProcess } from "child_process";
import { storage } from "./storage";
import { emailService } from "./email";
import { telegramService } from "./telegram";
import type { RtmpEndpoint, ExtraCamera } from "@shared/schema";
import { outputProfileInfo } from "@shared/schema";
import path from "path";

// Reconnect forever — stream only stops when the user says so or a preset duration expires
const INITIAL_RECONNECT_DELAY_MS = 5_000;   // 5 seconds
const MAX_RECONNECT_DELAY_MS = 120_000;     // cap at 2 minutes
const STABLE_STREAM_THRESHOLD_MS = 30_000;  // 30s of stable streaming resets the backoff

interface StreamProcess {
  endpointId: string;
  ffmpegProcess: ChildProcess;
  startedAt: number;  // timestamp when this process was spawned
}

interface ReconnectState {
  endpointId: string;
  attempts: number;
  timer: NodeJS.Timeout | null;
  videoPath: string;
  endpoint: RtmpEndpoint;
  durationSeconds: number;
  extraCameraPath: string | null;
  extraCameraConfig: ExtraCamera | null;
}

class StreamingService {
  private processes: Map<string, StreamProcess> = new Map();
  private reconnectStates: Map<string, ReconnectState> = new Map();
  private monitorInterval: NodeJS.Timeout | null = null;
  private durationTimer: NodeJS.Timeout | null = null;
  private isStopping = false;

  async startStreaming(durationSeconds?: number): Promise<void> {
    const state = await storage.getStreamingState();

    const endpoints = await storage.getRtmpEndpoints();
    const enabledEndpoints = endpoints.filter(e => e.enabled);

    if (enabledEndpoints.length === 0) {
      throw new Error("No RTMP endpoints configured");
    }

    const endpointVideoSources: Map<string, string> = new Map();
    const skippedEndpoints: string[] = [];

    for (const endpoint of enabledEndpoints) {
      const resolvedVideoId = endpoint.videoId ?? state.selectedVideoId;
      if (!resolvedVideoId) {
        skippedEndpoints.push(`"${endpoint.name}" — no video assigned`);
        continue;
      }
      const video = await storage.getVideo(resolvedVideoId);
      if (!video) {
        skippedEndpoints.push(`"${endpoint.name}" — video not found`);
        continue;
      }
      endpointVideoSources.set(endpoint.id, path.join(process.cwd(), "uploads", video.filename));
    }

    const launchableEndpoints = enabledEndpoints.filter(e => endpointVideoSources.has(e.id));

    if (launchableEndpoints.length === 0) {
      throw new Error(
        "No endpoints could start. " +
        (skippedEndpoints.length > 0
          ? "Issues: " + skippedEndpoints.join("; ")
          : "No video selected.")
      );
    }

    if (skippedEndpoints.length > 0) {
      for (const msg of skippedEndpoints) {
        console.warn(`[skip] ${msg}`);
        await storage.addLog({ level: "warn", message: `Skipped endpoint: ${msg}` });
      }
    }

    // Schedule auto-stop if a duration was explicitly requested
    if (durationSeconds) {
      if (this.durationTimer) clearTimeout(this.durationTimer);
      this.durationTimer = setTimeout(() => {
        console.log(`[duration] Scheduled stop after ${durationSeconds}s`);
        this.stopStreaming();
      }, durationSeconds * 1000);
    }

    const limit = 0; // Unused — FFmpeg now loops forever; duration is handled server-side

    let extraCameraPath: string | null = null;
    const extraCamera = state.extraCamera?.enabled ? state.extraCamera : null;
    if (extraCamera) {
      const camVideo = await storage.getVideo(extraCamera.videoId);
      if (camVideo) {
        extraCameraPath = path.join(process.cwd(), "uploads", camVideo.filename);
        console.log(`Extra camera: ${camVideo.originalName} @ ${extraCamera.position} (${extraCamera.sizePercent}%)`);
      } else {
        console.warn(`Extra camera video ${extraCamera.videoId} not found — streaming without PiP`);
      }
    }

    await storage.setStreamingState({
      isStreaming: true,
      startedAt: new Date().toISOString(),
      endpointStatuses: launchableEndpoints.map(e => ({
        endpointId: e.id,
        status: "connecting" as const,
        reconnectCount: 0,
      })),
    });

    await storage.addLog({
      level: "info",
      message: `Stream started → ${launchableEndpoints.length} endpoint(s)` +
        (skippedEndpoints.length > 0 ? ` (${skippedEndpoints.length} skipped)` : ""),
    });

    this.isStopping = false;

    for (let i = 0; i < launchableEndpoints.length; i++) {
      if (this.isStopping) {
        console.log("[startup] Stop requested during launch — aborting remaining endpoints");
        break;
      }

      const endpoint = launchableEndpoints[i];
      const videoSource = endpointVideoSources.get(endpoint.id)!;

      try {
        await this.startEndpointStream(
          videoSource, endpoint, limit, false,
          extraCameraPath, extraCamera,
        );
      } catch (err: any) {
        console.error(`[${endpoint.name}] Failed to launch:`, err.message);
        await storage.addLog({
          level: "error",
          message: `Failed to launch "${endpoint.name}": ${err.message}`,
          endpoint: endpoint.name,
        });
        await storage.updateEndpointStatus(endpoint.id, {
          status: "error",
          errorMessage: err.message,
        });
      }

      if (i < launchableEndpoints.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    await telegramService.notifyStreamStart(launchableEndpoints.map(e => e.name));
    this.startMonitoring();
  }

  private buildFfmpegArgs(
    videoSource: string,
    endpoint: RtmpEndpoint,
    durationSeconds: number,
    extraCameraPath: string | null,
    extraCamera: ExtraCamera | null,
  ): string[] {
    const profile = outputProfileInfo[endpoint.outputProfile ?? "landscape_1080p"];
    const rtmpFullUrl = `${endpoint.rtmpUrl}/${endpoint.streamKey}`;

    // Build the main video scale filter
    let mainScaleFilter: string;
    if (endpoint.outputProfile === "portrait_1080p") {
      mainScaleFilter = `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease,pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2`;
    } else if (endpoint.outputProfile === "square_1080p") {
      mainScaleFilter = `scale='if(gt(iw,ih),-1,${profile.width})':'if(gt(iw,ih),${profile.height},-1)',crop=${profile.width}:${profile.height}`;
    } else {
      mainScaleFilter = `scale='min(${profile.width},iw)':'min(${profile.height},ih)':force_original_aspect_ratio=decrease,pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2`;
    }

    const commonOutputArgs = [
      "-nostdin",          // prevent FFmpeg from hanging on stdin
      "-r", "30",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-b:v", profile.bitrate,
      "-maxrate", profile.maxrate,
      "-bufsize", profile.bufsize,
      "-pix_fmt", "yuv420p",
      "-g", "60",
      "-keyint_min", "60",
      "-sc_threshold", "0",
      "-c:a", "aac",
      "-b:a", "160k",
      "-ar", "44100",
      "-f", "flv",
      "-flvflags", "no_duration_filesize",  // prevent FLV timestamp issues on long streams
      rtmpFullUrl,
    ];

    if (extraCameraPath && extraCamera) {
      // PiP overlay: use filter_complex
      const pipWidth = Math.round(profile.width * (extraCamera.sizePercent / 100));
      // Ensure even width for libx264
      const pipWidthEven = pipWidth % 2 === 0 ? pipWidth : pipWidth + 1;

      const overlayPos: Record<string, string> = {
        "bottom-right": `W-w-20:H-h-20`,
        "bottom-left":  `20:H-h-20`,
        "top-right":    `W-w-20:20`,
        "top-left":     `20:20`,
      };
      const pos = overlayPos[extraCamera.position] ?? "W-w-20:H-h-20";

      const filterComplex = [
        `[0:v]${mainScaleFilter}[main]`,
        `[1:v]scale=${pipWidthEven}:-2[pip]`,
        `[main][pip]overlay=${pos}[out]`,
      ].join(";");

      return [
        "-re", "-stream_loop", "-1", "-fflags", "+genpts", "-i", videoSource,
        "-re", "-stream_loop", "-1", "-fflags", "+genpts", "-i", extraCameraPath,
        "-filter_complex", filterComplex,
        "-map", "[out]",
        "-map", "0:a",
        "-rtmp_live", "live",
        ...commonOutputArgs,
      ];
    } else {
      // No extra camera — simple -vf filter
      return [
        "-re", "-stream_loop", "-1", "-fflags", "+genpts", "-i", videoSource,
        "-vf", mainScaleFilter,
        "-rtmp_live", "live",
        ...commonOutputArgs,
      ];
    }
  }

  /**
   * Calculate reconnect delay with exponential backoff.
   * 5s → 10s → 20s → 40s → 80s → 120s (capped)
   */
  private getReconnectDelay(attempt: number): number {
    const delay = INITIAL_RECONNECT_DELAY_MS * Math.pow(2, attempt - 1);
    return Math.min(delay, MAX_RECONNECT_DELAY_MS);
  }

  private async startEndpointStream(
    videoSource: string,
    endpoint: RtmpEndpoint,
    durationSeconds: number,
    isReconnect: boolean,
    extraCameraPath: string | null,
    extraCamera: ExtraCamera | null,
  ): Promise<void> {
    const ffmpegArgs = this.buildFfmpegArgs(
      videoSource, endpoint, durationSeconds, extraCameraPath, extraCamera,
    );

    console.log(
      `[${endpoint.name}] ${isReconnect ? "Reconnecting" : "Starting"} stream → ${endpoint.rtmpUrl} ` +
      `(profile: ${endpoint.outputProfile ?? "landscape_1080p"}` +
      `${extraCameraPath ? ", PiP active" : ""})`
    );

    const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

    ffmpegProcess.stderr.on("data", (data) => {
      const output = data.toString();
      if (output.includes("frame=")) {
        const bitrateMatch = output.match(/bitrate=\s*([\d.]+)kbits/);
        const fpsMatch = output.match(/fps=\s*([\d.]+)/);
        const frameMatch = output.match(/frame=\s*(\d+)/);
        const dropMatch = output.match(/drop=\s*(\d+)/);

        const totalFrames = frameMatch ? parseInt(frameMatch[1]) : 0;
        const droppedFrames = dropMatch ? parseInt(dropMatch[1]) : 0;
        const dropPercentage = totalFrames > 0 ? (droppedFrames / totalFrames) * 100 : 0;
        const bufferHealth = Math.max(0, Math.min(100, 100 - dropPercentage));

        storage.updateEndpointStatus(endpoint.id, {
          status: "live",
          bitrate: bitrateMatch ? parseFloat(bitrateMatch[1]) * 1000 : undefined,
          fps: fpsMatch ? parseFloat(fpsMatch[1]) : undefined,
          healthMetrics: {
            droppedFrames,
            totalFrames,
            bufferHealth: Math.round(bufferHealth),
          },
        });
      }
    });

    ffmpegProcess.on("error", async (error) => {
      console.error(`[${endpoint.name}] Stream error:`, error.message);
      await storage.addLog({
        level: "error",
        message: `FFmpeg error on "${endpoint.name}": ${error.message}`,
        endpoint: endpoint.name,
        detail: error.message,
      });
    });

    ffmpegProcess.on("exit", async (code) => {
      console.log(`[${endpoint.name}] Exited with code ${code}`);
      this.processes.delete(endpoint.id);

      if (this.isStopping) {
        await storage.updateEndpointStatus(endpoint.id, { status: "stopped" });
        return;
      }

      const state = await storage.getStreamingState();
      if (!state.isStreaming) {
        await storage.updateEndpointStatus(endpoint.id, { status: "stopped" });
        return;
      }

      // Always reconnect — stream should never die unless the user stops it
      const errorMsg = `Process exited with code ${code}`;
      await storage.addLog({
        level: "warn",
        message: `"${endpoint.name}" disconnected (exit ${code}) — will reconnect`,
        endpoint: endpoint.name,
        detail: errorMsg,
      });

      await this.scheduleReconnect(
        videoSource, endpoint, durationSeconds, extraCameraPath, extraCamera,
      );
    });

    this.processes.set(endpoint.id, {
      endpointId: endpoint.id,
      ffmpegProcess,
      startedAt: Date.now(),
    });

    // Keep "reconnecting" status through reconnect spawns; only reset to "connecting" initially
    if (!isReconnect) {
      await storage.updateEndpointStatus(endpoint.id, { status: "connecting" });
    }

    setTimeout(async () => {
      const proc = this.processes.get(endpoint.id);
      if (proc && !proc.ffmpegProcess.killed) {
        const currentRs = this.reconnectStates.get(endpoint.id);
        const wasReconnect = (currentRs?.attempts ?? 0) > 0;
        await storage.updateEndpointStatus(endpoint.id, {
          status: "live",
          startedAt: new Date().toISOString(),
          reconnectCount: currentRs?.attempts ?? 0,
          nextReconnectAt: undefined,
        });
        await storage.addLog({
          level: "info",
          message: wasReconnect
            ? `"${endpoint.name}" reconnected and is live`
            : `"${endpoint.name}" is live`,
          endpoint: endpoint.name,
        });
        // Clear reconnect state after successful reconnect — fresh budget for future failures
        if (wasReconnect) {
          const rs = this.reconnectStates.get(endpoint.id);
          if (rs?.timer) clearTimeout(rs.timer);
          this.reconnectStates.delete(endpoint.id);
        }
      }
    }, 5000);

    // After the stream has been stable for STABLE_STREAM_THRESHOLD_MS, reset the backoff entirely
    setTimeout(async () => {
      const proc = this.processes.get(endpoint.id);
      if (proc && !proc.ffmpegProcess.killed) {
        // Stream survived long enough — reset reconnect state so future drops start fresh
        const rs = this.reconnectStates.get(endpoint.id);
        if (rs) {
          if (rs.timer) clearTimeout(rs.timer);
          this.reconnectStates.delete(endpoint.id);
          console.log(`[${endpoint.name}] Stream stable for ${STABLE_STREAM_THRESHOLD_MS / 1000}s — reconnect backoff reset`);
        }
      }
    }, STABLE_STREAM_THRESHOLD_MS);
  }

  private async scheduleReconnect(
    videoSource: string,
    endpoint: RtmpEndpoint,
    durationSeconds: number,
    extraCameraPath: string | null,
    extraCamera: ExtraCamera | null,
  ): Promise<void> {
    let rs = this.reconnectStates.get(endpoint.id);

    if (!rs) {
      const newRs: ReconnectState = {
        endpointId: endpoint.id,
        attempts: 0,
        timer: null,
        videoPath: videoSource,
        endpoint,
        durationSeconds,
        extraCameraPath,
        extraCameraConfig: extraCamera,
      };
      this.reconnectStates.set(endpoint.id, newRs);
      rs = newRs;
    }

    rs.attempts += 1;

    // Never give up — always reconnect
    const delayMs = this.getReconnectDelay(rs.attempts);

    console.log(`[${endpoint.name}] Reconnect attempt ${rs.attempts} in ${delayMs / 1000}s`);

    const nextReconnectAt = new Date(Date.now() + delayMs).toISOString();

    await storage.addLog({
      level: "warn",
      message: `"${endpoint.name}" reconnect attempt ${rs.attempts} in ${delayMs / 1000}s`,
      endpoint: endpoint.name,
    });

    await storage.updateEndpointStatus(endpoint.id, {
      status: "reconnecting",
      reconnectCount: rs.attempts,
      nextReconnectAt,
    });

    // Notify on repeated failures (every 10 attempts)
    if (rs.attempts % 10 === 0) {
      const emailSettings = await storage.getEmailSettings();
      if (emailSettings?.enabled && emailSettings?.notifyOnError) {
        await emailService.sendErrorAlert(
          emailSettings, endpoint.name,
          `Stream has been reconnecting for ${rs.attempts} attempts`,
          rs.attempts,
        );
      }
      await telegramService.notifyStreamError(
        endpoint.name,
        `Still reconnecting after ${rs.attempts} attempts (delay: ${delayMs / 1000}s)`,
      );
    }

    if (rs.timer) clearTimeout(rs.timer);

    const capturedRs = rs;
    capturedRs.timer = setTimeout(async () => {
      if (this.isStopping) {
        this.reconnectStates.delete(endpoint.id);
        return;
      }
      const state = await storage.getStreamingState();
      if (!state.isStreaming) {
        this.reconnectStates.delete(endpoint.id);
        return;
      }

      const latestEndpoint = await storage.getRtmpEndpoint(endpoint.id);
      if (!latestEndpoint || !latestEndpoint.enabled) {
        this.reconnectStates.delete(endpoint.id);
        return;
      }

      await this.startEndpointStream(
        capturedRs.videoPath, latestEndpoint, capturedRs.durationSeconds, true,
        capturedRs.extraCameraPath, capturedRs.extraCameraConfig,
      );
    }, delayMs);
  }

  async stopStreaming(): Promise<void> {
    this.isStopping = true;

    if (this.durationTimer) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }

    for (const rs of Array.from(this.reconnectStates.values())) {
      if (rs.timer) clearTimeout(rs.timer);
    }
    this.reconnectStates.clear();

    for (const [id, streamProc] of Array.from(this.processes.entries())) {
      streamProc.ffmpegProcess.kill("SIGTERM");
      await storage.updateEndpointStatus(id, { status: "stopped" });
    }
    this.processes.clear();

    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }

    await storage.setStreamingState({ isStreaming: false, startedAt: undefined });
    await storage.addLog({ level: "info", message: "Stream stopped" });
    await telegramService.notifyStreamStop();
  }

  private startMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }

    this.monitorInterval = setInterval(async () => {
      const state = await storage.getStreamingState();
      if (!state.isStreaming) {
        if (this.monitorInterval) {
          clearInterval(this.monitorInterval);
          this.monitorInterval = null;
        }
        return;
      }

      // Don't auto-stop when reconnecting — the stream is retrying and should keep going
    }, 5000);
  }

  isStreaming(): boolean {
    return this.processes.size > 0 || this.reconnectStates.size > 0;
  }

  async startSingleEndpoint(endpointId: string): Promise<void> {
    const state = await storage.getStreamingState();
    if (!state.isStreaming) {
      throw new Error("Not currently streaming — start the main stream first");
    }

    if (this.processes.has(endpointId)) {
      throw new Error("This endpoint is already streaming");
    }
    // Cancel any pending reconnect so we don't double-start
    const existingRs = this.reconnectStates.get(endpointId);
    if (existingRs?.timer) clearTimeout(existingRs.timer);
    this.reconnectStates.delete(endpointId);

    const endpoint = await storage.getRtmpEndpoint(endpointId);
    if (!endpoint) throw new Error("Endpoint not found");

    const resolvedVideoId = endpoint.videoId ?? state.selectedVideoId;
    if (!resolvedVideoId) throw new Error(`No video assigned to "${endpoint.name}"`);
    const video = await storage.getVideo(resolvedVideoId);
    if (!video) throw new Error("Assigned video not found");
    const videoPath = path.join(process.cwd(), "uploads", video.filename);

    let extraCameraPath: string | null = null;
    const extraCamera = state.extraCamera?.enabled ? state.extraCamera : null;
    if (extraCamera) {
      const camVideo = await storage.getVideo(extraCamera.videoId);
      if (camVideo) extraCameraPath = path.join(process.cwd(), "uploads", camVideo.filename);
    }

    await storage.updateEndpointStatus(endpointId, { status: "connecting", reconnectCount: 0 });
    await this.startEndpointStream(videoPath, endpoint, 0, false, extraCameraPath, extraCamera);
    await storage.addLog({
      level: "info",
      message: `"${endpoint.name}" started (added to active stream)`,
      endpoint: endpoint.name,
    });
  }
}

export const streamingService = new StreamingService();
