import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import puppeteer, { Browser, Page } from 'puppeteer';

/**
 * TruthSocialAuthService: Lấy access token từ Truth Social bằng Puppeteer.
 * 
 * Giải pháp này:
 * 1. Dùng headless browser để bypass Cloudflare JS challenge
 * 2. Login tự động với username/password
 * 3. Lấy token từ localStorage/cookies
 * 4. Cache token và tự động refresh khi hết hạn
 */
@Injectable()
export class TruthSocialAuthService {
  private readonly logger = new Logger(TruthSocialAuthService.name);
  private browser: Browser | null = null;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  // Cache token trong 23h (tokens thường tồn tại 24h)
  private readonly TOKEN_CACHE_DURATION = 23 * 60 * 60 * 1000; // ms

  constructor(private readonly configService: ConfigService) {}

  /**
   * Lấy token hợp lệ (cache hoặc fresh).
   * Nếu token hết hạn, tự động login lại.
   */
  async getAccessToken(): Promise<string | null> {
    // Nếu có token cache và chưa hết hạn
    if (this.accessToken && this.tokenExpiresAt > Date.now()) {
      this.logger.debug('✓ Sử dụng token đã cache');
      return this.accessToken;
    }

    this.logger.log('🔐 Token hết hạn hoặc chưa có. Đang login...');
    return await this.loginAndGetToken();
  }

