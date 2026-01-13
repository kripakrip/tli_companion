//! Глобальное состояние приложения TLI Companion
//! 
//! Управляет состоянием сессии фарма, кэшем предметов и настройками.

use std::collections::HashMap;
use tokio::sync::RwLock;
use chrono::{DateTime, Utc};
use log::{info, debug};
use std::sync::{Arc, Mutex};
use std::sync::atomic::AtomicBool;

use crate::types::{
    AppSettings, FarmSessionState, ItemInfo, SessionStats, 
    ItemDropEvent, MapChangeEvent, MapEventType, AggregatedDrop, ExpenseEntry, ManualDropEntry
};
use crate::log_parser::LogParser;
use crate::persistence;
use crate::auth::{AuthSession};

/// Глобальное состояние приложения
pub struct AppState {
    /// Настройки приложения
    pub settings: RwLock<AppSettings>,
    /// Текущая сессия фарма
    pub session: RwLock<FarmSessionState>,
    /// Кэш информации о предметах (game_id -> ItemInfo)
    pub items_cache: RwLock<HashMap<i64, ItemInfo>>,
    /// Кэш текущих цен (game_id -> price)
    pub prices_cache: RwLock<HashMap<i64, persistence::PersistedPriceEntry>>,
    /// Флаг подключения к серверу (зарезервировано для будущего)
    #[allow(dead_code)]
    pub is_connected: RwLock<bool>,
    /// Путь к файлу логов
    pub log_path: RwLock<Option<String>>,
    /// Auth session (access token in-memory)
    pub auth_session: RwLock<Option<AuthSession>>,
    /// Cancel flag for in-progress OAuth login
    pub auth_oauth_cancel: RwLock<Option<Arc<AtomicBool>>>,
    /// Общий парсер логов (нужен, чтобы сбрасывать кэш слотов при старте сессии)
    #[allow(dead_code)]
    pub log_parser: Arc<Mutex<LogParser>>,
    /// Флаг паузы сессии — если true, дропы не записываются
    pub is_paused: RwLock<bool>,
}

const PRICE_TTL_SEC: i64 = 60 * 60; // 1 hour

impl AppState {
    /// Создать новое состояние
    pub fn new(log_parser: Arc<Mutex<LogParser>>) -> Self {
        Self {
            settings: RwLock::new(AppSettings::default()),
            session: RwLock::new(FarmSessionState::default()),
            items_cache: RwLock::new(HashMap::new()),
            prices_cache: RwLock::new(HashMap::new()),
            is_connected: RwLock::new(false),
            log_path: RwLock::new(None),
            auth_session: RwLock::new(None),
            auth_oauth_cancel: RwLock::new(None),
            log_parser,
            is_paused: RwLock::new(false),
        }
    }

    pub async fn set_auth_session(&self, session: Option<AuthSession>) {
        let mut s = self.auth_session.write().await;
        *s = session;
    }

    pub async fn get_auth_email(&self) -> Option<String> {
        let s = self.auth_session.read().await;
        s.as_ref().and_then(|x| x.user_email.clone())
    }

    pub async fn get_auth_user_id(&self) -> Option<String> {
        let s = self.auth_session.read().await;
        s.as_ref().and_then(|x| x.user_id.clone())
    }

    pub async fn is_logged_in(&self) -> bool {
        let s = self.auth_session.read().await;
        s.is_some()
    }

    /// Получить валидный access token (refresh при необходимости).
    pub async fn get_valid_access_token(
        &self,
        http: &reqwest::Client,
        cfg: &crate::supabase_sync::SupabaseConfig,
    ) -> Option<String> {
        // fast-path
        {
            let s = self.auth_session.read().await;
            if let Some(sess) = s.as_ref() {
                if Utc::now() < sess.expires_at {
                    return Some(sess.access_token.clone());
                }
            }
        }

        // refresh-path (requires refresh token from keychain)
        let refresh = crate::auth::load_refresh_token().ok().flatten()?;
        match crate::auth::refresh_access_token(http, cfg, &refresh).await {
            Ok(new_sess) => {
                let token = new_sess.access_token.clone();
                self.set_auth_session(Some(new_sess)).await;
                Some(token)
            }
            Err(_) => {
                // если refresh не удался — сбрасываем сессию
                self.set_auth_session(None).await;
                None
            }
        }
    }

