import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * MarketSignalService: Thu thập tín hiệu ngắn hạn từ thị trường.
 *
 * Sử dụng Binance Klines API để lấy nến BTC 15m gần nhất,
 * tính momentum (% thay đổi trong 15m và 1h) → normalize → trả ra marketSignalScore.
 *
 * score cao → thị trường đang biến động mạnh → ensemble boost probability.
 *
 * Không cần API key — dùng Binance public endpoint.
 */

export interface MarketSignalResult {
  btcChange15m: number | null;   // % thay đổi BTC so với 15 phút trước
  btcChange1h: number | null;    // % thay đổi BTC so với 1 giờ trước
  marketSignalScore: number;     // 0.0 – 1.0 (mức độ biến động thị trường)
  direction: 'increase' | 'decrease' | 'neutral';
}

@Injectable()
export class MarketSignalService {
  private readonly logger = new Logger(MarketSignalService.name);

  // Binance Klines: lấy 5 nến 15m (đủ để tính 1h = 4 nến x 15m)
  private readonly KLINES_URL = 'https://api.binance.com/api/v3/klines';

  async getMarketSignal(): Promise<MarketSignalResult> {
    try {
      // Lấy 5 nến 15m gần nhất (75 phút)
      const resp = await axios.get<any[][]>(this.KLINES_URL, {
        params: { symbol: 'BTCUSDT', interval: '15m', limit: 5 },
        timeout: 5000,
      });

      const klines = resp.data;
      if (!klines || klines.length < 4) {
        this.logger.warn('Không đủ dữ liệu kline để tính market signal');
        return this.neutral();
      }

      // Kline index: [0]=openTime [1]=open [2]=high [3]=low [4]=close [5]=volume
      const currentClose = parseFloat(klines[klines.length - 1][4]);
      const prev1Close = parseFloat(klines[klines.length - 2][4]); // ~15m trước
      const prev4Close = parseFloat(klines[0][4]);                  // ~60m trước

      const change15m = ((currentClose - prev1Close) / prev1Close) * 100;
      const change1h = ((currentClose - prev4Close) / prev4Close) * 100;

      // Score = abs(thay đổi 1h) chuẩn hoá:
      // |0%| → 0.0,  |1%| → 0.33,  |2%| → 0.55,  |3%| → 0.75,  |5%+| → 1.0
      const absChange = Math.abs(change1h);
      const marketSignalScore = Math.min(1.0, absChange / 5.0);

      const direction: 'increase' | 'decrease' | 'neutral' =
        change1h > 0.3 ? 'increase' : change1h < -0.3 ? 'decrease' : 'neutral';

      this.logger.debug(
        `Market signal → BTC 15m: ${change15m.toFixed(2)}%, 1h: ${change1h.toFixed(2)}% → score=${marketSignalScore.toFixed(2)}`,
      );

      return { btcChange15m: change15m, btcChange1h: change1h, marketSignalScore, direction };
    } catch (err) {
      this.logger.warn(`Không lấy được market signal: ${err.message}`);
      return this.neutral();
    }
  }

  private neutral(): MarketSignalResult {
    return { btcChange15m: null, btcChange1h: null, marketSignalScore: 0, direction: 'neutral' };
  }
}