  /**
   * Login vào Truth Social bằng Puppeteer và lấy token.
   */
  private async loginAndGetToken(): Promise<string | null> {
    const username = this.configService.get<string>('TRUTHSOCIAL_USERNAME');
    const password = this.configService.get<string>('TRUTHSOCIAL_PASSWORD');

    if (!username || !password) {
      this.logger.error('❌ Không tìm thấy TRUTHSOCIAL_USERNAME hoặc TRUTHSOCIAL_PASSWORD trong .env');
      return null;
    }

    let page: Page | null = null;

    try {
      // Khởi động browser nếu chưa có
      if (!this.browser) {
        this.logger.log('🚀 Khởi động Puppeteer browser...');
        this.browser = await puppeteer.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Tiết kiệm RAM
          ],
        });
        this.logger.log('✓ Browser ready');
      }

      page = await this.browser.newPage();
      
      // Set viewport để tránh mobile redirect
      await page.setViewport({ width: 1366, height: 768 });

      // Set user agent
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      this.logger.log('📱 Truy cập Truth Social...');
      await page.goto('https://truthsocial.com/auth/sign_in', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });

      // Wait for JS to render (Cloudflare challenge)
      this.logger.log('⏳ Chờ page render...');
      await page.waitForSelector('input[type="email"], input[type="text"], input[name="username"]', {
        timeout: 15000,
      }).catch(() => {
        this.logger.warn('⚠️  Input không tìm được ngay, tiếp tục...');
      });

      // Điền username
      this.logger.log('📝 Nhập username...');
      const emailInput = await page.$('input[type="email"]') || await page.$('input[name="username"]') || await page.$('input[type="text"]');
      if (emailInput) {
        await emailInput.type(username, { delay: 50 });
      } else {
        this.logger.warn('⚠️  Không tìm được email input');
      }

      // Điền password
      this.logger.log('🔑 Nhập password...');
      const passwordInput = await page.$('input[type="password"]');
      if (passwordInput) {
        await passwordInput.type(password, { delay: 50 });
      } else {
        this.logger.warn('⚠️  Không tìm được password input');
      }

      // Click login button
      this.logger.log('🔓 Click login...');
      const submitBtn = await page.$('button[type="submit"]');
      if (submitBtn) {
        await submitBtn.click();
      } else {
        this.logger.warn('⚠️  Không tìm được submit button');
      }

      // Chờ redirect sau login
      try {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
      } catch (e) {
        this.logger.debug('ℹ️  Navigation timeout (có thể đã logged in)');
      }

      // Chờ page xử lý
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Kiểm tra OTP screen
      const otpInput = await page.$('input[inputmode="numeric"]');
      if (otpInput) {
        this.logger.warn('⚠️  OTP được yêu cầu. Vui lòng nhập OTP trong terminal:');
        const otp = await this.promptOtp();
        if (otp) {
          await page.type('input[inputmode="numeric"]', otp, { delay: 100 });
          await page.click('button[type="submit"]');
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      // Lấy token từ localStorage
      const token = await page.evaluate(() => {
        try {
          // Thử lấy từ localStorage (Mastodon/Truth Social format)
          const auth = localStorage.getItem('auth');
          if (auth) {
            const parsed = JSON.parse(auth);
            return parsed?.access_token || null;
          }

          // Thử format khác
          const token = localStorage.getItem('access_token');
          if (token) return token;

          // Thử sessionStorage
          const sessionToken = sessionStorage.getItem('access_token');
          if (sessionToken) return sessionToken;

          return null;
        } catch (e) {
          return null;
        }
      });

      if (token) {
        this.logger.log('✅ Lấy token thành công!');
        this.accessToken = token;
        this.tokenExpiresAt = Date.now() + this.TOKEN_CACHE_DURATION;
        return token;
      }

      // Nếu không tìm được trong localStorage, thử lấy từ network interceptor
      this.logger.log('🔍 Token không trong localStorage, kiểm tra API response...');
      
      // Refresh page và giám sát network requests
      await page.reload({ waitUntil: 'networkidle2' });
      
      const networkToken = await this.extractTokenFromNetwork(page);
      if (networkToken) {
        this.logger.log('✅ Lấy token từ network!');
        this.accessToken = networkToken;
        this.tokenExpiresAt = Date.now() + this.TOKEN_CACHE_DURATION;
        return networkToken;
      }

      this.logger.error('❌ Không tìm được token sau khi login');
      return null;
    } catch (error) {
      this.logger.error(`❌ Lỗi Puppeteer: ${error.message}`);
      return null;
    } finally {
      if (page) {
        try {
          await page.close();
        } catch (e) {
          // Ignore
        }
      }
    }
  }

  /**
   * Giám sát network requests để lấy token từ API response.
   */
  private async extractTokenFromNetwork(page: Page): Promise<string | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(null);
      }, 10000); // Timeout 10 giây

      page.on('response', async (response) => {
        try {
          const url = response.url();
          // Tìm response từ OAuth endpoint
          if (url.includes('oauth') || url.includes('token') || url.includes('accounts')) {
            const contentType = response.headers()['content-type'] || '';
            if (contentType.includes('application/json')) {
              const data = await response.json();
              if (data?.access_token) {
                clearTimeout(timeout);
                resolve(data.access_token);
              }
            }
          }
        } catch (e) {
          // Ignore JSON parse errors
        }
      });
    });
  }

  /**
   * Nhắc người dùng nhập OTP từ terminal (nếu cần).
   * Hiện tại trả về null - bạn có thể cải thiện bằng cách hỏi user qua API endpoint.
   */
  private async promptOtp(): Promise<string | null> {
    // TODO: Implement interactive OTP prompt
    // Một cách là: tạo một endpoint POST /auth/otp để user gửi OTP
    // Hoặc dùng thư viện prompt nếu chạy trên CLI
    this.logger.log('⚠️  Hiện tại không hỗ trợ nhập OTP tự động. Vui lòng:');
    this.logger.log('1. Đăng nhập thủ công tại https://truthsocial.com');
    this.logger.log('2. Lấy token từ DevTools');
    this.logger.log('3. Thêm TRUTH_SOCIAL_ACCESS_TOKEN vào .env');
    return null;
  }

  /**
   * Đóng browser khi app shutdown.
   */
  async onModuleDestroy() {
    if (this.browser) {
      try {
        await this.browser.close();
        this.logger.log('Browser đã đóng');
      } catch (e) {
        // Ignore
      }
    }
  }
}
