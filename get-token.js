const axios = require('axios');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(query) {
  return new Promise((resolve) => rl.question(query, resolve));
}

async function getToken() {
  console.log('\n🔐 Truth Social Token Getter\n');

  const username = await question('Username: ');
  const password = await question('Password (sẽ ẩn): ');

  const OAUTH_URL = 'https://truthsocial.com/oauth/token';

  try {
    console.log('\n⏳ Đang cố gắng login...\n');

    const response = await axios.post(
      OAUTH_URL,
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
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      },
    );

    if (response.data?.access_token) {
      console.log('✅ Đăng nhập thành công!\n');
      console.log('📋 Token của bạn (copy dòng này):\n');
      console.log('━'.repeat(80));
      console.log(response.data.access_token);
      console.log('━'.repeat(80));
      console.log('\n📝 Thêm vào .env:\n');
      console.log(
        `TRUTH_SOCIAL_ACCESS_TOKEN=${response.data.access_token}\n`,
      );
      console.log('ℹ️  Token sẽ hết hạn sau:', response.data.expires_in, 'giây (khoảng', Math.ceil(response.data.expires_in / 86400), 'ngày)\n');
    } else {
      console.log('❌ Không nhận được token từ API\n');
      console.log('Response:', response.data);
    }
  } catch (error) {
    console.log('\n❌ Lỗi đăng nhập:\n');

    if (axios.isAxiosError(error)) {
      console.log(`Status: ${error.response?.status}`);
      console.log(
        `Error: ${error.response?.data?.error || error.message}\n`,
      );

      if (error.response?.status === 403 || error.response?.status === 400) {
        console.log('⚠️  Có thể cần OTP verification. Hướng dẫn thủ công:\n');
        console.log('1. Vào https://truthsocial.com và đăng nhập');
        console.log('2. Mở DevTools (F12)');
        console.log('3. Vào tab Network');
        console.log('4. Làm một hành động API (ví dụ: scroll feed)');
        console.log(
          '5. Tìm request "statuses" hoặc "accounts" trong Network tab',
        );
        console.log('6. Xem header Authorization: Bearer {token}');
        console.log('7. Copy token (phần sau "Bearer ") vào .env\n');
      }

      if (error.response?.data?.error_description) {
        console.log(
          'Chi tiết:',
          error.response.data.error_description,
          '\n',
        );
      }
    } else {
      console.log(error.message);
    }
  }

  rl.close();
}

getToken();
