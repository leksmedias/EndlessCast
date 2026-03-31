import express from "express";
import type { Express, Request, Response } from "express";
import type { Server } from "http";
import multer from "multer";
import path from "path";
import fs from "fs";
import os from "os";
import { promisify } from "util";
import { exec } from "child_process";
import { storage } from "./storage";
import { streamingService } from "./streaming";
import { emailService } from "./email";
import { authService } from "./auth";
import { telegramService } from "./telegram";
import { insertRtmpEndpointSchema, MAX_STORAGE_BYTES, MAX_VIDEOS, insertEmailSettingsSchema, insertThemeSettingsSchema, insertTelegramSettingsSchema } from "@shared/schema";

const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB chunks


const execAsync = promisify(exec);

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Ensure thumbnails directory exists
const thumbnailsDir = path.join(process.cwd(), "uploads", "thumbnails");
if (!fs.existsSync(thumbnailsDir)) {
  fs.mkdirSync(thumbnailsDir, { recursive: true });
}

// Configure multer for video uploads
const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `video-${uniqueSuffix}${ext}`);
  },
});

const upload = multer({
  storage: uploadStorage,
  limits: {
    fileSize: MAX_STORAGE_BYTES,
    fieldSize: 200 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = ["video/mp4", "video/quicktime", "video/x-matroska"];
    const allowedExts = [".mp4", ".mov", ".mkv"];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedTypes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only MP4, MOV, and MKV files are allowed."));
    }
  },
});

// Configure multer for thumbnail uploads
const thumbnailStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, thumbnailsDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `thumb-${uniqueSuffix}${ext}`);
  },
});

const uploadThumbnail = multer({
  storage: thumbnailStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max for thumbnails
  fileFilter: (_req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    const allowedExts = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedTypes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only JPEG, PNG, GIF, and WebP images are allowed."));
    }
  },
});

