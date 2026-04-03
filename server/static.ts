import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  // When running the compiled bundle (dist/index.cjs), __dirname === dist/
  // so dist/public is correct. When running via tsx from source,
  // __dirname === server/, so we fall back to ../dist/public.
  let distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    distPath = path.resolve(__dirname, "..", "dist", "public");
  }

  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}\n` +
      `Run 'npm run build' first to build the client.`,
    );
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
