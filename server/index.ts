import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import os from "os";
import { WebSocketServer, WebSocket } from "ws";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { spawn, ChildProcess } from "child_process";
import { ELECTRON_COMMANDS } from "../common/electron-commands";

const getPlatform = (): "linux" | "mac" | "win" => {
  switch (os.platform()) {
    case "darwin":
      return "mac";
    case "win32":
      return "win";
    default:
      return "linux";
  }
};

const APP_ROOT = path.resolve(__dirname, "../..");
const BIN_PATH =
  process.env.UPSCAYL_BIN_PATH ||
  path.join(APP_ROOT, "resources", getPlatform(), "bin", "upscayl-bin");
const MODELS_PATH =
  process.env.UPSCAYL_MODELS_PATH ||
  path.join(APP_ROOT, "resources", "models");
const TEMP_DIR =
  process.env.UPSCAYL_TEMP_DIR || path.join(os.tmpdir(), "upscayl-web");
const STATIC_DIR = path.join(APP_ROOT, "renderer", "out");

fs.mkdirSync(TEMP_DIR, { recursive: true });

interface Job {
  jobId: string;
  inputPath: string;
  outputDir: string;
  status: "pending" | "running" | "done" | "error";
  outputPath?: string;
}

const jobs = new Map<string, Job>();
let currentProcess: ChildProcess | null = null;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set<WebSocket>();

app.use(express.json());
app.use(express.static(STATIC_DIR));

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
});

function broadcast(command: string, data: any) {
  const msg = JSON.stringify({ command, data });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// Multer: each upload gets its own job directory
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const jobId = uuidv4();
    const jobDir = path.join(TEMP_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    (req as any).jobId = jobId;
    (req as any).jobDir = jobDir;
    cb(null, jobDir);
  },
  filename: (_req, file, cb) => cb(null, file.originalname),
});

const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// POST /api/upload
app.post("/api/upload", upload.single("image"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file provided" });
    return;
  }
  const jobId: string = (req as any).jobId;
  const jobDir: string = (req as any).jobDir;

  jobs.set(jobId, {
    jobId,
    inputPath: req.file.path,
    outputDir: jobDir,
    status: "pending",
  });

  res.json({
    jobId,
    inputPath: `/api/files/${jobId}/input`,
  });
});

// Resolve a virtual /api/files/{jobId}/... path to the real filesystem path
function resolveVirtualPath(virtualPath: string): string {
  const inputMatch = virtualPath.match(/^\/api\/files\/([^/]+)\/input$/);
  if (inputMatch) {
    const job = jobs.get(inputMatch[1]);
    if (job) return job.inputPath;
  }

  const dirMatch = virtualPath.match(/^\/api\/files\/([^/]+)$/);
  if (dirMatch) {
    const job = jobs.get(dirMatch[1]);
    if (job) return job.outputDir;
  }

  return virtualPath;
}

function extractJobId(virtualPath: string): string | null {
  const m = virtualPath.match(/^\/api\/files\/([^/]+)/);
  return m ? m[1] : null;
}

function buildArgs(params: {
  inputFile: string;
  outFile: string;
  modelsPath: string;
  model: string;
  scale: string;
  gpuId: string;
  saveImageAs: string;
  customWidth: string;
  compression: string;
  tileSize: number;
  ttaMode: boolean;
}): string[] {
  const {
    inputFile,
    outFile,
    modelsPath,
    model,
    scale,
    gpuId,
    saveImageAs,
    customWidth,
    compression,
    tileSize,
    ttaMode,
  } = params;

  const modelScale = model.includes("-2x")
    ? "2"
    : model.includes("-3x")
      ? "3"
      : "4";
  const includeScale = modelScale !== scale && !customWidth;

  return [
    "-i",
    inputFile,
    "-o",
    outFile,
    ...(includeScale ? ["-s", scale] : []),
    "-m",
    modelsPath,
    "-n",
    model,
    ...(gpuId ? ["-g", gpuId] : []),
    "-f",
    saveImageAs,
    ...(customWidth ? ["-w", customWidth] : []),
    "-c",
    compression,
    ...(tileSize ? ["-t", String(tileSize)] : []),
    ...(ttaMode ? ["-x"] : []),
  ];
}