    pub async fn load_settings_from_disk(&self) {
        match persistence::load_settings() {
            Ok(Some(settings)) => {
                let mut s = self.settings.write().await;
                *s = settings;
                debug!("Loaded settings from disk");
            }
            Ok(None) => {}
            Err(e) => {
                debug!("Failed to load settings from disk: {}", e);
            }
        }
    }

    pub async fn save_settings_to_disk(&self) {
        let s = self.settings.read().await;
        if let Err(e) = persistence::save_settings(&s) {
            debug!("Failed to save settings to disk: {}", e);
        }
    }

    pub async fn resolve_supabase_config(&self) -> Option<crate::supabase_sync::SupabaseConfig> {
        // For distributed builds, defaults are embedded in code (public anon key).
        // For dev/CI, env can override.
        Some(crate::supabase_sync::SupabaseConfig::from_env_or_compile()?)
    }
    
    /// Начать новую сессию фарма
    pub async fn start_session(&self, preset_id: Option<String>) {
        // Сбрасываем паузу при начале новой сессии
        {
            let mut p = self.is_paused.write().await;
            *p = false;
        }
        
        let now = Utc::now();
        let mut session = self.session.write().await;
        *session = FarmSessionState {
            session_id: None,
            started_at: Some(now),
            maps_completed: 0,
            total_duration_sec: 0,
            is_on_map: false,
            current_map_started: None,
            last_map_event_type: None,
            last_map_event_ts: None,
            last_map_scene: None,
            drops: HashMap::new(),
            preset_id,
            is_paused: false,
            expenses: Vec::new(),
            manual_drops: Vec::new(),
            session_duration_sec: 0,
        };
        info!("Farm session started");
        // Auto-save session
        Self::save_session_internal(&session);
    }
    
    /// Загрузить сессию с диска (для восстановления после краша)
    pub async fn load_session_from_disk(&self) -> bool {
        match persistence::load_session() {
            Ok(Some(session)) => {
                info!("Restored session from disk, duration: {} sec, paused: {}", 
                    session.session_duration_sec, session.is_paused);
                // Восстанавливаем состояние паузы
                let was_paused = session.is_paused;
                {
                    let mut p = self.is_paused.write().await;
                    *p = was_paused;
                }
                
                let mut s = self.session.write().await;
                *s = session;
                info!("Restored session from disk, paused: {}", was_paused);
                true
            }
            Ok(None) => false,
            Err(e) => {
                debug!("Failed to load session from disk: {}", e);
                false
            }
        }
    }
    
    /// Внутренний helper для сохранения сессии
    fn save_session_internal(session: &FarmSessionState) {
        let _ = persistence::save_session(session);
    }
    
    /// Установить состояние паузы
    pub async fn set_paused(&self, paused: bool) {
        {
            let mut p = self.is_paused.write().await;
            *p = paused;
        }
        
        // Сохраняем состояние паузы в сессию на диск
        {
            let mut session = self.session.write().await;
            if session.started_at.is_some() {
                session.is_paused = paused;
                Self::save_session_internal(&session);
                info!("Session paused: {}", paused);
            }
        }
    }
    
    /// Обновить время сессии (вызывается фронтендом)
    pub async fn update_session_duration(&self, duration_sec: i32) {
        let mut session = self.session.write().await;
        if session.started_at.is_some() {
            session.session_duration_sec = duration_sec;
            Self::save_session_internal(&session);
        }
    }
    
    /// Проверить, на паузе ли сессия
    pub async fn is_paused(&self) -> bool {
        *self.is_paused.read().await
    }
    
