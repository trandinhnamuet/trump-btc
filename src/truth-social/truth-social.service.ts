import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { TruthSocialPost } from '../common/interfaces';

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

  // Account ID của Trump trên Truth Social
  private readonly TRUMP_ACCOUNT_ID = '107780257626128497';
  private readonly BASE_URL = 'https://truthsocial.com/api/v1';
  private readonly OAUTH_URL = 'https://truthsocial.com/oauth/token';

  // Cache access token để không phải login mỗi lần
  private accessToken: string | null = null;

  constructor(private readonly configService: ConfigService) {
    this.initializeToken();
  }

  /**
   * Khởi tạo token khi module load:
   * 1. Đầu tiên kiểm tra .env có TRUTH_SOCIAL_ACCESS_TOKEN không
   * 2. Nếu không, thử login với username/password để lấy token tự động
   */
  private initializeToken() {
    const envToken = this.configService.get<string>('TRUTH_SOCIAL_ACCESS_TOKEN');
    if (envToken) {
      this.accessToken = envToken;
      this.logger.log('Sử dụng TRUTH_SOCIAL_ACCESS_TOKEN từ .env');
      return;
    }

    const username = this.configService.get<string>('TRUTHSOCIAL_USERNAME');
    const password = this.configService.get<string>('TRUTHSOCIAL_PASSWORD');
    if (username && password) {
      this.logger.log('TRUTH_SOCIAL_ACCESS_TOKEN không tìm thấy. Sẽ tự động login bằng username/password lần đầu cần dùng API');
    } else {
      this.logger.warn('Không tìm thấy token hoặc credentials. Sẽ không thể lấy bài viết từ Truth Social nếu yêu cầu xác thực');
    }
  }

  /**
   * Lấy access token bằng username/password (OAuth client credentials).
   * Gọi phương thức này nếu token bị lỗi hoặc chưa có.
   */
  private async loginAndGetToken(): Promise<string | null> {
    const username = this.configService.get<string>('TRUTHSOCIAL_USERNAME');
    const password = this.configService.get<string>('TRUTHSOCIAL_PASSWORD');

    if (!username || !password) {
      this.logger.error('Không tìm thấy TRUTHSOCIAL_USERNAME hoặc TRUTHSOCIAL_PASSWORD trong .env');
      return null;
    }

    try {
      this.logger.log('Đang đăng nhập vào Truth Social để lấy access token...');

      const response = await axios.post(
        this.OAUTH_URL,
        {
          client_id: 'Trump-Analyzer-Client',
          client_secret: 'do-not-use-in-production',
          grant_type: 'password',
          username,
          password,
          scope: 'read',
        },
        {
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        },
      );

      const token = response.data?.access_token as string | undefined;
      if (!token) {
        this.logger.error('OAuth response không chứa access_token');
        return null;
      }

      this.accessToken = token;
      this.logger.log('Đã lấy access token thành công từ Truth Social');
      return token;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error(
          `Lỗi đăng nhập Truth Social (${error.response?.status}): ${error.response?.data?.error || error.message}`,
        );
      } else {
        this.logger.error('Lỗi đăng nhập Truth Social:', error.message);
      }
      return null;
    }
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

      const headers = this.buildHeaders();

      this.logger.debug(
        `Đang lấy bài viết từ Truth Social${sinceId ? ` (since_id: ${sinceId})` : ' (lần đầu)'}`,
      );

      const response = await axios.get(
        `${this.BASE_URL}/accounts/${this.TRUMP_ACCOUNT_ID}/statuses`,
        {
          params,
          headers,
          timeout: 15000,
        },
      );

      // API trả về mảng bài viết mới nhất trước (descending)
      // Ta đảo ngược để xử lý từ bài cũ nhất (đảm bảo thứ tự đúng)
      const posts: TruthSocialPost[] = (response.data as any[])
        .map((post) => ({
          id: post.id as string,
          content: this.stripHtml(post.content as string),
          createdAt: post.created_at as string,
          url: (post.url as string) || `https://truthsocial.com/@realDonaldTrump/${post.id}`,
        }))
        .reverse(); // Đảo ngược: xử lý bài cũ nhất trước

      this.logger.log(`Tìm thấy ${posts.length} bài viết mới từ Truth Social`);
      return posts;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 401 || status === 403 || status === 400) {
          this.logger.warn(`API trả về ${status}, cố gắng lấy token mới...`);
          const newToken = await this.loginAndGetToken();
          if (newToken) {
            this.logger.log('Sẽ thử lại request với token mới cho lần poll tiếp theo');
          } else {
            this.logger.error(
              'Không thể tự động lấy token. Vui lòng kiểm tra TRUTHSOCIAL_USERNAME/PASSWORD trong .env, hoặc thêm TRUTH_SOCIAL_ACCESS_TOKEN vào .env',
            );
          }
        } else if (status === 429) {
          this.logger.warn('Truth Social rate limit. Sẽ thử lại sau 30 giây...');
        } else {
          this.logger.error(`Lỗi API Truth Social (${status}): ${error.message}`);
        }
      } else {
        this.logger.error('Lỗi kết nối Truth Social:', error.message);
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
