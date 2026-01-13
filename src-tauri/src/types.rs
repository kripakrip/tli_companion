//! Типы данных для TLI Companion
//! 
//! Этот модуль содержит все основные типы данных, используемые
//! для парсинга логов и трекинга дропа.

use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

/// Событие подбора предмета из логов
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemDropEvent {
    /// ID предмета из игры (ConfigBaseId)
    pub game_id: i64,
    /// Количество подобранных предметов
    pub quantity: i32,
    /// Временная метка из лога
    pub timestamp: DateTime<Utc>,
    /// ID страницы инвентаря
    pub page_id: i32,
    /// ID слота
    pub slot_id: i32,
}

/// Событие оценки цены на аукционе
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceSearchEvent {
    /// ID предмета
    pub game_id: i64,
    /// Список цен из результатов поиска
    pub prices: Vec<f64>,
    /// ID валюты (обычно 100300 = Flame Elementium)
    pub currency_id: i64,
    /// Временная метка
    pub timestamp: DateTime<Utc>,
    /// Sync ID запроса
    pub sync_id: i32,
}

/// Событие входа/выхода с карты
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapChangeEvent {
    /// Тип события
    pub event_type: MapEventType,
    /// Название сцены
    pub scene_name: String,
    /// Временная метка
    pub timestamp: DateTime<Utc>,
}

/// Тип события карты
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum MapEventType {
    /// Вход на карту Netherrealm
    EnterMap,
    /// Выход с карты (возврат в убежище)
    ExitToHideout,
}

/// Информация о предмете для отображения
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemInfo {
    pub game_id: i64,
    /// Primary display name (English for now)
    pub name: String,
    pub name_en: Option<String>,
    pub name_ru: Option<String>,
    pub name_cn: Option<String>,
    pub category: String,
    pub icon_url: Option<String>,
    /// Флаг базовой валюты (её цена всегда = 1.0 и не может быть изменена)
    #[serde(default)]
    pub is_base_currency: bool,
}

/// Состояние текущей сессии фарма
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FarmSessionState {
    /// UUID сессии (если синхронизировано с сервером)
    pub session_id: Option<String>,
    /// Время начала сессии
    pub started_at: Option<DateTime<Utc>>,
    /// Количество завершённых карт
    pub maps_completed: i32,
    /// Общее время в секундах
    pub total_duration_sec: i32,
    /// Текущее состояние (на карте или нет)
    pub is_on_map: bool,
    /// Время входа на текущую карту
    pub current_map_started: Option<DateTime<Utc>>,
    /// Последнее событие смены карты (для дедупликации/анти-дублей)
    pub last_map_event_type: Option<MapEventType>,
    /// Время последнего события смены карты
    pub last_map_event_ts: Option<DateTime<Utc>>,
    /// Сцена последнего события (NextSceneName)
    pub last_map_scene: Option<String>,
    /// Дропы за сессию: game_id -> количество
    pub drops: std::collections::HashMap<i64, i32>,
    /// ID предустановки (если выбрана)
    pub preset_id: Option<String>,
    /// Сессия на паузе
    #[serde(default)]
    pub is_paused: bool,
    /// Траты за сессию (ручной ввод, пресет)
    #[serde(default)]
    pub expenses: Vec<ExpenseEntry>,
    /// Ручной дроп за сессию (для уников/экипировки)
    #[serde(default)]
    pub manual_drops: Vec<ManualDropEntry>,
    /// Общее время сессии в секундах (обновляется фронтендом)
    #[serde(default)]
    pub session_duration_sec: i32,
}

/// Запись о расходе (ручной ввод)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpenseEntry {
    /// Уникальный ID записи
    pub id: String,
    /// ID предмета из БД (если связан)
    #[serde(default)]
    pub game_id: Option<i64>,
    /// Название (EN или произвольный текст)
    pub name: String,
    /// Русское название (если связан с БД)
    #[serde(default)]
    pub name_ru: Option<String>,
    /// Количество
    pub quantity: i32,
    /// Цена за единицу (FE)
    pub price: f64,
}