    /// Добавить трату вручную
    pub async fn add_expense(&self, id: String, game_id: Option<i64>, name: String, name_ru: Option<String>, quantity: i32, price: f64) {
        let mut session = self.session.write().await;
        // Траты можно добавлять даже без активной сессии (пресет)
        session.expenses.push(ExpenseEntry {
            id,
            game_id,
            name,
            name_ru,
            quantity,
            price,
        });
        info!("Added expense: {} (game_id={:?}) x{} @ {}", 
            session.expenses.last().map(|e| &e.name).unwrap_or(&"?".to_string()), 
            game_id, quantity, price);
        // Auto-save if session is active
        if session.started_at.is_some() {
            Self::save_session_internal(&session);
        }
    }
    
    /// Удалить трату
    pub async fn remove_expense(&self, id: &str) {
        let mut session = self.session.write().await;
        session.expenses.retain(|e| e.id != id);
        info!("Removed expense: {}", id);
    }
    
    /// Получить список трат
    pub async fn get_expenses(&self) -> Vec<ExpenseEntry> {
        let session = self.session.read().await;
        session.expenses.clone()
    }
    
    /// Поиск предметов по названию (EN/RU)
    pub async fn search_items(&self, query: &str) -> Vec<ItemInfo> {
        let cache = self.items_cache.read().await;
        let q = query.to_lowercase();
        
        if q.is_empty() {
            // Return first 30 items if no query
            return cache.values().take(30).cloned().collect();
        }
        
        cache.values()
            .filter(|item| {
                item.name.to_lowercase().contains(&q) ||
                item.name_en.as_ref().map(|n| n.to_lowercase().contains(&q)).unwrap_or(false) ||
                item.name_ru.as_ref().map(|n| n.to_lowercase().contains(&q)).unwrap_or(false)
            })
            .take(50)
            .cloned()
            .collect()
    }
    
    /// Добавить ручной дроп (для уников/экипировки)
    pub async fn add_manual_drop(&self, id: String, game_id: Option<i64>, name: String, name_ru: Option<String>, quantity: i32, price: f64) {
        let mut session = self.session.write().await;
        // Ручной дроп можно добавлять только в активную сессию
        if session.started_at.is_some() {
            session.manual_drops.push(ManualDropEntry {
                id,
                game_id,
                name,
                name_ru,
                quantity,
                price,
            });
            info!("Added manual drop: {} (game_id={:?}) x{} @ {}", 
                session.manual_drops.last().map(|e| &e.name).unwrap_or(&"?".to_string()), 
                game_id, quantity, price);
            // Auto-save session
            Self::save_session_internal(&session);
        }
    }
    
    /// Удалить ручной дроп
    pub async fn remove_manual_drop(&self, id: &str) {
        let mut session = self.session.write().await;
        session.manual_drops.retain(|e| e.id != id);
        info!("Removed manual drop: {}", id);
    }
    
    /// Получить список ручного дропа
    pub async fn get_manual_drops(&self) -> Vec<ManualDropEntry> {
        let session = self.session.read().await;
        session.manual_drops.clone()
    }
    
    /// Завершить сессию
    pub async fn end_session(&self) -> FarmSessionState {
        // Сбрасываем паузу при завершении сессии
        {
            let mut p = self.is_paused.write().await;
            *p = false;
        }
        
        let session = self.session.read().await;
        let result = session.clone();
        drop(session);
        
        let mut session = self.session.write().await;
        *session = FarmSessionState::default();
        info!("Farm session ended");
        
        // Delete session file (normal end)
        let _ = persistence::delete_session();
        
        result
    }
    
    /// Обработать событие входа на карту (зарезервировано)
    #[allow(dead_code)]
    pub async fn handle_map_enter(&self, ts: DateTime<Utc>) {
        let mut session = self.session.write().await;
        if session.started_at.is_none() {
            return;
        }

        // Дедуп: если уже на карте — ничего не делаем
        if session.is_on_map {
            return;
        }
        session.is_on_map = true;
        session.current_map_started = Some(ts);
        debug!("Entered map");
    }
    
