import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * MarketSignalService v2: Cung cáº¥p bá»™i cáº£nh thá»‹ trÆ°á»ng Ä‘áº§y Ä‘á»§ cho Grok AI phÃ¢n tÃ­ch.
 *
 * Thu tháº­p tá»« Binance:
 *   - Dáº¡i hÃ ng ngÃ y (32 phiÃªn) â†’ 24h / 7d / 30d % change
 *   - Tuáº§n (53 phiáº¿n) â†’ 52-week high & low
 *
 * Táº¥t cáº£ dá»¯ liá»‡u nÃ y Ä‘Æ°á»£c Ä‘Æ°a vÃ o prompt cá»§a Grok thay vÃ¬ dÃ¹ng lÃ m trá»ng sá»‘ ensemble.
 */

export interface MarketContextResult {
  currentPrice:    number;   // GiÃ¡ hiá»‡n táº¡i
  change24h:       number;   // % thay Ä‘á»•i 24h
  change7d:        number;   // % thay Ä‘á»•i 7 ngÃ y
  change30d:       number;   // % thay Ä‘á»•i 30 ngÃ y
  high52w:         number;   // Äá»‰nh 52 tuáº§n
  low52w:          number;   // ÄÃ¡y 52 tuáº§n
  pctFromHigh52w:  number;   // % cÃ¡ch Ä‘á»‰nh 52w (sá»‘ Ã¢m = Ä‘ang lÃ³ xuá»‘ng)
  trendLabel:      string;   // MÃ´ táº£ tráº¡ng thÃ¡i thá»‹ trÆ°á»ng báº±ng tiáº¿ng Anh
  marketSignalScore: number; // 0â€“1, giá»¯ láº¡i Ä‘á»ƒ logging
}

@Injectable()
export class MarketSignalService {
  private readonly logger = new Logger(MarketSignalService.name);
  private readonly BINANCE = 'https://api.binance.com';

  async getMarketContext(): Promise<MarketContextResult> {
    try {
      const [dailyRes, weeklyRes] = await Promise.all([
        axios.get(`${this.BINANCE}/api/v3/klines`, {
          params: { symbol: 'BTCUSDT', interval: '1d', limit: 32 },
          timeout: 6000,
        }),
        axios.get(`${this.BINANCE}/api/v3/klines`, {
          params: { symbol: 'BTCUSDT', interval: '1w', limit: 53 },
          timeout: 6000,
        }),
      ]);

      const daily: Array<Array<string | number>> = dailyRes.data;
      const weekly: Array<Array<string | number>> = weeklyRes.data;

      // daily[n-1] = phiáº¿n hiá»‡n táº¡i (cÃ³ thá»ƒ chÆ°a Ä‘Ã³ng), daily[n-2] = hÃ´m qua...
      const n            = daily.length;
      const currentPrice = parseFloat(String(daily[n - 1][4]));
      const price24hAgo  = parseFloat(String(daily[n - 2][4]));
      const price7dAgo   = parseFloat(String(daily[Math.max(0, n - 8)][4]));
      const price30dAgo  = parseFloat(String(daily[0][4]));

      const pct = (a: number, b: number) => +((a - b) / b * 100).toFixed(2);
      const change24h  = pct(currentPrice, price24hAgo);
      const change7d   = pct(currentPrice, price7dAgo);
      const change30d  = pct(currentPrice, price30dAgo);

      const high52w        = Math.max(...weekly.map(k => parseFloat(String(k[2]))));
      const low52w         = Math.min(...weekly.map(k => parseFloat(String(k[3]))));
      const pctFromHigh52w = pct(currentPrice, high52w);

      const trendLabel      = this.computeTrendLabel(change30d, pctFromHigh52w, change7d);
      const marketSignalScore = Math.min(1.0, Math.abs(change24h) / 5.0);

      this.logger.debug(
        `Market context: $${currentPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })} ` +
        `| 24h=${change24h}% | 7d=${change7d}% | 30d=${change30d}% ` +
        `| from52wHigh=${pctFromHigh52w}% | ${trendLabel}`,
      );

      return { currentPrice, change24h, change7d, change30d, high52w, low52w, pctFromHigh52w, trendLabel, marketSignalScore };
    } catch (err) {
      this.logger.warn(`KhÃ´ng láº¥y Ä‘Æ°á»£c market context: ${(err as Error).message}`);
      return {
        currentPrice: 0, change24h: 0, change7d: 0, change30d: 0,
        high52w: 0, low52w: 0, pctFromHigh52w: 0,
        trendLabel: 'unknown (market data unavailable)',
        marketSignalScore: 0,
      };
    }
  }

  private computeTrendLabel(change30d: number, pctFromHigh52w: number, change7d: number): string {
    if (pctFromHigh52w > -5)                        return 'near 52-week high â€” potential distribution zone, fragile';
    if (pctFromHigh52w > -15 && change30d > 15)     return 'strong bull trend, approaching ATH zone';
    if (change30d > 20)                             return 'strong bull run â€” momentum high, sentiment euphoric';
    if (change30d > 8)                              return 'bull trend â€” positive sentiment, buying pressure';
    if (change30d > -5 && change7d > 3)             return 'consolidation / early recovery â€” cautious optimism';
    if (change30d > -5)                             return 'ranging sideways â€” no strong directional bias';
    if (change30d > -20)                            return 'bear correction â€” negative sentiment, risk-off mode';
    return 'deep bear market â€” fear dominant, capitulation risk';
  }
}

