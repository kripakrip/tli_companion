import https from 'https';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function test() {
  console.log('Загружаю страницу Flame_Elementium...\n');
  
  const html = await httpGet('https://tlidb.com/en/Flame_Elementium');
  
  const idMatch = html.match(/id:\s*(\d+)/i);
  const iconMatch = html.match(/https:\/\/cdn\.tlidb\.com\/UI\/Textures[^"'\s]+\.webp/i);
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  
  console.log('✅ game_id:', idMatch ? idMatch[1] : 'NOT FOUND');
  console.log('✅ icon:', iconMatch ? iconMatch[0] : 'NOT FOUND');
  console.log('✅ name:', h1Match ? h1Match[1].trim() : 'NOT FOUND');
}

test().catch(console.error);