    /// Обработать событие выхода с карты (зарезервировано)
    #[allow(dead_code)]
    pub async fn handle_map_exit(&self, ts: DateTime<Utc>) {
        let mut session = self.session.write().await;
        if session.started_at.is_none() {
            return;
        }
        
        // Если EnterMap не был пойман (например, сессию начали уже внутри карты),
        // считаем, что карта началась в момент старта сессии.
        let map_started = session.current_map_started.or(session.started_at);

        // Увеличиваем счётчик карт всегда на ExitToHideout: это завершение карты по смыслу.
        session.maps_completed += 1;

        // Добавляем время карты к общему времени (map-only duration).
        if let Some(started) = map_started {
            let duration = (ts - started).num_seconds();
            if duration > 0 {
                session.total_duration_sec += duration as i32;
            }
        }
        
        session.is_on_map = false;
        session.current_map_started = None;
        debug!("Exited map, total maps: {}", session.maps_completed);
    }
    
    /// Обработать событие смены карты
    pub async fn handle_map_change(&self, event: &MapChangeEvent) {
        let mut session = self.session.write().await;
        if session.started_at.is_none() {
            return;
        }

        // 1) Жёсткая дедупликация: одинаковое событие по той же сцене, пришедшее почти сразу.
        if let (Some(last_ty), Some(last_ts), Some(last_scene)) = (
            &session.last_map_event_type,
            session.last_map_event_ts,
            &session.last_map_scene,
        ) {
            if last_ty == &event.event_type && last_scene == &event.scene_name {
                let dt = (event.timestamp - last_ts).num_seconds().abs();
                if dt <= 2 {
                    return;
                }
            }
        }

        // 2) Анти-дубль: два подряд Exit без Enter между ними — игнорируем второй и далее.
        if event.event_type == MapEventType::ExitToHideout
            && session.last_map_event_type == Some(MapEventType::ExitToHideout)
        {
            // Мы уже в “убежище” по логике сессии.
            session.last_map_event_ts = Some(event.timestamp);
            session.last_map_scene = Some(event.scene_name.clone());
            return;
        }

        match event.event_type {
            MapEventType::EnterMap => {
                if !session.is_on_map {
                    session.is_on_map = true;
                    session.current_map_started = Some(event.timestamp);
                }
            }
            MapEventType::ExitToHideout => {
                // Считаем карту завершённой. Если EnterMap не был пойман (старт сессии внутри карты),
                // считаем что карта началась в момент старта сессии.
                let map_started = session.current_map_started.or(session.started_at);
                session.maps_completed += 1;

                if let Some(started) = map_started {
                    let duration = (event.timestamp - started).num_seconds();
                    if duration > 0 {
                        session.total_duration_sec += duration as i32;
                    }
                }

                session.is_on_map = false;
                session.current_map_started = None;
            }
        }

        session.last_map_event_type = Some(event.event_type.clone());
        session.last_map_event_ts = Some(event.timestamp);
        session.last_map_scene = Some(event.scene_name.clone());
    }
    
    /// Добавить дроп
    /// Игнорирует предметы, которых нет в items_cache (неизвестные предметы)
    pub async fn add_drop(&self, event: &ItemDropEvent) {
        let session_guard = self.session.read().await;
        if session_guard.started_at.is_none() {
            return;
        }
        drop(session_guard);
        
        // Игнорируем дроп если сессия на паузе
        if self.is_paused().await {
            debug!("Ignoring drop while paused: game_id={}", event.game_id);
            return;
        }
        
        // Проверяем, есть ли предмет в нашей БД
        let items = self.items_cache.read().await;
        if !items.contains_key(&event.game_id) {
            debug!("Ignoring drop of unknown item: game_id={}", event.game_id);
            return;
        }
        drop(items);
        
        let mut session = self.session.write().await;
        // Повторная проверка после получения write lock
        if session.started_at.is_none() {
            return;
        }
        
        let current = session.drops.get(&event.game_id).copied().unwrap_or(0);
        session.drops.insert(event.game_id, current + event.quantity);
        
        debug!("Added drop: game_id={}, qty={}, total={}", 
               event.game_id, event.quantity, current + event.quantity);
        
        // Auto-save session
        Self::save_session_internal(&session);
    }
    
