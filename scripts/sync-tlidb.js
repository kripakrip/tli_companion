/**
 * Синхронизация данных с tlidb.com в Supabase
 * 
 * Парсит страницы предметов с tlidb.com, извлекает game_id, названия, иконки
 * и обновляет таблицу tli_game_items в Supabase.
 */

import https from 'https';
import http from 'http';

// Supabase config
const SUPABASE_URL = 'https://tgclfnahahemystgvkhc.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRnY2xmbmFoYWhlbXlzdGd2a2hjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4NTk5NzYsImV4cCI6MjA4MzQzNTk3Nn0.SDS55p4p75WMxZW6Gyrx-Ow2-Bf0dB8R2yL8M5-Dnm4';

const TLIDB_BASE = 'https://tlidb.com';
const DELAY_MS = 500; // Задержка между запросами

/**
 * HTTP GET запрос
 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}

/**
 * Задержка
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Извлечь game_id из HTML страницы предмета
 */
function extractGameId(html) {
  // Ищем паттерн "id: 100300" или "id:100300"
  const match = html.match(/id:\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Извлечь иконку из HTML
 */
function extractIcon(html) {
  // Ищем изображение с cdn.tlidb.com в папке UI/Textures (не logo)
  const matches = html.match(/https:\/\/cdn\.tlidb\.com\/UI\/Textures[^"'\s]+\.webp/gi);
  return matches ? matches[0] : null;
}

/**
 * Извлечь описание
 */
function extractDescription(html) {
  // Описание обычно в теге после названия
  const match = html.match(/An\s+[^<]+(?:material|currency|item|resource)[^<]*/i);
  return match ? match[0].trim() : null;
}

/**
 * Получить список всех предметов со страницы категории
 */
async function getItemLinksFromCategory(categoryUrl) {
  console.log(`📂 Загружаю категорию: ${categoryUrl}`);
  const { status, data } = await httpGet(categoryUrl);
  
  if (status !== 200) {
    console.log(`  ❌ Ошибка ${status}`);
    return [];
  }
  
  // Ищем ссылки на предметы
  const links = [];
  const regex = /href="(\/en\/[^"]+)"/g;
  let match;
  while ((match = regex.exec(data)) !== null) {
    const href = match[1];
    // Фильтруем только предметы (исключаем навигацию)
    if (!href.includes('/Hero') && 
        !href.includes('/Talent') && 
        !href.includes('/Skill') &&
        !href.includes('/Craft') &&
        href.length > 5) {
      links.push(TLIDB_BASE + href);
    }
  }
  
  // Уникальные ссылки
  return [...new Set(links)];
}

/**
 * Парсинг одной страницы предмета
 */
async function parseItemPage(url) {
  const { status, data } = await httpGet(url);
  
  if (status !== 200) {
    return null;
  }
  
  const gameId = extractGameId(data);
  if (!gameId) {
    return null;
  }
  
  // Извлекаем название из URL или title
  const titleMatch = data.match(/<title>([^<]+)<\/title>/i);
  const nameFromTitle = titleMatch ? titleMatch[1].split('|')[0].trim() : null;
  
  // Название из h1
  const h1Match = data.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const nameFromH1 = h1Match ? h1Match[1].trim() : null;
  
  const name = nameFromH1 || nameFromTitle || url.split('/').pop().replace(/_/g, ' ');
  
  return {
    game_id: gameId,
    name_en: name,
    icon_url: extractIcon(data),
    description: extractDescription(data),
    source_url: url,
  };
}

/**
 * Обновить предмет в Supabase
 */
async function upsertItem(item) {
  const url = `${SUPABASE_URL}/rest/v1/tli_game_items?game_id=eq.${item.game_id}`;
  
  // Сначала проверим существует ли
  const checkRes = await httpGet(url + '&select=game_id,name_en');
  
  const payload = {
    game_id: item.game_id,
    name_en: item.name_en,
    icon_url: item.icon_url,
  };
  
  // Используем upsert через POST с on_conflict
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    const reqUrl = new URL(`${SUPABASE_URL}/rest/v1/tli_game_items`);
    
    const options = {
      hostname: reqUrl.hostname,
      path: reqUrl.pathname + '?on_conflict=game_id',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Prefer': 'resolution=merge-duplicates',
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Главная функция
 */
async function main() {
  console.log('🔥 TLI Database Sync');
  console.log('='.repeat(60));
  console.log('Синхронизация tlidb.com → Supabase\n');
  
  // Категории для парсинга
  const categories = [
    '/en/Inventory',  // Stash/инвентарь
    '/en/Drop_Source', // Источники дропа
  ];
  
  const allItems = [];
  const processedIds = new Set();
  
  // Собираем ссылки на предметы
  for (const cat of categories) {
    const links = await getItemLinksFromCategory(TLIDB_BASE + cat);
    console.log(`  Найдено ${links.length} ссылок\n`);
    
    for (const link of links.slice(0, 50)) { // Ограничим для теста
      await delay(DELAY_MS);
      
      const item = await parseItemPage(link);
      if (item && !processedIds.has(item.game_id)) {
        processedIds.add(item.game_id);
        allItems.push(item);
        console.log(`  ✅ ${item.game_id}: ${item.name_en}`);
      }
    }
  }
  
  console.log(`\n📊 Найдено ${allItems.length} предметов с game_id\n`);
  
  // Обновляем в Supabase
  console.log('💾 Обновление Supabase...\n');
  
  let updated = 0;
  for (const item of allItems) {
    try {
      const res = await upsertItem(item);
      if (res.status === 201 || res.status === 200) {
        updated++;
        console.log(`  ✅ ${item.game_id}: ${item.name_en}`);
      } else {
        console.log(`  ⚠️ ${item.game_id}: status ${res.status}`);
      }
    } catch (e) {
      console.log(`  ❌ ${item.game_id}: ${e.message}`);
    }
    await delay(100);
  }
  
  console.log(`\n✨ Обновлено ${updated} предметов!`);
}

// Запуск
main().catch(console.error);
