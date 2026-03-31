import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { telegramService } from "./telegram";
import { emailService } from "./email";
import { storage } from "./storage";

const app = express();
const httpServer = createServer(app);

async function sendCrashNotification(errorType: string, errorMessage: string): Promise<void> {
  try {
    await telegramService.notifyServerCrash(errorType, errorMessage);
    
    const emailSettings = await storage.getEmailSettings();
    if (emailSettings) {
      await emailService.sendCrashAlert(emailSettings, errorType, errorMessage);
    }
  } catch (notifyError) {
    console.error("Failed to send crash notification:", notifyError);
  }
}

process.on("uncaughtException", async (error) => {
  console.error("UNCAUGHT EXCEPTION:", error);
  await sendCrashNotification("Uncaught Exception", error.stack || error.message);
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  const errorMessage = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error("UNHANDLED REJECTION:", errorMessage);
  await sendCrashNotification("Unhandled Promise Rejection", errorMessage);
  process.exit(1);
});

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    limit: '100mb', // Increase JSON payload limit
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: '100mb' }));

// Configure server timeouts for large file uploads (2 hours for slow connections)
httpServer.timeout = 7200000; // 2 hours in milliseconds
httpServer.headersTimeout = 7200000; // 2 hours
httpServer.requestTimeout = 7200000; // 2 hours

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    if (!res.headersSent) {
      res.status(status).json({ message });
    }
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
    },
    async () => {
      log(`serving on port ${port}`);
      await telegramService.notifyServerStart();
    },
  );
})();