function spawnBin(
  args: string[],
  onProgress: (data: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(BIN_PATH, args);
    currentProcess = proc;

    proc.stderr.on("data", (chunk: Buffer) => {
      onProgress(chunk.toString());
    });

    proc.on("error", (err) => {
      currentProcess = null;
      reject(err);
    });

    proc.on("close", (code) => {
      currentProcess = null;
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`upscayl-bin exited with code ${code}`));
      }
    });
  });
}

// POST /api/upscayl
app.post("/api/upscayl", async (req, res) => {
  const { command, payload } = req.body as {
    command: string;
    payload: Record<string, any>;
  };

  const imagePath: string = resolveVirtualPath(payload.imagePath || "");
  const outputDir: string =
    resolveVirtualPath(payload.outputPath || "") || path.dirname(imagePath);
  const jobId = extractJobId(payload.imagePath || "") || uuidv4();

  const model: string = payload.model || "upscayl-standard-4x";
  const scale: string = String(payload.scale || "4");
  const gpuId: string = payload.gpuId || "";
  const saveImageAs: string = payload.saveImageAs || "png";
  const customWidth: string = payload.useCustomWidth
    ? String(payload.customWidth || "")
    : "";
  const compression: string = String(payload.compression || "0");
  const tileSize: number = Number(payload.tileSize || 0);
  const ttaMode: boolean = Boolean(payload.ttaMode);
  const isDefaultModel = fs.existsSync(path.join(MODELS_PATH, `${model}.bin`));
  const modelsPath: string = isDefaultModel
    ? MODELS_PATH
    : payload.customModelsPath || MODELS_PATH;

  const job = jobs.get(jobId);
  if (job) job.status = "running";

  res.json({ jobId, status: "started" });

  const fileBase = path.parse(path.basename(imagePath)).name;
  const suffix = customWidth ? `${customWidth}px` : `${scale}x`;

  if (command === ELECTRON_COMMANDS.DOUBLE_UPSCAYL) {
    // Two sequential passes
    const pass1Out = path.join(
      outputDir,
      `${fileBase}_upscayl_${suffix}_${model}.${saveImageAs}`,
    );
    const pass2Out = path.join(
      outputDir,
      `${fileBase}_upscayl_${suffix}x2_${model}.${saveImageAs}`,
    );

    try {
      await spawnBin(
        buildArgs({
          inputFile: imagePath,
          outFile: pass1Out,
          modelsPath,
          model,
          scale,
          gpuId,
          saveImageAs,
          customWidth,
          compression,
          tileSize,
          ttaMode,
        }),
        (data) => {
          broadcast(ELECTRON_COMMANDS.DOUBLE_UPSCAYL_PROGRESS, data);
          if (data.includes("Error") || data.includes("failed")) {
            broadcast(ELECTRON_COMMANDS.UPSCAYL_ERROR, data);
          } else if (data.includes("Resizing")) {
            broadcast(ELECTRON_COMMANDS.SCALING_AND_CONVERTING, "");
          }
        },
      );

      await spawnBin(
        buildArgs({
          inputFile: pass1Out,
          outFile: pass2Out,
          modelsPath,
          model,
          scale,
          gpuId,
          saveImageAs,
          customWidth,
          compression,
          tileSize,
          ttaMode,
        }),
        (data) => {
          broadcast(ELECTRON_COMMANDS.DOUBLE_UPSCAYL_PROGRESS, data);
          if (data.includes("Error") || data.includes("failed")) {
            broadcast(ELECTRON_COMMANDS.UPSCAYL_ERROR, data);
          } else if (data.includes("Resizing")) {
            broadcast(ELECTRON_COMMANDS.SCALING_AND_CONVERTING, "");
          }
        },
      );

      if (job) {
        job.outputPath = pass2Out;
        job.status = "done";
      }
      broadcast(
        ELECTRON_COMMANDS.DOUBLE_UPSCAYL_DONE,
        `/api/files/${jobId}/output`,
      );
    } catch (err: any) {
      if (job) job.status = "error";
      broadcast(ELECTRON_COMMANDS.UPSCAYL_ERROR, String(err.message));
    }

    return;
  }

  // Single image upscayl (default)
  const outFile = path.join(
    outputDir,
    `${fileBase}_upscayl_${suffix}_${model}.${saveImageAs}`,
  );

  if (fs.existsSync(outFile) && !payload.overwrite) {
    if (job) {
      job.outputPath = outFile;
      job.status = "done";
    }
    broadcast(ELECTRON_COMMANDS.UPSCAYL_DONE, `/api/files/${jobId}/output`);
    return;
  }

  let failed = false;

  try {
    await spawnBin(
      buildArgs({
        inputFile: imagePath,
        outFile,
        modelsPath,
        model,
        scale,
        gpuId,
        saveImageAs,
        customWidth,
        compression,
        tileSize,
        ttaMode,
      }),
      (data) => {
        broadcast(ELECTRON_COMMANDS.UPSCAYL_PROGRESS, data);
        if (data.includes("Error") || data.includes("failed")) {
          failed = true;
          broadcast(ELECTRON_COMMANDS.UPSCAYL_ERROR, data);
        } else if (data.includes("Resizing")) {
          broadcast(ELECTRON_COMMANDS.SCALING_AND_CONVERTING, "");
        }
      },
    );
  } catch (err: any) {
    failed = true;
    broadcast(ELECTRON_COMMANDS.UPSCAYL_ERROR, String(err.message));
  }

  if (!failed) {
    if (job) {
      job.outputPath = outFile;
      job.status = "done";
    }
    broadcast(ELECTRON_COMMANDS.UPSCAYL_DONE, `/api/files/${jobId}/output`);
  } else if (job) {
    job.status = "error";
  }
});

