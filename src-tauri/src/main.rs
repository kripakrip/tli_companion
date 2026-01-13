//! TLI Companion - Desktop приложение для трекинга фарма в Torchlight Infinite
//! 
//! Основные возможности:
//! - Автоматический подсчёт дропа из логов игры
//! - Отслеживание цен с аукциона
//! - Синхронизация с kripika.com
//! - Таймер карт и расчёт дохода в час

// Предотвращаем открытие консоли на Windows в release сборке
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod types;
mod log_parser;
mod file_watcher;
mod state;
mod commands;
mod persistence;
mod supabase_sync;
mod auth;
mod supabase_defaults;

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{Manager, Emitter};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState};
use log::{info, warn, error, debug, LevelFilter};
use env_logger::Builder;

use state::AppState;
use file_watcher::{find_log_path, LogWatcher};
use types::LogEvent;
use log_parser::LogParser;

// Rate limiting для crowd price upload
// Максимум 10 запросов в 60 секунд на пользователя
const PRICE_UPLOAD_RATE_LIMIT: u64 = 10;
const PRICE_UPLOAD_WINDOW_SEC: u64 = 60;

struct RateLimiter {
    window_start: AtomicU64,
    count: AtomicU64,
}

impl RateLimiter {
    fn new() -> Self {
        Self {
            window_start: AtomicU64::new(0),
            count: AtomicU64::new(0),
        }
    }
    
    fn check_and_increment(&self) -> bool {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        
        let window = self.window_start.load(Ordering::Relaxed);
        
        // Новое окно если прошло больше WINDOW секунд
        if now - window >= PRICE_UPLOAD_WINDOW_SEC {
            self.window_start.store(now, Ordering::Relaxed);
            self.count.store(1, Ordering::Relaxed);
            return true;
        }
        
        // Проверяем лимит
        let current = self.count.fetch_add(1, Ordering::Relaxed);
        current < PRICE_UPLOAD_RATE_LIMIT
    }
}

lazy_static::lazy_static! {
    static ref PRICE_RATE_LIMITER: RateLimiter = RateLimiter::new();
}

fn select_market_price(prices: &[f64]) -> Option<f64> {
    // В логах есть список unitPrices (обычно по одному значению на лот).
    // Явного объёма/кол-ва на каждой цене в сообщении мы не видим, поэтому
    // лучше брать низкий перцентиль вместо min, чтобы не ловить единичные манипуляции.
    let mut v: Vec<f64> = prices
        .iter()
        .copied()
        .filter(|p| p.is_finite() && *p > 0.0)
        .collect();
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    // p20: для маленьких выборок это фактически min, для больших — устойчивее.
    let idx = (((v.len() - 1) as f64) * 0.2).round() as usize;
    v.get(idx).copied()
}

