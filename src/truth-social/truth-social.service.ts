import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { TruthSocialPost } from '../common/interfaces';
import { TruthSocialAuthService } from './truth-social-auth.service';

/**
 * TruthSocialService: Lấy bài viết của Trump từ Truth Social.
 *
 * Truth Social dùng Mastodon-compatible API, nên ta có thể dùng endpoint:
 * GET https://truthsocial.com/api/v1/accounts/{id}/statuses
 *
 * Trump's account ID: 107780257626128497
 */
@Injectable()
export class TruthSocialService {
  private readonly logger = new Logger(TruthSocialService.name);

  private readonly TRUMP_ACCOUNT_ID = '107780257626128497';
  private readonly BASE_URL = 'https://truthsocial.com/api/v1';

  // Cache access token để không phải login mỗi lần
  private accessToken: string | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: TruthSocialAuthService,
  ) {
    this.initializeToken();
  }

  /**
   * Khởi tạo token khi module load.
   * Ưu tiên: TRUTH_SOCIAL_ACCESS_TOKEN từ .env > Puppeteer auto-login
   */
  private initializeToken() {
    const envToken = this.configService.get<string>('TRUTH_SOCIAL_ACCESS_TOKEN');
    if (envToken) {
      this.accessToken = envToken;
      this.logger.log('✓ Sử dụng TRUTH_SOCIAL_ACCESS_TOKEN từ .env');
      return;
    }

    const username = this.configService.get<string>('TRUTHSOCIAL_USERNAME');
    const password = this.configService.get<string>('TRUTHSOCIAL_PASSWORD');
    if (username && password) {
      this.logger.log('ℹ️  TRUTH_SOCIAL_ACCESS_TOKEN không tìm thấy. Sẽ dùng Puppeteer để auto-login khi cần.');
      return;
    }

    this.logger.error(
      '❌ Không có token và credentials. Cấu hình một trong hai:\n' +
      '   1. TRUTH_SOCIAL_ACCESS_TOKEN (token hợp lệ từ DevTools)\n' +
      '   2. TRUTHSOCIAL_USERNAME + TRUTHSOCIAL_PASSWORD (sẽ auto-login bằng Puppeteer)'
    );
  }

  /**
   * Lấy các bài viết mới nhất của Trump.
   *
   * @param sinceId - Nếu có, chỉ lấy bài viết có ID lớn hơn (mới hơn) sinceId.
   *                  Điều này giúp lấy TẤT CẢ bài mới từ lần check cuối.
   * @returns Mảng bài viết, sắp xếp từ CŨ đến MỚI (để xử lý tuần tự đúng thứ tự)
   */
  async getLatestPosts(sinceId?: string | null): Promise<TruthSocialPost[]> {
    try {
      const params: Record<string, string | number> = { limit: 40 };

      // since_id: Chỉ lấy bài có ID lớn hơn giá trị này (bài mới hơn)
      if (sinceId) {
        params.since_id = sinceId;
      }

      this.logger.debug(
        `Đang lấy bài viết từ Truth Social${sinceId ? ` (since_id: ${sinceId})` : ' (lần đầu)'}`,
      );

      const posts = await this.fetchPosts(params);
      if (posts.length > 0) {
        this.logger.log(`Tìm thấy ${posts.length} bài viết mới từ Truth Social`);
      } else {
        this.logger.log('Không có bài viết mới');
      }
      return posts;
    } catch (error) {
      this.logger.error(`❌ Lỗi getLatestPosts: ${error.message}`);
      return [];
    }
  }

  /**
   * Fetch posts từ API. Nếu token 403, thử refresh token.
   */
  private async fetchPosts(params: Record<string, string | number>): Promise<TruthSocialPost[]> {
    try {
      const headers = this.buildHeaders();

      const response = await axios.get(
        `${this.BASE_URL}/accounts/${this.TRUMP_ACCOUNT_ID}/statuses`,
        {
          params,
          headers,
          timeout: 15000,
        },
      );

      // Parse response
      return (response.data as any[])
        .map((post) => ({
          id: post.id as string,
          content: this.stripHtml(post.content as string),
          createdAt: post.created_at as string,
          url: (post.url as string) || `https://truthsocial.com/@realDonaldTrump/${post.id}`,
        }))
        .reverse();
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;

        // Token hết hạn - thử refresh
        if (status === 401 || status === 403) {
          this.logger.warn(`⚠️  API trả về ${status}. Token hết hạn. Thử refresh...`);
          const newToken = await this.authService.getAccessToken();

          if (newToken) {
            this.accessToken = newToken;
            this.logger.log('✓ Lấy token mới thành công. Thử lại...');
            
            // Retry request sau khi refresh token
            const retryHeaders = this.buildHeaders();
            const response = await axios.get(
              `${this.BASE_URL}/accounts/${this.TRUMP_ACCOUNT_ID}/statuses`,
              {
                params,
                headers: retryHeaders,
                timeout: 15000,
              },
            );

            return (response.data as any[])
              .map((post) => ({
                id: post.id as string,
                content: this.stripHtml(post.content as string),
                createdAt: post.created_at as string,
                url: (post.url as string) || `https://truthsocial.com/@realDonaldTrump/${post.id}`,
              }))
              .reverse();
          } else {
            this.logger.error(
              '❌ Không thể lấy token mới. Kiểm tra TRUTHSOCIAL_USERNAME/PASSWORD hoặc TRUTH_SOCIAL_ACCESS_TOKEN trong .env'
            );
          }
        } else if (status === 400) {
          this.logger.error(`❌ Lỗi request (400): ${error.response?.data?.error || error.message}`);
        } else if (status === 429) {
          this.logger.warn('⏳ Truth Social rate limit. Sẽ thử lại sau...');
        } else {
          this.logger.error(`❌ Lỗi API Truth Social (${status}): ${error.message}`);
        }
      } else {
        this.logger.error('❌ Lỗi kết nối Truth Social:', error.message);
      }

      return [];
    }
  }

  /**
   * Xây dựng headers cho request.
   * Sử dụng cached access token hoặc token từ .env.
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      // Giả lập browser để tránh bị block
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    };

    const token = this.accessToken;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return headers;
  }

  /**
   * Xóa HTML tags và decode HTML entities.
   * Truth Social trả về nội dung dạng HTML.
   */
  private stripHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n') // Chuyển <br> thành xuống dòng
      .replace(/<[^>]+>/g, '') // Xóa tất cả HTML tags
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n') // Gộp nhiều dòng trống thành 2
      .trim();
  }
}