// POST /api/stop
app.post("/api/stop", (_req, res) => {
  if (currentProcess) {
    currentProcess.kill();
    currentProcess = null;
    broadcast(ELECTRON_COMMANDS.UPSCAYL_PROGRESS, "Stopped");
  }
  res.json({ ok: true });
});

// GET /api/files/:jobId/input
app.get("/api/files/:jobId/input", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !fs.existsSync(job.inputPath)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.sendFile(job.inputPath);
});

// GET /api/files/:jobId/output
app.get("/api/files/:jobId/output", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job?.outputPath || !fs.existsSync(job.outputPath)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.sendFile(job.outputPath);
});

// GET /api/models
app.get("/api/models", (_req, res) => {
  try {
    const models = fs
      .readdirSync(MODELS_PATH)
      .filter((f) => f.endsWith(".param"))
      .map((f) => f.replace(".param", ""));
    res.json(models);
  } catch {
    res.json([]);
  }
});

// GET /api/system-info
app.get("/api/system-info", (_req, res) => {
  res.json({
    platform: getPlatform(),
    release: os.release(),
    arch: os.arch(),
    model: os.cpus()[0]?.model?.trim() ?? "Unknown",
    cpuCount: os.cpus().length,
  });
});

// SPA fallback
app.get("*", (_req, res) => {
  res.sendFile(path.join(STATIC_DIR, "index.html"));
});

const PORT = parseInt(process.env.PORT ?? "3000", 10);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Upscayl web running on http://0.0.0.0:${PORT}`);
  console.log(`  Binary : ${BIN_PATH}`);
  console.log(`  Models : ${MODELS_PATH}`);
  console.log(`  Static : ${STATIC_DIR}`);
});