/// Ручной дроп (для уников/экипировки)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManualDropEntry {
    /// Уникальный ID записи
    pub id: String,
    /// ID предмета из БД (если связан)
    #[serde(default)]
    pub game_id: Option<i64>,
    /// Название (EN или произвольный текст)
    pub name: String,
    /// Русское название (если связан с БД)
    #[serde(default)]
    pub name_ru: Option<String>,
    /// Количество
    pub quantity: i32,
    /// Цена продажи (FE)
    pub price: f64,
}

/// Агрегированный дроп для отображения
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregatedDrop {
    pub game_id: i64,
    pub item_info: Option<ItemInfo>,
    pub quantity: i32,
    pub total_value: f64,
    /// Цена за 1 штуку (последняя известная)
    pub unit_price: f64,
    /// Дата обновления цены (если известна)
    pub price_updated_at: Option<DateTime<Utc>>,
    /// Признак устаревшей цены (старше TTL)
    pub price_is_stale: bool,
    /// Цена из предыдущего сезона (нужен новый прайсчек)
    pub is_previous_season: bool,
    /// Название лиги откуда цена (SS10, SS11, etc)
    pub league_name: Option<String>,
}

/// Настройки приложения
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    /// Путь к файлу логов (если пользователь указал вручную)
    pub custom_log_path: Option<String>,
    /// Автозапуск при старте Windows
    #[serde(default)]
    pub auto_start: bool,
    /// Показывать в трее
    #[serde(default = "default_true")]
    pub minimize_to_tray: bool,
    /// Язык интерфейса (ru/en)
    #[serde(default = "default_language")]
    pub language: String,
    /// URL API сервера
    #[serde(default = "default_api_url")]
    pub api_url: String,
    /// Ориентация интерфейса: vertical / horizontal
    #[serde(default = "default_orientation")]
    pub layout_orientation: String,
    /// Направление выдвижных панелей: right/left (для vertical) или bottom/top (для horizontal)
    #[serde(default = "default_panel_direction")]
    pub panel_direction: String,
    /// Ставка комиссии аукциона (0.0 - 1.0), по умолчанию 0.125 (12.5%)
    #[serde(default = "default_auction_fee")]
    pub auction_fee_rate: f64,
    /// Прозрачность окна (0.5 - 1.0)
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    /// Всегда поверх окон
    #[serde(default = "default_true")]
    pub always_on_top: bool,
}

fn default_true() -> bool { true }
fn default_language() -> String { "ru".to_string() }
fn default_api_url() -> String { "https://www.kripika.com".to_string() }
fn default_orientation() -> String { "vertical".to_string() }
fn default_panel_direction() -> String { "right".to_string() }
fn default_auction_fee() -> f64 { 0.125 }
fn default_opacity() -> f64 { 1.0 }

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            custom_log_path: None,
            auto_start: false,
            minimize_to_tray: true,
            language: "ru".to_string(),
            api_url: "https://www.kripika.com".to_string(),
            layout_orientation: "vertical".to_string(),
            panel_direction: "right".to_string(),
            auction_fee_rate: 0.125,
            opacity: 1.0,
            always_on_top: true,
        }
    }
}

/// Результат парсинга лога
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum LogEvent {
    ItemDrop(ItemDropEvent),
    PriceSearch(PriceSearchEvent),
    MapChange(MapChangeEvent),
}

/// Статистика сессии для UI
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SessionStats {
    /// Всего предметов подобрано
    pub total_items: i32,
    /// Уникальных типов предметов
    pub unique_items: i32,
    /// Общая стоимость (расчётная)
    pub total_value: f64,
    /// Карт завершено
    pub maps_completed: i32,
    /// Время сессии в секундах
    pub duration_sec: i32,
    /// Среднее время на карту (сек). Если карт ещё нет, может показывать текущую карту (если мы на карте).
    pub avg_map_duration_sec: i32,
    /// Кол-во позиций дропа, у которых цена устарела (старше TTL)
    pub stale_price_lines: i32,
    /// Доход в час (расчётный)
    pub hourly_profit: f64,
    /// Сессия на паузе
    pub is_paused: bool,
}

/// Профиль пользователя kripika.com (public.profiles)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserProfile {
    pub id: String,
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub level: Option<i32>,
    pub total_xp: Option<i32>,
}
