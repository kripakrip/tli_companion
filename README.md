# TLI Companion

Desktop-приложение для автоматического трекинга фарма в **Torchlight Infinite**.

## Возможности

- 🎯 **Автоматический подсчёт дропа** из логов игры
- 💰 **Отслеживание цен** с аукциона в реальном времени
- ⏱️ **Таймер карт** и расчёт дохода в час
- 🔄 **Синхронизация** с kripika.com

---

## 📦 Какие предметы отслеживаются

Приложение **автоматически** отслеживает только предметы с **фиксированной ценой** — те, у которых нет вариации статов и цена стабильна для всех экземпляров.

### ✅ Отслеживаются автоматически (~330 предметов)

| Категория | Примеры | Кол-во |
|-----------|---------|--------|
| **Currency (Валюта)** | Flame Elementium, Flame Sand, Netherrealm Resonance | 6 |
| **Compass (Компасы)** | Aeterna Compass, Arcana Compass, Outlaw Compass | 81 |
| **Precise Support Skills** | Precise: Seal Conversion, Precise: Selfless | 41 |
| **Cube Material (Куб благодати)** | Divinity Fragment, Divinity Stone, Divinity Pact, Unifying Wedge | 38 |
| **Fluorescent Memory (Флуоресценты)** | Crow's Wail, Prism's Echo, Divine Supernova | 36 |
| **Activation Medium (Эфиры)** | Activation Medium: Boss, Activation Medium: Critical Strike | 27 |
| **Boss Tickets (Билеты на боссов)** | The Beginning, The End, Queen's Grace, Void Sea Invitation | 19 |
| **Map Tickets (Маяки)** | Deep Space Beacon, Glacial Abyss Beacon T7/T8 | 11 |
| **Tower Material (Башня)** | Base Mod, Expansion Mod, TOWER Token | 11 |
| **Gameplay Tickets** | Aeterna Reverberation, Proof of the Brave I-V, Mist Essence | 10 |
| **Aromatic Material (Ароматы)** | Sage Lv. 1, Golden Iris Lv. 6, Stygian Benzoin Lv. 9 | 9 |
| **Special Items** | Pages of Aeterna, Twin Reflection, Star Net | 9 |
| **Equipment Material** | Sacred Fossil, Fine Ember, Ultimate Ember, Energy Core | 7 |
| **Memory Material** | Memory Scrap, Memory Thread, Memory of Origin | 7 |
| **Divine Emblem (Эмблемы)** | Divinity Emblem - War, Divinity Emblem - Machine | 4 |
| **Erosion Material** | Aemberon Core, Corrupted Axis, Familiar Nexus | 4 |
| **Dream Material** | Shallow Dream Talking - Weapon/Armor/Trinket | 3 |
| **Overlap Material** | Prism Gauge - Rare/Legendary | 2 |
| **Destiny Material** | Wandering Star | 1 |

### ❌ НЕ отслеживаются автоматически

| Категория | Причина |
|-----------|---------|
| **Equipment (Экипировка)** | Цена зависит от статов — один предмет может стоить 1 FE или 100,000 FE |
| **Legendary/Epic Gear** | Ценность определяется аффиксами, не типом предмета |
| **Hero Relics** | Разные роллы = разная цена |
| **Talent Cards** | Цена зависит от редкости и уровня |

### ⚠️ Ограничения подсчёта

> **Важно:** При первом подборе предмета в сессии количество записывается как **1 штука**, 
> даже если на самом деле выпало больше (например, стак валюты).
> Это ограничение связано с тем, какие данные официально доступны в логах игры —
> логи фиксируют только факт подбора предмета, но не его количество.
> 
> Это лучшее, что можно сделать с доступными данными.

### 🖐️ Ручной ввод

Для предметов, которые не отслеживаются автоматически:
1. Используйте кнопку **"Add Drop"** (в разработке)
2. Укажите предмет и его реальную цену продажи
3. Дроп добавится к статистике сессии

> **Почему так?** Невозможно автоматически определить цену предмета со статами — 
> один и тот же `game_id` может стоить от 1 до 100,000 FE в зависимости от аффиксов.
> Автоматическая оценка таких предметов вводила бы в заблуждение.

---

## Требования

- **Rust** 1.70+ (для сборки)
- **Node.js** 18+ (для frontend)
- **Torchlight Infinite** с включёнными логами

### Включение логов в игре

1. Запустите игру
2. Нажмите **ESC** для открытия меню
3. Перейдите в раздел **Other**
4. Нажмите кнопку **Enable Log**

Логи будут записываться в:
```
[Steam Path]/steamapps/common/Torchlight Infinite/UE_game/TorchLight/Saved/Logs/UE_game.log
```

## Разработка

```bash
# Установка зависимостей
npm install

# Запуск в режиме разработки
npm run tauri dev

# Сборка release версии
npm run tauri build
```

## Архитектура

```
tli-companion/
├── src/                    # React frontend
│   ├── App.tsx            # Главный компонент
│   └── styles.css         # Глобальные стили
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── main.rs        # Точка входа
│   │   ├── log_parser.rs  # Парсер логов
│   │   ├── file_watcher.rs # Отслеживание файлов
│   │   ├── state.rs       # Состояние приложения
│   │   ├── commands.rs    # IPC команды
│   │   └── types.rs       # Типы данных
│   └── Cargo.toml         # Зависимости Rust
└── package.json           # Зависимости JS
```

## IPC Commands

### Из JavaScript в Rust

```typescript
// Найти путь к логам автоматически
const path = await invoke<string | null>("find_log_file");

// Начать сессию
await invoke("start_session", { presetId: "some-preset-id" });

// Получить статистику
const stats = await invoke<SessionStats>("get_session_stats");

// Получить дропы
const drops = await invoke<AggregatedDrop[]>("get_drops");

// Завершить сессию
const finalStats = await invoke<SessionStats>("end_session");
```

### События от Rust в JavaScript

```typescript
import { listen } from "@tauri-apps/api/event";

// Новый дроп
listen<ItemDropEvent>("item-drop", (event) => {
  console.log("Dropped:", event.payload);
});

// Обновление цен
listen<PriceSearchEvent>("price-update", (event) => {
  console.log("Price:", event.payload);
});

// Смена карты
listen<MapChangeEvent>("map-change", (event) => {
  console.log("Map:", event.payload);
});

// Обновление статистики
listen<SessionStats>("stats-update", (event) => {
  console.log("Stats:", event.payload);
});
```

## Лицензия

MIT
