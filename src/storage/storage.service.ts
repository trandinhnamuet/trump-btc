import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PostRecord, StorageData } from '../common/interfaces';

/**
 * StorageService: Quản lý lưu trữ dữ liệu vào file JSON local.
 * Không cần database - tất cả dữ liệu lưu trong data/posts.json.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);

  // Đường dẫn tới thư mục data và file posts.json
  private readonly dataDir = path.join(process.cwd(), 'data');
  private readonly postsFile = path.join(this.dataDir, 'posts.json');

  // Cache dữ liệu trong memory để tăng performance
  private data: StorageData = { lastPostId: null, posts: [] };

  /** Khởi tạo: tạo thư mục và load dữ liệu khi module khởi động */
  onModuleInit() {
    this.ensureDataDir();
    this.loadData();
  }

  /** Đảm bảo thư mục data/ tồn tại */
  private ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      this.logger.log('Đã tạo thư mục data/');
    }
  }

  /** Load dữ liệu từ file JSON vào memory */
  private loadData() {
    if (fs.existsSync(this.postsFile)) {
      try {
        const raw = fs.readFileSync(this.postsFile, 'utf-8');
        this.data = JSON.parse(raw);
        this.logger.log(
          `Đã tải ${this.data.posts.length} bài viết từ storage (lastPostId: ${this.data.lastPostId})`,
        );
      } catch (err) {
        this.logger.error('Lỗi đọc file posts.json, khởi tạo lại:', err.message);
        this.data = { lastPostId: null, posts: [] };
        this.persistData();
      }
    } else {
      this.persistData();
      this.logger.log('Đã khởi tạo file data/posts.json mới');
    }
  }

  /** Ghi dữ liệu từ memory xuống file JSON */
  private persistData() {
    fs.writeFileSync(this.postsFile, JSON.stringify(this.data, null, 2), 'utf-8');
    this.logger.debug(
      `Persisted storage -> posts=${this.data.posts.length}, lastPostId=${this.data.lastPostId}`,
    );
  }

  /** Lấy ID của bài viết gần nhất đã xử lý */
  getLastPostId(): string | null {
    return this.data.lastPostId;
  }

  /** Cập nhật ID bài viết gần nhất đã xử lý */
  setLastPostId(id: string) {
    this.data.lastPostId = id;
    this.persistData();
  }

  /**
   * Lưu hoặc cập nhật một bài viết vào storage.
   * Nếu bài đã tồn tại (cùng id) thì update, chưa có thì thêm mới.
   */
  savePost(post: PostRecord) {
    const existingIndex = this.data.posts.findIndex((p) => p.id === post.id);
    if (existingIndex >= 0) {
      this.data.posts[existingIndex] = post;
      this.logger.log(`Cập nhật bài viết trong storage: ${post.id}`);
    } else {
      this.data.posts.push(post);
      this.logger.log(`Thêm bài viết mới vào storage: ${post.id}`);
    }
    this.persistData();
  }

  /**
   * Cập nhật một phần thông tin của bài viết (dùng để cập nhật giá BTC sau).
   */
  updatePost(id: string, updates: Partial<PostRecord>) {
    const post = this.data.posts.find((p) => p.id === id);
    if (post) {
      Object.assign(post, updates);
      this.persistData();
      const keys = Object.keys(updates).join(', ');
      this.logger.log(`Updated post ${id} fields: ${keys}`);
    }
  }

  /**
   * Lấy danh sách các bài viết cần kiểm tra giá BTC.
   * Trả về những bài mà thời điểm check đã đến nhưng giá chưa được ghi.
   */
  getPostsPendingPriceCheck(): PostRecord[] {
    const now = new Date();
    const result = this.data.posts.filter((post) => {
      const needs1h = post.checkAt1h && post.btcPriceAt1h == null && new Date(post.checkAt1h) <= now;
      const needs1d = post.checkAt1d && post.btcPriceAt1d == null && new Date(post.checkAt1d) <= now;
      const needs7d = post.checkAt7d && post.btcPriceAt7d == null && new Date(post.checkAt7d) <= now;
      return needs1h || needs1d || needs7d;
    });
    this.logger.debug(`Posts pending price check: ${result.length}`);
    return result;
  }

  /** Lấy tất cả bài viết đã lưu */
  getAllPosts(): PostRecord[] {
    return this.data.posts;
  }
}
