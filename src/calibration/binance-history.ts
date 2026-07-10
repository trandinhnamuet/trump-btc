import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { Bar } from './types';

/**
 * Nạp và cache chuỗi nến 1 phút của Binance.
 *
 * Binance cho phép lấy nến lịch sử miễn phí, không cần API key, không giới hạn
 * ngày. Ta nạp một lần rồi cache xuống đĩa theo từng tháng UTC, nên việc gắn
 * nhãn cho toàn bộ lịch sử bài viết không tốn API call nào của lần chạy sau.
 *
 * Giá tại một thời điểm luôn được lấy bằng `closeAtOrBefore` — giá đóng của nến
 * gần nhất kết thúc TRƯỚC hoặc ĐÚNG thời điểm đó. Không bao giờ nhìn về tương
 * lai, nên không có look-ahead bias khi tính return quanh thời điểm đăng bài.
 */

const MINUTE_MS = 60_000;
const KLINES_URL = 'https://api.binance.com/api/v3/klines';
const MAX_LIMIT = 1000;

/** Khoảng trống dữ liệu tối đa chấp nhận được khi tra giá (Binance có thể thiếu nến). */
const DEFAULT_MAX_STALE_MS = 5 * MINUTE_MS;

interface MonthCache {
  symbol: string;
  interval: '1m';
  month: string; // YYYY-MM
  /** true khi tháng đã kết thúc → không cần fetch lại nữa */
  complete: boolean;
  fetchedAt: string;
  /** [openTime, close][] — sắp xếp tăng dần theo openTime */
  bars: [number, number][];
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** 'YYYY-MM' của một epoch ms, theo UTC. */
function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** [đầu tháng, đầu tháng kế tiếp) theo UTC, epoch ms. */
function monthBounds(key: string): { start: number; end: number } {
  const [y, m] = key.split('-').map(Number);
  return {
    start: Date.UTC(y, m - 1, 1),
    end: Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1),
  };
}

/** Liệt kê các tháng UTC phủ khoảng [startMs, endMs]. */
function monthsInRange(startMs: number, endMs: number): string[] {
  const out: string[] = [];
  const d = new Date(startMs);
  let cur = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  while (cur <= endMs) {
    out.push(monthKey(cur));
    const c = new Date(cur);
    cur = Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + 1, 1);
  }
  return out;
}

export class BinanceHistory {
  private readonly cacheDir: string;
  private bars: Bar[] = [];

