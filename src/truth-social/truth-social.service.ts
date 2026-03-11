import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import * as path from 'path';
import { TruthSocialPost } from '../common/interfaces';

/**
 * TruthSocialService: L?y bài vi?t c?a Trump t? Truth Social.
 *
 * S? d?ng Python + curl_cffi d? bypass Cloudflare (impersonate Chrome).
 * Script fetch-posts.py n?m cùng thu m?c g?c project.
 */
@Injectable()
export class TruthSocialService {
  private readonly logger = new Logger(TruthSocialService.name);

  // Ðu?ng d?n tuy?t d?i d?n Python script
  private readonly FETCH_SCRIPT = path.join(process.cwd(), 'fetch-posts.py');

  constructor() {
    this.logger.log('? TruthSocialService kh?i d?ng (curl_cffi mode)');
  }

  /**
   * L?y các bài vi?t m?i nh?t c?a Trump.
   * @param sinceId - N?u có, ch? l?y bài vi?t m?i hon sinceId.
   * @returns M?ng bài vi?t t? CU d?n M?I
   */
  async getLatestPosts(sinceId?: string | null): Promise<TruthSocialPost[]> {
    this.logger.debug(
      `Ðang l?y bài vi?t t? Truth Social${sinceId ? ` (since_id: ${sinceId})` : ' (l?n d?u)'}`,
    );

    try {
      const args = sinceId ? [this.FETCH_SCRIPT, sinceId] : [this.FETCH_SCRIPT];
      const output = await this.runPython(args);

      const data = JSON.parse(output);

      // N?u Python tr? v? l?i
      if (data?.error) {
        this.logger.error(`? fetch-posts.py l?i: ${data.error}`);
        return [];
      }

      const posts = (data as any[]).map((post) => ({
        id: post.id as string,
        content: post.content as string,
        createdAt: post.createdAt as string,
        url: post.url as string,
      })).reverse(); // CU ? M?I

      if (posts.length > 0) {
        this.logger.log(`? Tìm th?y ${posts.length} bài vi?t m?i`);
      }
      return posts;
    } catch (error) {
      this.logger.error(`? L?i khi ch?y fetch-posts.py: ${error.message}`);
      return [];
    }
  }

  /**
   * Ch?y Python script và tr? v? stdout.
   */
  private runPython(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const python = spawn('python3', args, {
        timeout: 30000,
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      python.stdout.on('data', (data) => { stdout += data.toString(); });
      python.stderr.on('data', (data) => {
        stderr += data.toString();
        this.logger.debug(data.toString().trim());
      });

      python.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr.trim() || `Python exit code ${code}`));
        }
      });

      python.on('error', (err) => {
        reject(new Error(`Không tìm du?c python3: ${err.message}`));
      });
    });
  }
}
