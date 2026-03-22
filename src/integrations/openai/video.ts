/**
 * Video frame extraction (ffmpeg) and GPT-4o-mini vision analysis.
 * Extracted from openai.ts for modular decomposition (Phase 3).
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Temp-file management
// ---------------------------------------------------------------------------

// Dedicated temp directory so crash-leftover files are cleaned on next startup.
const TEMP_DIR = join(homedir(), ".remote-copilot-mcp", "tmp");

/** Remove stale files from TEMP_DIR; create the dir if absent. */
function cleanupTempDir(): void {
    mkdirSync(TEMP_DIR, { recursive: true });
    const STALE_AGE = 5 * 60 * 1000; // 5 minutes — any temp file this old is a crash leftover
    const now = Date.now();
    for (const name of readdirSync(TEMP_DIR)) {
        try {
            const fullPath = join(TEMP_DIR, name);
            const mtime = statSync(fullPath).mtimeMs;
            if (now - mtime > STALE_AGE) {
                unlinkSync(fullPath);
            }
        } catch { /* ignore per-file errors */ }
    }
}

// Track in-flight temp files for cleanup on unexpected exit.
const activeTempFiles = new Set<string>();

function registerTempFile(path: string): void {
    activeTempFiles.add(path);
}

function unregisterTempFile(path: string): void {
    activeTempFiles.delete(path);
    try { unlinkSync(path); } catch { /* ignore */ }
}

// Clean up in-flight temp files on graceful/forced shutdown.
for (const sig of ["exit", "SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
        for (const f of activeTempFiles) {
            try { unlinkSync(f); } catch { /* ignore */ }
        }
    });
}

// Run once when the module loads.
cleanupTempDir();

// ---------------------------------------------------------------------------
// Frame extraction
// ---------------------------------------------------------------------------

/** Maximum number of frames to extract from a video. */
export const MAX_FRAMES = 6;

/**
 * Split a buffer of concatenated JPEG images by SOI marker (0xFFD8).
 */
function splitJpegs(buf: Buffer): Buffer[] {
    const frames: Buffer[] = [];
    let start = 0;
    for (let i = 2; i < buf.length - 1; i++) {
        if (buf[i] === 0xFF && buf[i + 1] === 0xD8) {
            frames.push(buf.subarray(start, i));
            start = i;
        }
    }
    if (start < buf.length) frames.push(buf.subarray(start));
    return frames.filter(f => f.length > 100); // drop tiny garbage
}

/**
 * Extract key frames from a video buffer using ffmpeg.
 * Writes video to a temp file and reads JPEG frames from stdout.
 * @param videoBuffer  Raw video file content (MP4).
 * @param durationSec  Video duration in seconds (used to calculate interval).
 * @returns Array of JPEG-encoded frame buffers.
 */
export function extractVideoFrames(
    videoBuffer: Buffer,
    durationSec: number,
): Promise<Buffer[]> {
    const tempPath = join(TEMP_DIR, `video-${randomUUID()}.mp4`);
    writeFileSync(tempPath, videoBuffer);
    registerTempFile(tempPath);

    return new Promise<Buffer[]>((resolve, reject) => {
        // Calculate frame interval: aim for ~1 frame every 5s, capped at MAX_FRAMES.
        const interval = Math.max(1, Math.ceil(durationSec / MAX_FRAMES));

        const args = [
            "-i", tempPath,
            "-vf", `fps=1/${interval}`,
            "-c:v", "mjpeg",
            "-f", "image2pipe",
            "-q:v", "3",
            "pipe:1",
        ];

        const proc = spawn("ffmpeg", args, {
            stdio: ["ignore", "pipe", "pipe"],
        });

        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];

        proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        proc.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));

        // Kill ffmpeg if it hangs for more than 30 seconds.
        const killTimer = setTimeout(() => proc.kill("SIGKILL"), 30_000);

        proc.on("error", (err) => {
            clearTimeout(killTimer);
            reject(new Error(`ffmpeg not found or failed to start: ${err.message}`));
        });

        proc.on("close", (code) => {
            clearTimeout(killTimer);
            if (code !== 0) {
                const stderr = Buffer.concat(errChunks).toString("utf8").slice(-500);
                reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
                return;
            }
            const combined = Buffer.concat(chunks);
            if (combined.length === 0) {
                resolve([]);
                return;
            }
            const frames = splitJpegs(combined).slice(0, MAX_FRAMES);
            resolve(frames);
        });
    }).finally(() => {
        unregisterTempFile(tempPath);
    });
}


