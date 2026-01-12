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
  console.log('Загружаю страницу Drop_Source...\n');
  
  const html = await httpGet('https://tlidb.com/en/Drop_Source');
  
  // Ищем все ссылки
  const allLinks = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
  
  console.log('Всего ссылок:', allLinks.length);
  
  // Предметы обычно имеют формат /Item_Name или /en/Item_Name
  // но НЕ содержат категорий типа Hero, Skill и тд
  const itemLinks = allLinks.filter(link => {
    // Должно быть что-то типа /Flame_Elementium или просто название
    if (link.startsWith('http')) return false;
    if (link.startsWith('#')) return false;
    if (link.includes('/en/')) return false; // категории
    if (link.includes('/ru/')) return false;
    if (link.includes('/cn/')) return false;
    if (link.includes('javascript')) return false;
    if (link === '/') return false;
    return link.length > 2;
  });
  
  const unique = [...new Set(itemLinks)];
  console.log('\nСсылки на предметы (без /en/):', unique.length);
  unique.slice(0, 30).forEach(link => console.log('  ', link));
  
  // Также ищем ссылки с полным доменом
  const fullLinks = allLinks.filter(link => 
    link.includes('tlidb.com') && 
    !link.includes('/en/') &&
    !link.includes('.css') &&
    !link.includes('.js')
  );
  console.log('\nПолные ссылки на tlidb.com:', fullLinks.length);
  fullLinks.slice(0, 10).forEach(link => console.log('  ', link));
}

test().catch(console.error);