    /// Обновить цену предмета в кэше
    pub async fn update_price(&self, game_id: i64, price: f64) {
        // Проверяем, является ли предмет базовой валютой
        let items = self.items_cache.read().await;
        if let Some(item) = items.get(&game_id) {
            if item.is_base_currency {
                debug!("Skipping price update for base currency: game_id={}", game_id);
                return;
            }
        }
        drop(items);
        
        let mut prices = self.prices_cache.write().await;
        let now = Utc::now();
        prices.insert(game_id, persistence::PersistedPriceEntry { 
            price, 
            updated_at: now,
            is_current_league: true,  // Цена получена через прайсчек = текущая лига
            league_name: None,
        });
        debug!("Updated price: game_id={}, price={}", game_id, price);

        // Персистим на диск, чтобы цена переживала новую сессию/перезапуск.
        // Ошибки не фейлят приложение.
        let snapshot = prices.clone();
        drop(prices);
        if let Err(e) = persistence::save_prices_cache(&snapshot) {
            debug!("Failed to persist prices cache: {}", e);
        }
    }

    /// Загрузить кэш цен с диска (best-effort)
    pub async fn load_prices_cache_from_disk(&self) {
        match persistence::load_prices_cache() {
            Ok(map) => {
                let mut prices = self.prices_cache.write().await;
                // merge: не затираем уже обновлённые значения, если они есть
                for (k, v) in map {
                    prices.entry(k).or_insert(v);
                }
                debug!("Loaded prices cache from disk: {} items", prices.len());
            }
            Err(e) => {
                debug!("Failed to load prices cache: {}", e);
            }
        }
    }

    /// Слить remote цены (Supabase current prices) в локальный кэш.
    /// Не перетираем более свежие значения.
    pub async fn merge_remote_prices(&self, rows: Vec<(i64, f64, DateTime<Utc>)>) {
        let items = self.items_cache.read().await;
        let mut prices = self.prices_cache.write().await;
        let mut updated = 0usize;
        for (game_id, price, ts) in rows {
            // Не обновляем цену базовой валюты
            if let Some(item) = items.get(&game_id) {
                if item.is_base_currency {
                    continue;
                }
            }
            
            if !price.is_finite() || price <= 0.0 {
                continue;
            }
            let replace = match prices.get(&game_id) {
                None => true,
                Some(existing) => ts > existing.updated_at,
            };
            if replace {
                prices.insert(game_id, persistence::PersistedPriceEntry { 
                    price, 
                    updated_at: ts,
                    is_current_league: true,
                    league_name: None,
                });
                updated += 1;
            }
        }
        if updated > 0 {
            debug!("Merged remote prices: {} updated", updated);
        }
    }

    /// Слить remote цены с информацией о лиге (для fallback логики)
    pub async fn merge_prices_with_league(&self, rows: Vec<crate::supabase_sync::PriceWithLeague>) {
        let items = self.items_cache.read().await;
        let mut prices = self.prices_cache.write().await;
        let mut updated = 0usize;
        
        for row in rows {
            // Не обновляем цену базовой валюты
            if let Some(item) = items.get(&row.game_id) {
                if item.is_base_currency {
                    continue;
                }
            }
            
            if !row.price.is_finite() || row.price <= 0.0 {
                continue;
            }
            
            let replace = match prices.get(&row.game_id) {
                None => true,
                Some(existing) => {
                    // Заменяем если: новая дата свежее ИЛИ если существующая не текущей лиги а новая — текущей
                    row.last_updated > existing.updated_at || 
                    (!existing.is_current_league && row.is_current_league)
                }
            };
            
            if replace {
                prices.insert(row.game_id, persistence::PersistedPriceEntry { 
                    price: row.price, 
                    updated_at: row.last_updated,
                    is_current_league: row.is_current_league,
                    league_name: Some(row.league_name),
                });
                updated += 1;
            }
        }
        
        if updated > 0 {
            debug!("Merged prices with league info: {} updated", updated);
        }
    }

