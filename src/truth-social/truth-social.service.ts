import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "child_process";
import * as path from "path";
import { TruthSocialPost } from "../common/interfaces";

@Injectable()
export class TruthSocialService {
  private readonly logger = new Logger(TruthSocialService.name);
  private readonly FETCH_SCRIPT = path.resolve(process.cwd(), "fetch-posts.py");

  constructor(private readonly configService: ConfigService) {
    this.logger.log("Fetch script: " + this.FETCH_SCRIPT);
  }

  /** Fetch một post cụ thể theo ID từ Truth Social */
  async getPostById(postId: string): Promise<TruthSocialPost | null> {
    this.logger.debug("Fetching single post: " + postId);
    try {
      const posts = await this.runPythonFetch(null, postId);
      return posts.length > 0 ? posts[0] : null;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error("Truth Social fetchById error: " + errMsg);
      return null;
    }
  }

  async getLatestPosts(sinceId?: string | null): Promise<TruthSocialPost[]> {
    if (sinceId) {
      this.logger.debug("Fetching since " + sinceId);
    } else {
      this.logger.debug("Fetching posts (initial load)");
    }
    try {
      const posts = await this.runPythonFetch(sinceId);
      if (posts.length > 0) {
        this.logger.log("Found " + posts.length + " new posts from Truth Social");
      }
      return posts;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error("Truth Social fetch error: " + errMsg);
      // Re-throw rate-limit errors so PollingService backoff logic can fire
      if (errMsg.includes('HTTP 403') || errMsg.includes('HTTP 429')) {
        throw new Error(errMsg);
      }
      return [];
    }
  }

  private runPythonFetch(sinceId?: string | null, singleId?: string): Promise<TruthSocialPost[]> {
    return new Promise((resolve, reject) => {
      const args = [this.FETCH_SCRIPT];
      if (singleId) {
        args.push('--single', singleId);
      } else if (sinceId) {
        args.push(sinceId);
      }
      const proc = spawn("python3", args, { timeout: 30000, env: { ...process.env } });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (stderr.trim()) this.logger.debug("Python stderr: " + stderr.trim());
        if (code !== 0) {
          reject(new Error("Python exit " + code + ": " + stderr.slice(0, 200)));
          return;
        }
        try {
          const data = JSON.parse(stdout.trim());
          if (data.error) { reject(new Error(data.error)); return; }
          // single mode trả về theo thứ tự đúng, không cần reverse
          const posts = data as TruthSocialPost[];
          resolve(singleId ? posts : posts.reverse());
        } catch {
          reject(new Error("JSON parse error: " + stdout.slice(0, 200)));
        }
      });
      proc.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          this.runPythonFetchWithCmd("python", sinceId, singleId).then(resolve).catch(reject);
        } else {
          reject(err);
        }
      });
    });
  }

  private runPythonFetchWithCmd(cmd: string, sinceId?: string | null, singleId?: string): Promise<TruthSocialPost[]> {
    return new Promise((resolve, reject) => {
      const args = [this.FETCH_SCRIPT];
      if (singleId) {
        args.push('--single', singleId);
      } else if (sinceId) {
        args.push(sinceId);
      }
      const proc = spawn(cmd, args, { timeout: 30000, env: { ...process.env } });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error("Python(" + cmd + ") exit " + code + ": " + stderr.slice(0, 200)));
          return;
        }
        try {
          const data = JSON.parse(stdout.trim());
          if (data.error) { reject(new Error(data.error)); return; }
          resolve((data as TruthSocialPost[]).reverse());
        } catch {
          reject(new Error("JSON parse error: " + stdout.slice(0, 200)));
        }
      });
      proc.on("error", (err) => reject(err));
    });
  }
}