  constructor(
    private readonly symbol = 'BTCUSDT',
    cacheDir = path.join(process.cwd(), 'data', 'klines'),
    private readonly log: (msg: string) => void = () => {},
  ) {
    this.cacheDir = cacheDir;
    if (!fs.existsSync(this.cacheDir)) fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  private cacheFile(month: string): string {
    return path.join(this.cacheDir, `${this.symbol}-1m-${month}.json`);
  }

  /**
   * Đảm bảo mọi tháng phủ [startMs, endMs] đã có trong cache, rồi nạp vào memory.
   * Tháng đã kết thúc chỉ fetch một lần; tháng hiện tại được fetch bổ sung phần đuôi.
   */
  async load(startMs: number, endMs: number): Promise<void> {
    const months = monthsInRange(startMs, endMs);
    this.log(`[klines] cần ${months.length} tháng: ${months[0]} → ${months[months.length - 1]}`);

    const all: Bar[] = [];
    for (const month of months) {
      const cache = await this.ensureMonth(month);
      for (const [t, c] of cache.bars) all.push({ t, c });
    }

    all.sort((a, b) => a.t - b.t);
    // Khử trùng lặp ở ranh giới tháng
    this.bars = all.filter((b, i) => i === 0 || b.t !== all[i - 1].t);
    this.log(`[klines] đã nạp ${this.bars.length.toLocaleString('en-US')} nến 1m vào memory`);
  }

  private async ensureMonth(month: string): Promise<MonthCache> {
    const file = this.cacheFile(month);
    const { start, end } = monthBounds(month);
    const monthHasEnded = end <= Date.now();

    let cache: MonthCache | null = null;
    if (fs.existsSync(file)) {
      try {
        cache = JSON.parse(fs.readFileSync(file, 'utf-8')) as MonthCache;
      } catch {
        this.log(`[klines] cache hỏng, fetch lại: ${month}`);
        cache = null;
      }
    }

    if (cache?.complete) return cache;

    // Fetch tiếp từ nến cuối đã có (hoặc từ đầu tháng nếu chưa có gì)
    const existing = cache?.bars ?? [];
    const from = existing.length ? existing[existing.length - 1][0] + MINUTE_MS : start;

    if (from < end) {
      const fresh = await this.fetchRange(from, Math.min(end, Date.now()));
      existing.push(...fresh);
      this.log(`[klines] ${month}: +${fresh.length} nến (tổng ${existing.length})`);
    }

    const next: MonthCache = {
      symbol: this.symbol,
      interval: '1m',
      month,
      complete: monthHasEnded,
      fetchedAt: new Date().toISOString(),
      bars: existing,
    };
    fs.writeFileSync(file, JSON.stringify(next), 'utf-8');
    return next;
  }

  /** Gọi /api/v3/klines lặp lại cho tới khi phủ hết [from, to). */
  private async fetchRange(from: number, to: number): Promise<[number, number][]> {
    const out: [number, number][] = [];
    let cursor = from;

    while (cursor < to) {
      const rows = await this.fetchOnce(cursor, to);
      if (!rows.length) break;

      for (const k of rows) {
        const openTime = Number(k[0]);
        if (openTime >= to) continue;
        out.push([openTime, parseFloat(String(k[4]))]);
      }

      const lastOpen = Number(rows[rows.length - 1][0]);
      if (lastOpen + MINUTE_MS <= cursor) break; // không tiến được → thoát để tránh vòng lặp vô hạn
      cursor = lastOpen + MINUTE_MS;

      if (rows.length < MAX_LIMIT) break; // Binance đã trả hết dữ liệu có sẵn
      await sleep(220); // giữ dưới ngưỡng weight của Binance
    }

    return out;
  }

  /** Một request klines, có retry với backoff cho 429/418/5xx. */
  private async fetchOnce(startTime: number, endTime: number): Promise<unknown[][]> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await axios.get<unknown[][]>(KLINES_URL, {
          params: { symbol: this.symbol, interval: '1m', startTime, endTime, limit: MAX_LIMIT },
          timeout: 20_000,
        });
        return res.data;
      } catch (err: any) {
        const status = err?.response?.status;
        const retriable = status === 429 || status === 418 || (status >= 500 && status < 600) || !status;
        if (!retriable || attempt === 4) throw err;
        const waitMs = 2000 * Math.pow(2, attempt);
        this.log(`[klines] HTTP ${status ?? 'network'} → chờ ${waitMs}ms rồi thử lại (lần ${attempt + 1}/5)`);
        await sleep(waitMs);
      }
    }
    return [];
  }

  /** Nến sớm nhất / muộn nhất hiện có trong memory. */
  get range(): { first: number; last: number } | null {
    if (!this.bars.length) return null;
    return { first: this.bars[0].t, last: this.bars[this.bars.length - 1].t };
  }

  /**
   * Giá tại thời điểm `ts` — giá đóng của nến gần nhất kết thúc trước hoặc đúng `ts`.
   * Không nhìn về tương lai. Trả về null nếu khoảng trống dữ liệu vượt `maxStaleMs`.
   */
  closeAtOrBefore(ts: number, maxStaleMs = DEFAULT_MAX_STALE_MS): number | null {
    // Tìm chỉ số lớn nhất i sao cho closeTime(i) = bars[i].t + MINUTE_MS <= ts
    let lo = 0;
    let hi = this.bars.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.bars[mid].t + MINUTE_MS <= ts) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0) return null;

    const closeTime = this.bars[found].t + MINUTE_MS;
    if (ts - closeTime > maxStaleMs) return null;
    return this.bars[found].c;
  }

  /**
   * Chuỗi giá đóng theo giờ trong [startMs, endMs], lấy mẫu tại mỗi mốc giờ tròn UTC.
   * Mốc thiếu dữ liệu bị bỏ qua; `t` được giữ lại để bên gọi phát hiện khoảng trống
   * và không tính log-return bắc qua chúng.
   */
  hourlyCloses(startMs: number, endMs: number): Bar[] {
    const HOUR_MS = 3_600_000;
    const first = Math.ceil(startMs / HOUR_MS) * HOUR_MS;
    const out: Bar[] = [];
    for (let t = first; t <= endMs; t += HOUR_MS) {
      const c = this.closeAtOrBefore(t);
      if (c !== null) out.push({ t, c });
    }
    return out;
  }
}