    fn is_price_stale_internal(entry: &persistence::PersistedPriceEntry) -> bool {
        (Utc::now() - entry.updated_at).num_seconds() > PRICE_TTL_SEC
    }

    /// Цена для расчётов (None если устарела)
    #[allow(dead_code)]
    pub async fn get_effective_price(&self, game_id: i64) -> Option<f64> {
        // Для базовой валюты всегда возвращаем 1.0 (цена никогда не устаревает)
        let items = self.items_cache.read().await;
        if let Some(item) = items.get(&game_id) {
            if item.is_base_currency {
                return Some(1.0);
            }
        }
        drop(items);
        
        let prices = self.prices_cache.read().await;
        let entry = prices.get(&game_id)?;
        if Self::is_price_stale_internal(entry) {
            return None;
        }
        Some(entry.price)
    }
    
    /// Получить цену предмета
    #[allow(dead_code)]
    pub async fn get_price(&self, game_id: i64) -> Option<f64> {
        let prices = self.prices_cache.read().await;
        prices.get(&game_id).map(|p| p.price)
    }
    
    /// Получить все кэшированные цены
    pub async fn get_all_prices(&self) -> HashMap<i64, f64> {
        let prices = self.prices_cache.read().await;
        prices.iter().map(|(k, v)| (*k, v.price)).collect()
    }
    
    /// Загрузить информацию о предметах в кэш
    pub async fn load_items_cache(&self, items: Vec<ItemInfo>) {
        let mut cache = self.items_cache.write().await;
        for item in items {
            cache.insert(item.game_id, item);
        }
        info!("Loaded {} items into cache", cache.len());
        drop(cache);
        
        // Инициализируем базовую валюту с ценой 1.0
        self.init_base_currency_price().await;
    }
    
    /// Инициализировать цену базовой валюты (всегда 1.0)
    async fn init_base_currency_price(&self) {
        let items = self.items_cache.read().await;
        let base_currency = items.values().find(|item| item.is_base_currency);
        
        if let Some(currency) = base_currency {
            let game_id = currency.game_id;
            drop(items);
            
            let mut prices = self.prices_cache.write().await;
            prices.insert(
                game_id,
                persistence::PersistedPriceEntry {
                    price: 1.0,
                    updated_at: Utc::now(),
                    is_current_league: true,
                    league_name: None,
                }
            );
            debug!("Initialized base currency price: game_id={}, price=1.0", game_id);
        }
    }
    
    /// Получить информацию о предмете
    pub async fn get_item_info(&self, game_id: i64) -> Option<ItemInfo> {
        let cache = self.items_cache.read().await;
        cache.get(&game_id).cloned()
    }
    
    /// Получить статистику сессии
    pub async fn get_session_stats(&self) -> SessionStats {
        let session = self.session.read().await;
        let items_cache = self.items_cache.read().await;
        let prices = self.prices_cache.read().await;
        
        let total_items: i32 = session.drops.values().sum();
        let unique_items = session.drops.len() as i32;
        
        // Вычисляем общую стоимость
        let mut total_value = 0.0;
        let mut stale_price_lines = 0i32;
        for (game_id, qty) in &session.drops {
            // Проверяем является ли предмет базовой валютой
            let is_base_currency = items_cache.get(game_id)
                .map(|i| i.is_base_currency)
                .unwrap_or(false);
            
            if is_base_currency {
                // Для базовой валюты цена всегда 1.0 и никогда не устаревает
                total_value += 1.0 * (*qty as f64);
            } else if let Some(price_entry) = prices.get(game_id) {
                // Доход считаем всегда (даже по устаревшим ценам), но помечаем что часть цен старые,
                // чтобы UI мог попросить пользователя обновить прайсчек.
                total_value += price_entry.price * (*qty as f64);
                if Self::is_price_stale_internal(price_entry) {
                    stale_price_lines += 1;
                }
            }
        }
        
        // Длительность сессии — просто значение из session_duration_sec
        // (обновляется фронтендом каждую секунду)
        let duration_sec = session.session_duration_sec;

        // Средняя длительность карты: используем map-only время (total_duration_sec).
        // Если карт ещё нет, но мы на карте — показываем время текущей карты как “среднее” (удобно для первой карты).
        let current_map_elapsed_sec = session
            .current_map_started
            .map(|started| (Utc::now() - started).num_seconds().max(0) as i32)
            .unwrap_or(0);

        let avg_map_duration_sec = if session.maps_completed > 0 {
            // round к ближайшей секунде (чтобы не было систематического занижения)
            ((session.total_duration_sec as f64) / (session.maps_completed as f64)).round() as i32
        } else if session.is_on_map && current_map_elapsed_sec > 0 {
            current_map_elapsed_sec
        } else {
            0
        };
        
        // Доход в час
        let hourly_profit = if duration_sec > 0 {
            total_value / (duration_sec as f64) * 3600.0
        } else {
            0.0
        };
        
        let maps_completed = session.maps_completed;
        
        // Освобождаем блокировки перед получением is_paused
        drop(session);
        drop(items_cache);
        drop(prices);
        
        // Получаем состояние паузы
        let is_paused = *self.is_paused.read().await;
        
        SessionStats {
            total_items,
            unique_items,
            total_value,
            maps_completed,
            duration_sec,
            avg_map_duration_sec,
            stale_price_lines,
            hourly_profit,
            is_paused,
        }
    }
    
