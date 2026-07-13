import { EventClass } from '../detector/taxonomy';

/**
 * Golden set — bộ kiểm chứng cho máy phát hiện sự kiện lớp A.
 *
 * `positive`   : sự kiện thật từng làm BTC biến động mạnh — detector PHẢI bắt được
 *                (recall mục tiêu: 100%; miss một bài = fail).
 * `borderline` : ca mập mờ có thật — bắt hay bỏ đều chấp nhận được, chỉ báo cáo.
 * `decoy`      : bài trông "nguy hiểm" nhưng không phải hành động mới — detector
 *                KHÔNG được alert (đo tỉ lệ báo động giả).
 *
 * Nội dung là bản DỰNG LẠI sát nguyên văn các bài đăng được báo chí trích dẫn
 * rộng rãi — không phải nguyên văn 100%. Đủ tốt để đo hành vi detector; khi có
 * archive Truth Social đầy đủ thì thay bằng nguyên văn.
 */

export interface GoldenCase {
  id: string;
  kind: 'positive' | 'borderline' | 'decoy';
  /** lớp kỳ vọng (chỉ cho positive/borderline) */
  expectClass?: EventClass;
  content: string;
  /** các bài "7 ngày gần đây" — để test novelty/repeat */
  recentContext?: string[];
  /** sự kiện thật + kết quả thị trường, để người đọc đối chiếu */
  note: string;
}

