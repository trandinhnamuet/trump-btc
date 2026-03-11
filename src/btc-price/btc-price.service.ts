import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * BtcPriceService: Lấy giá BTC hiện tại.
 *
 * Dùng Binance API làm nguồn chính (miễn phí, không cần API key, độ trễ thấp).
 * Fallback sang CoinGecko nếu Binance không khả dụng.
 */
@Injectable()
export class BtcPriceService {
  private readonly logger = new Logger(BtcPriceService.name);

  // Binance API: nhanh, miễn phí, không rate limit khắt khe
  private readonly BINANCE_URL = 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT';

  // CoinGecko API: fallback nếu Binance không khả dụng
  private readonly COINGECKO_URL =
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd';

  /**
   * Lấy giá BTC/USDT hiện tại (USD).
   * @returns Giá BTC (số), hoặc null nếu không lấy được
   */
  async getCurrentPrice(): Promise<number | null> {
    this.logger.debug('Yêu cầu lấy giá BTC hiện tại');
    // Thử Binance trước
    const binancePrice = await this.fetchFromBinance();
    if (binancePrice !== null) return binancePrice;

    // Fallback sang CoinGecko
    this.logger.warn('Binance API thất bại, chuyển sang CoinGecko...');
    return this.fetchFromCoinGecko();
  }

  /** Lấy giá từ Binance */
  private async fetchFromBinance(): Promise<number | null> {
    try {
      const response = await axios.get<{ price: string }>(this.BINANCE_URL, {
        timeout: 5000,
      });
      const price = parseFloat(response.data.price);
      this.logger.debug(`Giá BTC từ Binance: $${price.toLocaleString()}`);
      return price;
    } catch (error) {
      this.logger.warn('Lỗi Binance API:', error.message);
      return null;
    }
  }

  /** Lấy giá từ CoinGecko (fallback) */
  private async fetchFromCoinGecko(): Promise<number | null> {
    try {
      const response = await axios.get<{ bitcoin: { usd: number } }>(this.COINGECKO_URL, {
        timeout: 8000,
      });
      const price = response.data.bitcoin.usd;
      this.logger.debug(`Giá BTC từ CoinGecko: $${price.toLocaleString()}`);
      return price;
    } catch (error) {
      this.logger.error('Lỗi CoinGecko API:', error.message);
      return null;
    }
  }
}