fn main() {
    // Загружаем .env (dev convenience). В релизе переменные обычно прокидываются на этапе сборки/CI.
    // Важно: если файла нет — просто продолжаем.
    let _ = dotenvy::dotenv();
    // Удобно для локальной разработки: брать тот же .env, что и kripika-hub (если он есть).
    let _ = dotenvy::from_path("../kripika-hub/.env");

    // Инициализируем логирование
    Builder::new()
        .filter_level(LevelFilter::Info)
        .filter_module("tli_companion", LevelFilter::Debug)
        .init();
    
    info!("TLI Companion v{} starting...", env!("CARGO_PKG_VERSION"));
    
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            info!("Setting up application...");
            
            // Общий парсер: нужен и watcher'у, и командам (сброс кэша при старте сессии).
            let shared_parser = Arc::new(Mutex::new(LogParser::new()));

            // Создаём глобальное состояние
            let app_state = Arc::new(AppState::new(shared_parser.clone()));
            app.manage(app_state.clone());
            
            // Создаём меню для tray иконки
            let show_item = MenuItem::with_id(app, "show", "Показать", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            
            // Создаём tray иконку с меню
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            info!("Quit requested from tray menu");
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    // Клик левой кнопкой - показать окно
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            
            // Получаем handle для отправки событий в frontend
            let app_handle = app.handle().clone();
            
            // СИНХРОННАЯ инициализация: загрузка настроек, цен, и восстановление логина.
            // Это должно завершиться ДО того как UI начнёт делать запросы.
            let state_clone = app_state.clone();
            tauri::async_runtime::block_on(async {
                // Загружаем настройки (в т.ч. Supabase overrides) перед тем как запускать синк.
                state_clone.load_settings_from_disk().await;

                // Восстанавливаем кэш цен (чтобы цены сохранялись между сессиями и перезапусками).
                state_clone.load_prices_cache_from_disk().await;
                
                // Восстанавливаем активную сессию (если было аварийное закрытие)
                if state_clone.load_session_from_disk().await {
                    info!("Restored active session from previous run");
                }

                let http = reqwest::Client::new();
                let sb_cfg = state_clone.resolve_supabase_config().await;

                // Загружаем список предметов из Supabase
                if let Some(cfg) = sb_cfg.clone() {
                    match supabase_sync::fetch_game_items(&http, &cfg).await {
                        Ok(items) => {
                            info!("Loaded {} game items from Supabase", items.len());
                            state_clone.load_items_cache(items).await;
                        }
                        Err(e) => {
                            info!("Failed to load game items from Supabase: {}", e);
                        }
                    }
                }

                // Автовосстановление логина: если есть refresh token в keychain — поднимем access token.
                if let Some(cfg) = sb_cfg.clone() {
                    match crate::auth::load_refresh_token() {
                        Ok(Some(refresh)) => {
                            info!("Found refresh token in keychain, attempting auto-restore...");
                            match crate::auth::refresh_access_token(&http, &cfg, &refresh).await {
                                Ok(sess) => {
                                    info!("Auth auto-restore SUCCESS: user_id={:?}", sess.user_id);
                                    state_clone.set_auth_session(Some(sess)).await;
                                }
                                Err(e) => {
                                    info!("Auth auto-restore FAILED: {}", e);
                                }
                            }
                        }
                        Ok(None) => {
                            info!("No refresh token found in keychain (user not logged in before)");
                        }
                        Err(e) => {
                            info!("Error loading refresh token: {}", e);
                        }
                    }
                } else {
                    info!("Supabase config not available, skipping auto-restore");
                }
            });

            // Запускаем асинхронную инициализацию (фоновые задачи)
            let state_clone = app_state.clone();
            let sb_cfg = tauri::async_runtime::block_on(state_clone.resolve_supabase_config());
            tauri::async_runtime::spawn(async move {
                let http = reqwest::Client::new();

                // Периодический фоновый рефреш цен (каждую минуту) с поддержкой fallback на предыдущий сезон
                if let Some(_cfg) = sb_cfg.clone() {
                    let state_for_task = state_clone.clone();
                    let http_for_task = http.clone();
                    tauri::async_runtime::spawn(async move {
                        loop {
                            if let Some(cfg) = state_for_task.resolve_supabase_config().await {
                                // Используем новую функцию с fallback на предыдущий сезон
                                match supabase_sync::fetch_prices_with_fallback(&http_for_task, &cfg).await {
                                    Ok(rows) => {
                                        state_for_task.merge_prices_with_league(rows).await;
                                    }
                                    Err(e) => {
                                        debug!("Supabase fetch_prices_with_fallback error: {}", e);
                                        // Fallback на старый метод если новый не работает
                                        if let Ok(legacy_rows) = supabase_sync::fetch_current_prices(&http_for_task, &cfg).await {
                                            state_for_task.merge_remote_prices(legacy_rows).await;
                                        }
                                    }
                                }
                            }
                            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                        }
                    });
                }

                // Периодический фоновый рефреш списка предметов (каждые 5 минут)
                if let Some(_cfg) = sb_cfg.clone() {
                    let state_for_task = state_clone.clone();
                    let http_for_task = http.clone();
                    tauri::async_runtime::spawn(async move {
                        loop {
                            tokio::time::sleep(std::time::Duration::from_secs(300)).await; // 5 min
                            if let Some(cfg) = state_for_task.resolve_supabase_config().await {
                                match supabase_sync::fetch_game_items(&http_for_task, &cfg).await {
                                    Ok(items) => {
                                        debug!("Refreshed game items: {} items", items.len());
                                        state_for_task.load_items_cache(items).await;
                                    }
                                    Err(e) => {
                                        debug!("Supabase fetch_game_items error: {}", e);
                                    }
                                }
                            }
                        }
                    });
                }

                // Ищем файл логов: сначала проверяем custom_log_path из настроек
                let custom_path = state_clone.get_custom_log_path().await;
                let log_path_option = if let Some(custom) = custom_path {
                    let p = std::path::PathBuf::from(&custom);
                    if p.exists() {
                        info!("Using custom log path from settings: {}", custom);
                        Some(p)
                    } else {
                        warn!("Custom log path does not exist: {}, trying auto-detect", custom);
                        find_log_path()
                    }
                } else {
                    find_log_path()
                };
                
                if let Some(log_path) = log_path_option {
                    let path_str = log_path.to_string_lossy().to_string();
                    state_clone.set_log_path(Some(path_str.clone())).await;
                    
                    info!("Starting log watcher for: {}", path_str);
                    
                    // Создаём watcher
                    let watcher = LogWatcher::new(log_path, shared_parser.clone());
                    let mut rx = watcher.start();
                    
                    // Обрабатываем события из логов
                    while let Some(event) = rx.recv().await {
                        match &event {
                            LogEvent::ItemDrop(drop) => {
                                state_clone.add_drop(drop).await;
                                
                                // Отправляем событие в frontend
                                info!("Emitting item-drop event: game_id={}", drop.game_id);
                                if let Err(e) = app_handle.emit("item-drop", drop) {
                                    error!("Failed to emit item-drop event: {}", e);
                                }
                            }
                            LogEvent::PriceSearch(price) => {
                                if let Some(selected) = select_market_price(&price.prices) {
                                    state_clone.update_price(price.game_id, selected).await;

                                    // Crowd price upload (optional): если пользователь залогинен.
                                    // Rate limited: максимум 10 запросов в минуту
                                    if PRICE_RATE_LIMITER.check_and_increment() {
                                        if let Some(cfg) = sb_cfg.clone() {
                                            let jwt = state_clone.get_valid_access_token(&http, &cfg).await;
                                            if let Some(jwt) = jwt {
                                                let prices = price.prices.clone();
                                                let game_id = price.game_id;
                                                let currency_id = price.currency_id;
                                                let http2 = http.clone();
                                                tauri::async_runtime::spawn(async move {
                                                    if let Err(e) = supabase_sync::upsert_market_price(
                                                        &http2,
                                                        &cfg,
                                                        &jwt,
                                                        game_id,
                                                        &prices,
                                                        currency_id,
                                                    )
                                                    .await
                                                    {
                                                        debug!("Supabase upsert_market_price error: {}", e);
                                                    }
                                                });
                                            } 
                                        }
                                    } else {
                                        debug!("Price upload rate limited, skipping");
                                    }
                                }
                                
                                // Отправляем событие в frontend
                                if let Err(e) = app_handle.emit("price-update", price) {
                                    error!("Failed to emit price-update event: {}", e);
                                }
                            }
                            LogEvent::MapChange(map) => {
                                state_clone.handle_map_change(map).await;
                                
                                // Отправляем событие в frontend
                                if let Err(e) = app_handle.emit("map-change", map) {
                                    error!("Failed to emit map-change event: {}", e);
                                }
                            }
                        }
                        
                        // Отправляем обновлённую статистику
                        let stats = state_clone.get_session_stats().await;
                        info!("Emitting stats-update: items={}, maps={}", stats.total_items, stats.maps_completed);
                        if let Err(e) = app_handle.emit("stats-update", &stats) {
                            error!("Failed to emit stats-update event: {}", e);
                        }
                    }
                } else {
                    info!("Log file not found, waiting for manual configuration");
                    // Отправляем событие что нужно настроить путь
                    let _ = app_handle.emit("log-path-needed", ());
                }
            });
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::find_log_file,
            commands::set_log_path,
            commands::start_session,
            commands::set_paused,
            commands::update_session_duration,
            commands::add_expense,
            commands::remove_expense,
            commands::get_expenses,
            commands::search_items,
            commands::get_cached_prices,
            commands::add_manual_drop,
            commands::remove_manual_drop,
            commands::get_manual_drops,
            commands::end_session,
            commands::get_session_history,
            commands::delete_session_history,
            commands::get_session_stats,
            commands::get_drops,
            commands::is_session_active,
            commands::get_settings,
            commands::save_settings,
            commands::get_item_info,
            commands::load_items_cache,
            commands::update_item_price,
            commands::get_log_path,
            commands::check_log_status,
            commands::get_app_version,
            commands::open_url,
            commands::auth_status,
            commands::auth_sign_in_kripika,
            commands::auth_cancel_login,
            commands::auth_sign_out,
            commands::get_my_profile,
        ])
        .on_window_event(|window, event| {
            // При закрытии окна - полностью выходим из приложения
            // Это помогает корректно удалить tray иконку
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Не предотвращаем закрытие - просто выходим
                let _ = api;
                info!("Window close requested, exiting application");
                window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