// Get video duration using ffprobe
async function getVideoDuration(filePath: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    );
    return parseFloat(stdout.trim()) || 0;
  } catch (error) {
    console.error("Error getting video duration:", error);
    return 0;
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // Initialize auth service
  await authService.initialize();

  // Authentication middleware for API routes
  const requireAuth = (req: Request, res: Response, next: any) => {
    const sessionId = req.headers['x-session-id'] as string;

    if (!sessionId || !authService.verifySession(sessionId)) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    next();
  };

  // ============ AUTH ROUTES (No auth required) ============

  // Login
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ message: "Username and password required" });
      }

      const isValid = await authService.verifyCredentials(username, password);

      if (!isValid) {
        return res.status(401).json({ message: "Invalid username or password" });
      }

      const sessionId = authService.createSession();
      res.json({ sessionId, message: "Login successful" });
    } catch (error: any) {
      console.error("Login error:", error);
      res.status(500).json({ message: "Login failed" });
    }
  });

  // Logout
  app.post("/api/auth/logout", (req: Request, res: Response) => {
    const sessionId = req.headers['x-session-id'] as string;
    if (sessionId) {
      authService.deleteSession(sessionId);
    }
    res.json({ message: "Logged out" });
  });

  // Check session
  app.get("/api/auth/check", (req: Request, res: Response) => {
    const sessionId = req.headers['x-session-id'] as string;
    const isValid = sessionId && authService.verifySession(sessionId);
    res.json({ authenticated: isValid });
  });

  // ============ VIDEO ROUTES (Protected) ============

  // Get all videos
  app.get("/api/videos", requireAuth, async (_req: Request, res: Response) => {
    try {
      const videos = await storage.getVideos();
      res.json(videos);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch videos" });
    }
  });

  // ============ CHUNKED UPLOAD ROUTES (Protected) ============

  // Stale session cleanup — runs every 10 min, expires sessions older than 24h
  setInterval(() => {
    storage.cleanupExpiredSessions(Date.now() - 24 * 60 * 60 * 1000);
  }, 10 * 60 * 1000);

  // 1. Init upload session
  app.post("/api/uploads/init", requireAuth, async (req: Request, res: Response) => {
    try {
      const { originalName, mimeType, totalSize } = req.body;
      if (!originalName || !mimeType || typeof totalSize !== "number") {
        return res.status(400).json({ message: "Missing required fields: originalName, mimeType, totalSize" });
      }

      const allowedTypes = ["video/mp4", "video/quicktime", "video/x-matroska"];
      const allowedExts = [".mp4", ".mov", ".mkv"];
      const ext = path.extname(originalName).toLowerCase();
      if (!allowedTypes.includes(mimeType) && !allowedExts.includes(ext)) {
        return res.status(400).json({ message: "Invalid file type. Only MP4, MOV, and MKV files are allowed." });
      }

      const storageInfo = await storage.getStorageInfo();
      if (storageInfo.used + totalSize > MAX_STORAGE_BYTES) {
        return res.status(400).json({ message: "Storage limit exceeded. Delete some videos to free up space." });
      }

      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const filename = `video-${uniqueSuffix}${ext}`;
      const tempPath = path.join(uploadsDir, filename + ".tmp");
      fs.writeFileSync(tempPath, Buffer.alloc(0)); // create empty file

      const session = storage.createUploadSession({ filename, originalName, mimeType, totalSize, bytesReceived: 0, tempPath });
      res.json({ sessionId: session.id, chunkSize: CHUNK_SIZE });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to create upload session" });
    }
  });

  // 2. Upload one chunk (raw binary body)
  app.post(
    "/api/uploads/:sessionId/chunk",
    requireAuth,
    express.raw({ type: "application/octet-stream", limit: "6mb" }),
    async (req: Request, res: Response) => {
      try {
        const session = storage.getUploadSession(req.params.sessionId);
        if (!session) return res.status(404).json({ message: "Upload session not found or expired" });

        const rangeHeader = req.headers["content-range"];
        if (!rangeHeader) return res.status(400).json({ message: "Missing Content-Range header" });

        const m = rangeHeader.match(/bytes (\d+)-(\d+)\/(\d+)/);
        if (!m) return res.status(400).json({ message: "Invalid Content-Range header" });

        const start = parseInt(m[1]);
        if (start !== session.bytesReceived) {
          // Tell client where we actually are so it can resume correctly
          return res.status(409).json({ message: "Chunk out of order", bytesReceived: session.bytesReceived });
        }

        const chunk = req.body as Buffer;
        if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
          return res.status(400).json({ message: "Empty chunk body" });
        }

        fs.appendFileSync(session.tempPath, chunk);
        const newBytes = session.bytesReceived + chunk.length;
        storage.updateUploadSessionBytes(session.id, newBytes);

        res.json({ bytesReceived: newBytes });
      } catch (err: any) {
        res.status(500).json({ message: err.message || "Chunk upload failed" });
      }
    }
  );

  // 3. Get session status (for resume after page reload)
  app.get("/api/uploads/:sessionId", requireAuth, async (req: Request, res: Response) => {
    const session = storage.getUploadSession(req.params.sessionId);
    if (!session) return res.status(404).json({ message: "Session not found" });
    res.json({ sessionId: session.id, originalName: session.originalName, totalSize: session.totalSize, bytesReceived: session.bytesReceived });
  });

  // 4. Complete upload — finalize file, run ffprobe, create video record
  app.post("/api/uploads/:sessionId/complete", requireAuth, async (req: Request, res: Response) => {
    try {
      const session = storage.deleteUploadSession(req.params.sessionId);
      if (!session) return res.status(404).json({ message: "Session not found" });

      if (session.bytesReceived !== session.totalSize) {
        try { fs.unlinkSync(session.tempPath); } catch { /* ignore */ }
        return res.status(400).json({ message: `Upload incomplete: got ${session.bytesReceived} of ${session.totalSize} bytes` });
      }

      const finalPath = path.join(uploadsDir, session.filename);
      fs.renameSync(session.tempPath, finalPath);

      // Final storage check (race condition guard)
      const storageInfo = await storage.getStorageInfo();
      if (storageInfo.used + session.totalSize > MAX_STORAGE_BYTES) {
        try { fs.unlinkSync(finalPath); } catch { /* ignore */ }
        return res.status(400).json({ message: "Storage limit exceeded." });
      }

      const duration = await getVideoDuration(finalPath);
      const video = await storage.addVideo({
        filename: session.filename,
        originalName: session.originalName,
        size: session.totalSize,
        duration,
        mimeType: session.mimeType,
        uploadedAt: new Date().toISOString(),
      });

      res.json(video);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to complete upload" });
    }
  });

  // 5. Cancel upload — delete temp file and session
  app.delete("/api/uploads/:sessionId", requireAuth, async (req: Request, res: Response) => {
    try {
      const session = storage.deleteUploadSession(req.params.sessionId);
      if (session) {
        try { fs.unlinkSync(session.tempPath); } catch { /* already gone */ }
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to cancel upload" });
    }
  });

  // Upload video
  app.post("/api/videos/upload", upload.single("video"), async (req: Request, res: Response) => {
    try {
      // Check authentication
      const sessionId = req.headers['x-session-id'] as string;
      if (!sessionId || !authService.verifySession(sessionId)) {
        // Clean up uploaded file if auth fails
        if (req.file) {
          fs.unlinkSync(req.file.path);
        }
        return res.status(401).json({ message: "Unauthorized" });
      }

      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      // Check video count limit
      const storageInfo = await storage.getStorageInfo();
      if (storageInfo.videoCount >= MAX_VIDEOS) {
        // Delete the uploaded file
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ message: `Maximum ${MAX_VIDEOS} videos allowed. Delete one to upload more.` });
      }

      // Check storage limit
      if (storageInfo.used + req.file.size > MAX_STORAGE_BYTES) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ message: "Storage limit exceeded. Delete some videos to free up space." });
      }

      // Get video duration
      const duration = await getVideoDuration(req.file.path);

      const video = await storage.addVideo({
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        duration,
        mimeType: req.file.mimetype,
        uploadedAt: new Date().toISOString(),
      });

      res.json(video);
    } catch (error: any) {
      console.error("Upload error:", error);
      res.status(500).json({ message: error.message || "Upload failed" });
    }
  });

  // Delete video
  app.delete("/api/videos/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const video = await storage.getVideo(id);

      if (!video) {
        return res.status(404).json({ message: "Video not found" });
      }

      // Check if streaming this video
      const state = await storage.getStreamingState();
      if (state.isStreaming && state.selectedVideoId === id) {
        return res.status(400).json({ message: "Cannot delete video while it's being streamed" });
      }

      // Delete file from disk
      const filePath = path.join(uploadsDir, video.filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      await storage.deleteVideo(id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete video" });
    }
  });

  // Stream video with Range header support (prevents lagging)
  app.get("/api/videos/:id/stream", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const video = await storage.getVideo(id);

      if (!video) {
        return res.status(404).json({ message: "Video not found" });
      }

      const filePath = path.join(uploadsDir, video.filename);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ message: "Video file not found" });
      }

      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        // Parse Range header
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        const stream = fs.createReadStream(filePath, { start, end });

        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunkSize,
          "Content-Type": video.mimeType || "video/mp4",
          "Cache-Control": "no-cache",
        });

        stream.pipe(res);
      } else {
        // No Range header - send entire file with streaming support
        res.writeHead(200, {
          "Content-Length": fileSize,
          "Content-Type": video.mimeType || "video/mp4",
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-cache",
        });

        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
      }
    } catch (error) {
      console.error("Stream error:", error);
      res.status(500).json({ message: "Failed to stream video" });
    }
  });

  // ============ RTMP ENDPOINT ROUTES ============

  // Get all endpoints
  app.get("/api/rtmp-endpoints", requireAuth, async (_req: Request, res: Response) => {
    try {
      const endpoints = await storage.getRtmpEndpoints();
      res.json(endpoints);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch endpoints" });
    }
  });

  // Create endpoint
  app.post("/api/rtmp-endpoints", requireAuth, async (req: Request, res: Response) => {
    try {
      const result = insertRtmpEndpointSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ message: "Invalid endpoint data" });
      }

      const endpoint = await storage.createRtmpEndpoint(result.data);
      res.json(endpoint);
    } catch (error) {
      res.status(500).json({ message: "Failed to create endpoint" });
    }
  });

  // Update endpoint
  app.patch("/api/rtmp-endpoints/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const endpoint = await storage.updateRtmpEndpoint(id, req.body);

      if (!endpoint) {
        return res.status(404).json({ message: "Endpoint not found" });
      }

      res.json(endpoint);
    } catch (error) {
      res.status(500).json({ message: "Failed to update endpoint" });
    }
  });

  // Delete endpoint
  app.delete("/api/rtmp-endpoints/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const success = await storage.deleteRtmpEndpoint(id);

      if (!success) {
        return res.status(404).json({ message: "Endpoint not found" });
      }

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete endpoint" });
    }
  });

  // ============ THUMBNAIL ROUTES ============

  // Serve thumbnail files statically
  app.use("/thumbnails", express.static(thumbnailsDir));

  // Upload thumbnail for an RTMP endpoint
  app.post("/api/rtmp-endpoints/:id/thumbnail", requireAuth, uploadThumbnail.single("thumbnail"), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      if (!req.file) {
        return res.status(400).json({ message: "No image file provided" });
      }

      const endpoint = await storage.getRtmpEndpoint(id);
      if (!endpoint) {
        fs.unlinkSync(req.file.path);
        return res.status(404).json({ message: "Endpoint not found" });
      }

      // Delete old thumbnail if it exists
      if (endpoint.thumbnailPath) {
        const resolvedOld = path.resolve(process.cwd(), endpoint.thumbnailPath.replace(/^\//, ""));
        if (resolvedOld.startsWith(thumbnailsDir + path.sep) && fs.existsSync(resolvedOld)) {
          fs.unlinkSync(resolvedOld);
        }
      }

      const thumbnailPath = `/thumbnails/${req.file.filename}`;
      const updated = await storage.updateRtmpEndpoint(id, { thumbnailPath });
      res.json(updated);
    } catch (error) {
      console.error("Thumbnail upload error:", error);
      res.status(500).json({ message: "Failed to upload thumbnail" });
    }
  });

  // Delete thumbnail for an RTMP endpoint
  app.delete("/api/rtmp-endpoints/:id/thumbnail", requireAuth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const endpoint = await storage.getRtmpEndpoint(id);
      if (!endpoint) {
        return res.status(404).json({ message: "Endpoint not found" });
      }

      if (endpoint.thumbnailPath) {
        const resolvedPath = path.resolve(process.cwd(), endpoint.thumbnailPath.replace(/^\//, ""));
        if (resolvedPath.startsWith(thumbnailsDir + path.sep) && fs.existsSync(resolvedPath)) {
          fs.unlinkSync(resolvedPath);
        }
      }

      const updated = await storage.updateRtmpEndpoint(id, { thumbnailPath: undefined });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to delete thumbnail" });
    }
  });

  // ============ STREAMING ROUTES ============

  // Get streaming state
  app.get("/api/streaming/state", requireAuth, async (_req: Request, res: Response) => {
    try {
      const state = await storage.getStreamingState();
      res.json(state);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch streaming state" });
    }
  });

  // Select video for streaming
  app.post("/api/streaming/select-video", requireAuth, async (req: Request, res: Response) => {
    try {
      const { videoId } = req.body;

      if (!videoId) {
        return res.status(400).json({ message: "Video ID required" });
      }

      const video = await storage.getVideo(videoId);
      if (!video) {
        return res.status(404).json({ message: "Video not found" });
      }

      const state = await storage.getStreamingState();
      if (state.isStreaming) {
        return res.status(400).json({ message: "Cannot change video while streaming" });
      }

      await storage.setStreamingState({ selectedVideoId: videoId });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ message: "Failed to select video" });
    }
  });

  // Start streaming


  app.post("/api/streaming/start", requireAuth, async (req: Request, res: Response) => {
    try {
      const state = await storage.getStreamingState();

      if (state.isStreaming) {
        return res.status(400).json({ message: "Already streaming" });
      }

      if (!state.selectedVideoId) {
        return res.status(400).json({ message: "No video selected" });
      }

      const endpoints = await storage.getRtmpEndpoints();
      const enabledEndpoints = endpoints.filter(e => e.enabled);

      if (enabledEndpoints.length === 0) {
        return res.status(400).json({ message: "No RTMP endpoints configured" });
      }

      const { durationSeconds } = req.body;
      await streamingService.startStreaming(durationSeconds);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Start streaming error:", error);
      res.status(500).json({ message: error.message || "Failed to start streaming" });
    }
  });

  // Stop streaming
  app.post("/api/streaming/stop", requireAuth, async (_req: Request, res: Response) => {
    try {
      await streamingService.stopStreaming();
      res.json({ success: true });
    } catch (error: any) {
      console.error("Stop streaming error:", error);
      res.status(500).json({ message: error.message || "Failed to stop streaming" });
    }
  });

  // Start a single endpoint mid-stream (without disrupting others)
  app.post("/api/streaming/start-endpoint/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      await streamingService.startSingleEndpoint(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Start endpoint error:", error);
      res.status(400).json({ message: error.message || "Failed to start endpoint" });
    }
  });

  // Set extra camera (PiP overlay)
  app.post("/api/streaming/extra-camera", requireAuth, async (req: Request, res: Response) => {
    try {
      const state = await storage.getStreamingState();
      if (state.isStreaming) {
        return res.status(400).json({ message: "Cannot change extra camera while streaming" });
      }
      const { videoId, position, sizePercent, enabled } = req.body;
      if (!videoId) {
        return res.status(400).json({ message: "videoId required" });
      }
      const video = await storage.getVideo(videoId);
      if (!video) {
        return res.status(404).json({ message: "Video not found" });
      }
      const updated = await storage.setExtraCamera({
        videoId,
        position: position ?? "bottom-right",
        sizePercent: typeof sizePercent === "number" ? sizePercent : 25,
        enabled: enabled !== false,
      });
      res.json(updated);
    } catch (error: any) {
      console.error("Set extra camera error:", error);
      res.status(500).json({ message: "Failed to set extra camera" });
    }
  });

  // Clear extra camera
  app.delete("/api/streaming/extra-camera", requireAuth, async (_req: Request, res: Response) => {
    try {
      const updated = await storage.setExtraCamera(null);
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: "Failed to clear extra camera" });
    }
  });

  // ============ SYSTEM INFO ROUTE ============

  app.get("/api/system", requireAuth, async (_req: Request, res: Response) => {
    try {
      const cpus = os.cpus();
      const cpuModel = cpus[0]?.model?.trim() ?? "Unknown";
      const cpuCores = cpus.length;
      const arch = os.arch();

      const totalRam = os.totalmem();
      const freeRam = os.freemem();
      const usedRam = totalRam - freeRam;

      // Disk info via df
      let diskTotal = 0, diskFree = 0, diskAvailable = false;
      try {
        const { stdout } = await execAsync("df -B1 / 2>/dev/null | tail -1");
        const parts = stdout.trim().split(/\s+/);
        diskTotal = parseInt(parts[1]) || 0;
        diskFree = parseInt(parts[3]) || 0;
        diskAvailable = diskTotal > 0;
      } catch { /* disk stats unavailable */ }

      // FFmpeg version
      let ffmpegVersion = "not found";
      let ffmpegAvailable = false;
      try {
        const { stdout } = await execAsync("ffmpeg -version 2>&1 | head -1");
        const match = stdout.match(/ffmpeg version ([^\s]+)/);
        ffmpegVersion = match ? match[1] : "unknown";
        ffmpegAvailable = true;
      } catch { /* FFmpeg not available */ }

      const uploadsInfo = await storage.getStorageInfo();
      const streamingState = await storage.getStreamingState();
      const endpoints = await storage.getRtmpEndpoints();
      const activeStreams = streamingState.endpointStatuses?.filter(s => s.status === "live").length ?? 0;
      const enabledEndpoints = endpoints.filter(e => e.enabled).length;

      // Capacity estimates (libx264 veryfast)
      const coresPerStream1080p = 2;    // conservative: 2 cores per 1080p stream
      const coresPerStream720p = 1;     // 1 core per 720p stream
      const ramPerStream = 512 * 1024 * 1024; // 512 MB per stream
      const bandwidthPer1080p = 6.2;   // Mbps (6000k video + 160k audio)
      const bandwidthPer720p = 3.2;    // Mbps (3000k video + 160k audio)

      const maxByCpu1080p = Math.max(1, Math.floor(cpuCores / coresPerStream1080p));
      const maxByRam1080p = Math.max(1, Math.floor(totalRam / ramPerStream));
      const maxByCpu720p = Math.max(1, Math.floor(cpuCores / coresPerStream720p));
      const maxByRam720p = Math.max(1, Math.floor(totalRam / ramPerStream));

      res.json({
        cpu: { model: cpuModel, cores: cpuCores, arch },
        ram: { total: totalRam, free: freeRam, used: usedRam },
        disk: { total: diskTotal, free: diskFree, used: diskTotal - diskFree, available: diskAvailable },
        uploads: uploadsInfo,
        ffmpeg: { version: ffmpegVersion, available: ffmpegAvailable },
        node: { version: process.version },
        os: { platform: os.platform(), release: os.release(), type: os.type() },
        uptime: { system: os.uptime(), process: process.uptime() },
        streaming: { active: activeStreams, enabled: enabledEndpoints },
        capacity: {
          max1080pByCpu: maxByCpu1080p,
          max1080pByRam: maxByRam1080p,
          max720pByCpu: maxByCpu720p,
          max720pByRam: maxByRam720p,
          recommended1080p: Math.min(maxByCpu1080p, maxByRam1080p),
          recommended720p: Math.min(maxByCpu720p, maxByRam720p),
          bandwidthPer1080pMbps: bandwidthPer1080p,
          bandwidthPer720pMbps: bandwidthPer720p,
        },
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to get system info" });
    }
  });

  // ============ EVENT LOG ROUTES ============

  app.get("/api/logs", requireAuth, async (_req: Request, res: Response) => {
    try {
      const logs = await storage.getLogs();
      res.json(logs);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch logs" });
    }
  });

  app.delete("/api/logs", requireAuth, async (_req: Request, res: Response) => {
    try {
      await storage.clearLogs();
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ message: "Failed to clear logs" });
    }
  });

  // ============ STORAGE ROUTES ============

  // Get storage info
  app.get("/api/storage", requireAuth, async (_req: Request, res: Response) => {
    try {
      const info = await storage.getStorageInfo();
      res.json(info);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch storage info" });
    }
  });

  // ============ EMAIL SETTINGS ROUTES ============

  // Get email settings
  app.get("/api/email-settings", requireAuth, async (_req: Request, res: Response) => {
    try {
      const settings = await storage.getEmailSettings();
      // Return settings without the password for security
      if (settings) {
        const safe = { ...settings, gmailAppPassword: settings.gmailAppPassword ? "****" : "" };
        res.json(safe);
      } else {
        res.json(null);
      }
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch email settings" });
    }
  });

  // Update email settings
  app.post("/api/email-settings", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertEmailSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid email settings" });
      }

      await storage.updateEmailSettings(parsed.data);
      res.json({ message: "Email settings updated" });
    } catch (error: any) {
      console.error("Email settings error:", error);
      res.status(500).json({ message: error.message || "Failed to update email settings" });
    }
  });

  // Test email connection
  app.post("/api/email-settings/test", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertEmailSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid email settings" });
      }

      const success = await emailService.testConnection(parsed.data);
      if (success) {
        res.json({ message: "Gmail connection successful" });
      } else {
        res.status(400).json({ message: "Failed to connect to Gmail. Check your credentials." });
      }
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Email test failed" });
    }
  });

  // ============ THEME SETTINGS ROUTES ============

  // Get theme settings
  app.get("/api/theme-settings", async (_req: Request, res: Response) => {
    try {
      const settings = await storage.getThemeSettings();
      res.json(settings);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch theme settings" });
    }
  });

  // Update theme settings
  app.post("/api/theme-settings", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertThemeSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid theme settings" });
      }

      await storage.updateThemeSettings(parsed.data);
      res.json({ message: "Theme settings updated" });
    } catch (error: any) {
      console.error("Theme settings error:", error);
      res.status(500).json({ message: error.message || "Failed to update theme settings" });
    }
  });

  // ============ TELEGRAM SETTINGS ROUTES ============

  // Get telegram settings
  app.get("/api/telegram-settings", requireAuth, async (_req: Request, res: Response) => {
    try {
      const settings = await storage.getTelegramSettings();
      if (settings) {
        const safe = { ...settings, botToken: settings.botToken ? "****" : "" };
        res.json(safe);
      } else {
        res.json(null);
      }
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch telegram settings" });
    }
  });

  // Update telegram settings
  app.post("/api/telegram-settings", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertTelegramSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid telegram settings" });
      }

      let settingsToSave = parsed.data;
      
      // If token is masked (****), keep the existing token
      if (settingsToSave.botToken === "****" || settingsToSave.botToken.includes("****")) {
        const storedSettings = await storage.getTelegramSettings();
        if (storedSettings && storedSettings.botToken) {
          settingsToSave = { ...settingsToSave, botToken: storedSettings.botToken };
        }
      }

      await storage.updateTelegramSettings(settingsToSave);
      res.json({ message: "Telegram settings updated" });
    } catch (error: any) {
      console.error("Telegram settings error:", error);
      res.status(500).json({ message: error.message || "Failed to update telegram settings" });
    }
  });

  // Test telegram connection
  app.post("/api/telegram-settings/test", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertTelegramSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid telegram settings" });
      }

      let settingsToTest = parsed.data;
      
      // If token is masked (****), use the stored token instead
      if (settingsToTest.botToken === "****" || settingsToTest.botToken.includes("****")) {
        const storedSettings = await storage.getTelegramSettings();
        if (!storedSettings || !storedSettings.botToken) {
          return res.status(400).json({ message: "No saved bot token found. Please enter your bot token." });
        }
        settingsToTest = { ...settingsToTest, botToken: storedSettings.botToken };
      }

      await telegramService.testConnection(settingsToTest);
      res.json({ message: "Telegram connection successful" });
    } catch (error: any) {
      console.error("Telegram test error:", error);
      res.status(500).json({ message: error.message || "Telegram test failed" });
    }
  });

  return httpServer;
}
