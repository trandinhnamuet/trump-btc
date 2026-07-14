/**
 * CLI: đo recall + tỉ lệ báo động giả của máy phát hiện sự kiện lớp A
 * trên golden set (sự kiện thật + mồi nhử).
 *
 *   npm run detector:eval                 — đầy đủ (tripwire + LLM checklist, ~5 call/case)
 *   npm run detector:eval -- --rules-only — chỉ tripwire + novelty (0 API call, tức thì)
 *
 * Thước đo:
 *   - Recall trên positives: PHẢI 100% — miss một sự kiện thật là fail.
 *   - False alarm trên decoys: mục tiêu 0, chấp nhận thấp (recall-first).
 *   - Borderline: bắt hay bỏ đều được, chỉ báo cáo.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { DetectorService } from '../detector/detector.service';
import { ModelRegistryService } from '../detector/model-registry.service';
import { GOLDEN_CASES } from './golden-set';

// Nạp .env thủ công (chạy ngoài Nest)
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}

const rulesOnly = process.argv.includes('--rules-only');

async function main() {
  const config = new ConfigService();
  // Ngoài Nest nên onModuleInit không chạy → registry trống → checklist dùng
  // SEED_MODELS đã xác minh tay. Tất định, không tốn probe call.
  const detector = new DetectorService(config, new ModelRegistryService(config));

  console.log('═'.repeat(78));
  console.log(` ĐÁNH GIÁ DETECTOR — ${rulesOnly ? 'CHỈ TRIPWIRE (0 API call)' : 'ĐẦY ĐỦ (tripwire + LLM checklist)'}`);
  console.log('═'.repeat(78));

  const rows: Array<{
    id: string;
    kind: string;
    expected: string;
    got: string;
    source: string;
    alert: boolean;
    ok: boolean | null;
  }> = [];

  for (const c of GOLDEN_CASES) {
    const r = await detector.detect(c.content, c.recentContext ?? [], {
      skipDedup: true,
      rulesOnly,
    });

    let ok: boolean | null;
    if (c.kind === 'positive') ok = r.alert && r.eventClass === c.expectClass;
    else if (c.kind === 'decoy') ok = !r.alert;
    else ok = null; // borderline: không chấm

    const votesStr = r.votes.length
      ? ` phiếu=[${r.votes.map(v => `${v.model.split('/').pop()?.replace(':free', '')}:${v.eventClass}${v.confirmed ? '✓' : ''}${v.newAction ? '★' : ''}`).join(', ')}]`
      : '';
    const supp = r.suppressedBy ? ` (chặn bởi ${r.suppressedBy})` : '';

    rows.push({
      id: c.id,
      kind: c.kind,
      expected: c.kind === 'decoy' ? 'KHÔNG alert' : (c.expectClass ?? '?'),
      got: r.alert ? `ALERT ${r.eventClass}` : `im lặng${supp}`,
      source: r.source ?? '-',
      alert: r.alert,
      ok,
    });

    const mark = ok === null ? '◐' : ok ? '✅' : '❌';
    console.log(
      `\n${mark} ${c.id} [${c.kind}]` +
        `\n   kỳ vọng: ${c.kind === 'decoy' ? 'KHÔNG alert' : `ALERT ${c.expectClass}`}` +
        `\n   kết quả: ${r.alert ? `ALERT lớp ${r.eventClass} (${r.source})` : `không alert${supp}`}` +
        (r.matchedRules.length ? `\n   tripwire: ${r.matchedRules.join(', ')}` : '') +
        (votesStr ? `\n  ${votesStr}` : '') +
        `\n   novelty: ${(r.novelty * 100).toFixed(0)}%` +
        `\n   ${c.note}`,
    );
  }

  // ── Tổng kết ─────────────────────────────────────────────────────────────
  const positives = rows.filter(r => r.kind === 'positive');
  const decoys = rows.filter(r => r.kind === 'decoy');
  const borderlines = rows.filter(r => r.kind === 'borderline');
  const caught = positives.filter(r => r.ok).length;
  const falseAlarms = decoys.filter(r => !r.ok).length;

  console.log('\n' + '═'.repeat(78));
  console.log(' TỔNG KẾT');
  console.log('═'.repeat(78));
  console.log(`  RECALL (positives)    : ${caught}/${positives.length}  ${caught === positives.length ? '✅ ĐẠT' : '❌ MISS — không chấp nhận được'}`);
  if (caught < positives.length) {
    for (const r of positives.filter(x => !x.ok)) console.log(`     ↳ MISS: ${r.id} (kết quả: ${r.got})`);
  }
  console.log(`  BÁO ĐỘNG GIẢ (decoys) : ${falseAlarms}/${decoys.length}  ${falseAlarms === 0 ? '✅ sạch' : '⚠️ xem lại các case dưới'}`);
  if (falseAlarms > 0) {
    for (const r of decoys.filter(x => !x.ok)) console.log(`     ↳ FALSE ALARM: ${r.id} (${r.got}, nguồn: ${r.source})`);
  }
  console.log(`  BORDERLINE            : ${borderlines.map(r => `${r.id}→${r.alert ? 'bắt' : 'bỏ'}`).join(', ')}`);
  if (rulesOnly) {
    console.log('\n  ⓘ Chế độ --rules-only: positives không có tripwire khớp sẽ hiện MISS ở đây');
    console.log('    nhưng còn tầng LLM checklist đỡ — chạy bản đầy đủ để có recall thật.');
  }
  console.log('═'.repeat(78));

  // Exit code: fail nếu miss positive ở chế độ đầy đủ
  if (!rulesOnly && caught < positives.length) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