export const GOLDEN_CASES: GoldenCase[] = [
  // ═══ POSITIVES — phải bắt được 100% ═══════════════════════════════════════
  {
    id: 'P1_CRYPTO_RESERVE',
    kind: 'positive',
    expectClass: 'A1',
    content:
      'A U.S. Crypto Reserve will elevate this critical industry after years of corrupt attacks by the Biden Administration, ' +
      'which is why my Executive Order on Digital Assets directed the Presidential Working Group to move forward on a Crypto ' +
      'Strategic Reserve that includes XRP, SOL, and ADA. I will make sure the U.S. is the Crypto Capital of the World. ' +
      'We are MAKING AMERICA GREAT AGAIN!',
    note: '02/03/2025 — công bố Crypto Strategic Reserve. BTC +8-10% trong vài giờ, XRP/SOL/ADA tăng 2 chữ số.',
  },
  {
    id: 'P2_GENIUS_ACT',
    kind: 'positive',
    expectClass: 'A1',
    content:
      'Today I signed the GENIUS Act into Law — a giant step to cement American DOMINANCE of Global Finance and Crypto ' +
      'Technology. Stablecoins will supercharge our Dollar and make it stronger than ever before. This is the Golden Age of America!',
    note: '18/07/2025 — ký GENIUS Act (luật stablecoin đầu tiên của Mỹ).',
  },
  {
    id: 'P3_LIBERATION_DAY',
    kind: 'positive',
    expectClass: 'A2',
    content:
      'THIS IS LIBERATION DAY! For DECADES our Country has been looted, pillaged, and plundered by nations near and far. ' +
      'Today I signed an Executive Order imposing RECIPROCAL TARIFFS on countries throughout the World. They do it to us, ' +
      'and we do it to them! MAKE AMERICA WEALTHY AGAIN!',
    note: '02/04/2025 — thuế đối ứng toàn cầu. BTC từ ~$87k rơi xuống <$75k trong tuần sau.',
  },
  {
    id: 'P4_TARIFF_PAUSE',
    kind: 'positive',
    expectClass: 'A2',
    content:
      'Based on the fact that more than 75 Countries have called Representatives of the United States to negotiate, ' +
      'I have authorized a 90 Day PAUSE, and a substantially lowered Reciprocal Tariff during this period, of 10%, ' +
      'also effective immediately. Conversely, based on the lack of respect that China has shown to the World\'s Markets, ' +
      'I am hereby raising the Tariff charged to China by the United States of America to 125%, effective immediately.',
    note: '09/04/2025 — tạm dừng thuế 90 ngày. S&P +9.5% trong ngày, BTC +8%. Pause cũng là sự kiện lớn.',
  },
  {
    id: 'P5_CHINA_100PCT',
    kind: 'positive',
    expectClass: 'A2',
    content:
      'Based on the unprecedented and hostile actions China has taken on Rare Earth Exports, starting November 1st, 2025, ' +
      'the United States of America will impose a Tariff of 100% on China, over and above any Tariff that they are currently paying. ' +
      'It is impossible to believe China would have taken such action, but they have, and the rest is history!',
    note: '10/10/2025 — thuế 100% lên TQ. Đợt thanh lý crypto lớn nhất lịch sử (~$19B), BTC rơi hơn 10% trong vài giờ.',
  },
  {
    id: 'P6_IRAN_STRIKE',
    kind: 'positive',
    expectClass: 'A4',
    content:
      'We have completed our very successful attack on the three Nuclear sites in Iran, including Fordow, Natanz, and Esfahan. ' +
      'All planes are now outside of Iran air space. A full payload of BOMBS was dropped on the primary site, Fordow. ' +
      'All planes are safely on their way home. NOW IS THE TIME FOR PEACE!',
    note: '21/06/2025 — không kích cơ sở hạt nhân Iran. BTC rơi dưới $99k, altcoin giảm 8-10%.',
  },
  {
    id: 'P7_MEXICO_CANADA_TARIFFS',
    kind: 'positive',
    expectClass: 'A2',
    content:
      'Today I implemented a 25% Tariff on Imports from Mexico and Canada, and a 10% additional Tariff on China, through IEEPA. ' +
      'This was done because of the major threat of illegal aliens and deadly drugs killing our Citizens, including fentanyl. ' +
      'We need to protect Americans!',
    note: '01/02/2025 — ký thuế Canada/Mexico/TQ. BTC rơi từ ~$105k xuống ~$92k trong 2 ngày sau.',
  },

  // ═══ BORDERLINE — bắt hay bỏ đều chấp nhận được ═══════════════════════════
  {
    id: 'B1_POWELL_TERMINATION',
    kind: 'borderline',
    expectClass: 'A3',
    content:
      'The ECB is expected to cut interest rates for the 7th time, and yet, "Too Late" Jerome Powell of the Fed, who is always ' +
      'TOO LATE AND WRONG, yesterday issued a report which was another, and typical, complete "mess!" Oil prices are down, ' +
      'groceries are down, and the USA is getting RICH ON TARIFFS. Powell\'s termination cannot come fast enough!',
    note: '17/04/2025 — chưa phải hành động (chỉ là mong muốn) nhưng thị trường vẫn giảm. Bắt = defensible, bỏ = đúng định nghĩa "confirmed".',
  },
  {
    id: 'B2_RESERVE_FOLLOWUP',
    kind: 'borderline',
    expectClass: 'A1',
    content:
      'And, obviously, BTC and ETH, as other valuable Cryptocurrencies, will be at the heart of the Reserve. ' +
      'I also love Bitcoin and Ethereum!',
    recentContext: [
      'A U.S. Crypto Reserve will elevate this critical industry after years of corrupt attacks by the Biden Administration, ' +
        'which is why my Executive Order on Digital Assets directed the Presidential Working Group to move forward on a Crypto ' +
        'Strategic Reserve that includes XRP, SOL, and ADA.',
    ],
    note: '02/03/2025 — follow-up 1 giờ sau P1, thêm BTC/ETH vào reserve. Thị trường phản ứng thêm một nhịp. Là "thông tin mới bổ sung" nhưng cùng sự kiện — bắt hay bỏ đều có lý.',
  },

  // ═══ DECOYS — không được alert ════════════════════════════════════════════
  {
    id: 'D1_MAGA_SLOGAN',
    kind: 'decoy',
    content: 'THE GOLDEN AGE OF AMERICA HAS BEGUN! Our Country is BACK and STRONGER than ever before. MAKE AMERICA GREAT AGAIN!',
    note: 'Khẩu hiệu thuần.',
  },
  {
    id: 'D2_BIRTHDAY',
    kind: 'decoy',
    content: 'Happy Birthday to a Great American Patriot and Warrior. A wonderful friend who loves our Country. MAGA!',
    note: 'Xã giao.',
  },
  {
    id: 'D3_MEDIA_ATTACK',
    kind: 'decoy',
    content:
      'The Failing New York Times has become the laughing stock of journalism. Everything they write about me is FAKE NEWS. ' +
      'Their reporters are sick and deranged. SAD!',
    note: 'Công kích truyền thông.',
  },
  {
    id: 'D4_FED_COMPLAINT',
    kind: 'decoy',
    content:
      '"Too Late" Jerome Powell should have lowered Interest Rates long ago. Europe has cut rates many times, but Powell ' +
      'just sits there. He is always TOO LATE AND WRONG. The Fed is failing America!',
    note: 'Than phiền Fed KHÔNG kèm hành động — Trump đăng dạng này gần như hàng tuần. Decoy khó cho A3.',
  },
  {
    id: 'D5_CRYPTO_CHEERLEADING',
    kind: 'decoy',
    content:
      'We will make America the CRYPTO CAPITAL OF THE WORLD! Digital assets are the future, and under my Administration, ' +
      'the future is bright. We love our crypto community!',
    note: 'Hô hào crypto không hành động — nói ở rally rất nhiều lần. Decoy khó cho A1.',
  },
  {
    id: 'D6_TARIFF_BRAGGING',
    kind: 'decoy',
    content:
      'Tariffs are making America RICH AGAIN! Billions and Billions of Dollars are pouring into our Treasury from countries ' +
      'that took advantage of us for years. Jobs are coming back. Factories are being built. AMERICA FIRST!',
    note: 'Khoe thành tích thuế đã áp — không có hành động mới. Decoy khó cho A2.',
  },
  {
    id: 'D7_VAGUE_THREAT',
    kind: 'decoy',
    content:
      'Any country that aligns itself with the Anti-American policies of BRICS will pay a very BIG price. ' +
      'There will be no exceptions to this policy. Thank you for your attention to this matter!',
    note: 'Đe dọa mơ hồ — không con số, không thời hạn, không hành động ký kết. Decoy khó cho A2.',
  },
  {
    id: 'D8_RESERVE_PRAISE_REPEAT',
    kind: 'decoy',
    content:
      'Our Strategic Bitcoin Reserve is already doing GREAT things for our Country. America now leads the World in Digital ' +
      'Assets, just like I promised. Crypto is the future!',
    recentContext: [
      'A U.S. Crypto Reserve will elevate this critical industry after years of corrupt attacks by the Biden Administration, ' +
        'which is why my Executive Order on Digital Assets directed the Presidential Working Group to move forward on a Crypto ' +
        'Strategic Reserve that includes XRP, SOL, and ADA. I will make sure the U.S. is the Crypto Capital of the World.',
    ],
    note: 'Ca ngợi reserve ĐÃ công bố trước đó — decoy khó nhất cho A1: có cụm từ khóa nhưng không phải hành động mới.',
  },
  {
    id: 'D9_STOCK_BRAGGING',
    kind: 'decoy',
    content:
      'Stock Market at RECORD HIGHS! 401(k)s are doing better than ever before. Gas prices DOWN. Inflation DOWN. ' +
      'Egg prices DOWN. America is WINNING again!',
    note: 'Khoe kinh tế.',
  },
  {
    id: 'D10_CONDITIONAL_TARIFF',
    kind: 'decoy',
    content:
      'If China does not behave and negotiate in GOOD FAITH, I will not hesitate to impose massive Tariffs on them. ' +
      'They know what is coming. We hold all the cards!',
    note: 'Điều kiện tương lai, không hành động — "will not hesitate" ≠ đã làm. Decoy khó cho A2.',
  },
  {
    id: 'D11_SPORTS',
    kind: 'decoy',
    content:
      'Congratulations to the Philadelphia Eagles on a GREAT Super Bowl win! What a game. Enjoyed watching with friends. ' +
      'Great job by Coach and the entire team!',
    note: 'Thể thao.',
  },
  {
    id: 'D12_INTERVIEW_PROMO',
    kind: 'decoy',
    content: 'I will be interviewed by Sean Hannity tonight at 9:00 P.M. Eastern on Fox News. Big things to discuss. Enjoy!',
    note: 'Quảng bá lịch phát sóng.',
  },
];