    /// Получить агрегированные дропы для отображения
    pub async fn get_aggregated_drops(&self) -> Vec<AggregatedDrop> {
        let session = self.session.read().await;
        let items_cache = self.items_cache.read().await;
        let prices = self.prices_cache.read().await;
        
        let mut drops: Vec<AggregatedDrop> = session.drops.iter().map(|(game_id, qty)| {
            let item_info = items_cache.get(game_id).cloned();
            
            // Для базовой валюты цена всегда 1.0 и никогда не устаревает
            let is_base_currency = item_info.as_ref().map(|i| i.is_base_currency).unwrap_or(false);
            
            let (unit_price, price_updated_at, price_is_stale, is_previous_season, league_name) = if is_base_currency {
                (1.0, Some(Utc::now()), false, false, None)
            } else {
                match prices.get(game_id) {
                    Some(p) => (
                        p.price, 
                        Some(p.updated_at), 
                        Self::is_price_stale_internal(p),
                        !p.is_current_league,  // Если НЕ текущая лига = предыдущий сезон
                        p.league_name.clone(),
                    ),
                    None => (0.0, None, false, false, None),
                }
            };
            let total_value = unit_price * (*qty as f64);
            
            AggregatedDrop {
                game_id: *game_id,
                item_info,
                quantity: *qty,
                total_value,
                unit_price,
                price_updated_at,
                price_is_stale,
                is_previous_season,
                league_name,
            }
        }).collect();
        
        // Сортируем по стоимости (от большей к меньшей)
        drops.sort_by(|a, b| b.total_value.partial_cmp(&a.total_value).unwrap_or(std::cmp::Ordering::Equal));
        
        drops
    }
    
    /// Проверить, активна ли сессия
    pub async fn is_session_active(&self) -> bool {
        let session = self.session.read().await;
        session.started_at.is_some()
    }
    
    /// Установить путь к логам (и сохранить в настройки)
    pub async fn set_log_path(&self, path: Option<String>) {
        let mut log_path = self.log_path.write().await;
        *log_path = path.clone();
        
        // Сохраняем в настройки для персистентности
        let mut settings = self.settings.write().await;
        settings.custom_log_path = path;
        if let Err(e) = persistence::save_settings(&settings) {
            log::warn!("Failed to save settings with custom log path: {}", e);
        }
    }
    
    /// Получить путь к логам
    pub async fn get_log_path(&self) -> Option<String> {
        let log_path = self.log_path.read().await;
        log_path.clone()
    }
    
    /// Получить custom_log_path из настроек
    pub async fn get_custom_log_path(&self) -> Option<String> {
        let settings = self.settings.read().await;
        settings.custom_log_path.clone()
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new(Arc::new(Mutex::new(LogParser::new())))
    }
}
