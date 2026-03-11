# Trump Bitcoin Impact Analyzer

Ứng dụng NestJS theo dõi bài viết của Trump trên Truth Social, phân tích tác động tiềm năng đến giá Bitcoin bằng OpenAI, và gửi thông báo Telegram alert khi phát hiện bài viết có ảnh hưởng cao.

## Cấu hình

### 1. Chuẩn bị file .env

```bash
cp .env.example .env
```

Điền các giá trị vào `.env`:

#### OpenAI API
```
OPENAI_API_KEY=sk-...
```
Lấy tại https://platform.openai.com/api-keys

#### Telegram Bot
```
TELEGRAM_BOT_TOKEN=123456789:AAF...
```
Tạo bot qua [@BotFather](https://t.me/BotFather) trên Telegram

#### Truth Social Authentication
**CÁCH 1 - Tự động login (khuyến nghị):**
```
TRUTHSOCIAL_USERNAME=your_username
TRUTHSOCIAL_PASSWORD=your_password
```
App sẽ tự động lấy access token qua OAuth.

**CÁCH 2 - Manual token (dự phòng):**
Nếu cách 1 không hoạt động, lấy token thủ công:
1. Đăng nhập Truth Social trên trình duyệt
2. Mở DevTools → Network tab
3. Tìm request có header `Authorization: Bearer ...`
4. Copy token và thêm vào `.env`:
```
TRUTH_SOCIAL_ACCESS_TOKEN=...
```

#### Ngưỡng Alert (tùy chọn)
```
BTC_INFLUENCE_THRESHOLD=90  # Phần trăm, mặc định 90%
```

### 2. Cấu hình danh sách Telegram users

Sửa file `data/users.json` để thêm người dùng:

```json
{
  "users": [
    { "chatId": "123456789", "name": "Tên bạn" },
    { "chatId": "987654321", "name": "Tên người khác" }
  ]
}
```

Để lấy chat ID của bạn:
- Nhắn tin cho bot [@userinfobot](https://t.me/userinfobot) trên Telegram
- Bot sẽ return chat ID của bạn

## Cài đặt & Chạy

```bash
# 1. Cài dependencies
npm install

# 2. Chạy development mode (có auto-reload)
npm run start:dev

# 3. Production build
npm run build
npm run start:prod
```

## Cách hoạt động

### Flow chính

```
Mỗi 30 giây:
  ├─ Kiểm tra bài viết mới của Trump trên Truth Social
  ├─ Phân tích bằng OpenAI GPT-4o-mini:
  │  ├─ Tóm tắt nội dung
  │  ├─ % khả năng ảnh hưởng BTC (0-100%)
  │  └─ Hướng tăng/giảm/trung lập
  ├─ Nếu % >= ngưỡng (mặc định 90%) → Gửi Telegram alert cho tất cả users
  └─ Lưu bài viết + phân tích vào data/posts.json

Mỗi 1 phút:
  ├─ Kiểm tra các bài cần cập nhật giá BTC
  └─ Ghi lại giá tại +1h, +1 ngày, +7 ngày sau khi đăng
     (để đánh giá độ chính xác của dự đoán)
```

### Dữ liệu lưu trữ

- **`data/posts.json`** - Bài viết + phân tích + giá BTC tại các mốc (tự tạo)
- **`data/alerts.log`** - JSON per-line log của tất cả alerts đã gửi (tự tạo)
- **`data/users.json`** - Danh sách Telegram users (cần tạo/sửa tay)

## Kiến trúc

```
src/
├── common/interfaces.ts        # TypeScript types dùng chung
├── storage/                    # Lưu dữ liệu vào file JSON local
├── truth-social/               # Lấy bài viết từ Truth Social API
├── analysis/                   # Phân tích bằng OpenAI GPT-4o-mini
├── btc-price/                  # Lấy giá BTC từ Binance API
├── telegram/                   # Gửi alert Telegram + ghi log alerts
└── polling/                    # Orchestrator: điều phối cron jobs
```

## Logs & Output

Khi chạy, bạn sẽ thấy logs chi tiết:
- Lần đầu chạy: "Lần đầu khởi động. Sẽ watch từ bài tiếp theo"
- Bài mới: "🆕 Tìm thấy N bài viết mới của Trump!"
- Phân tích: "Phân tích xong: xác suất ảnh hưởng BTC = X% (TĂNG/GIẢM/TRUNG LẬP)"
- Alert: "🚨 XÁC SUẤT X% >= 90% → Gửi Telegram alert!"
- Độ chính xác (sau 7 ngày): "[ĐỘ CHÍNH XÁC] Bài X: Dự đoán=TĂNG (85%), Thực tế=GIẢM (-2%), Kết quả=❌ SAI"

## Troubleshooting

### Truth Social authentification failed
Nếu thấy error "Truth Social yêu cầu xác thực":

1. **Kiểm tra credentials:**
   ```bash
   # Test login thủ công bằng curl
   curl -X POST https://truthsocial.com/oauth/token \
     -d "client_id=Trump-Analyzer-Client&client_secret=do-not-use-in-production&grant_type=password&username=YOUR_USERNAME&password=YOUR_PASSWORD&scope=read"
   ```

2. **Nếu thấy error, thử cách manual token:**
   - Đăng nhập vào https://truthsocial.com
   - Mở DevTools (F12) → Network tab
   - Refres page hoặc cuộn posts
   - Tìm request `/accounts/.../statuses`
   - Xem header `Authorization: Bearer ...`
   - Copy token vào `TRUTH_SOCIAL_ACCESS_TOKEN` trong `.env`

### OpenAI API mất tin
- Kiểm tra OPENAI_API_KEY có hợp lệ không: https://platform.openai.com/account/api-keys
- Kiểm tra quotas: https://platform.openai.com/account/billing/usage
- Logs sẽ show "Lỗi khi gọi OpenAI API: ..."

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
