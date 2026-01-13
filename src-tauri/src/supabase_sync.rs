//! Supabase sync (prices, sessions)
//!
//! - Public read: fetch current prices from tli_current_prices (anon)
//! - Optional write: send raw samples to RPC upsert_market_price (requires user JWT)
//! - Session sync: upload farm sessions to tli_farm_sessions (requires user JWT)
//!
//! Config via env:
//! - VITE_SUPABASE_URL
//! - VITE_SUPABASE_ANON_KEY

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use crate::supabase_defaults;
use crate::types::{ItemInfo, FarmSessionState};

#[derive(Debug, Clone)]
pub struct SupabaseConfig {
    pub url: String,
    pub anon_key: String,
}

impl SupabaseConfig {
    pub fn from_env_or_compile() -> Option<Self> {
        let url = std::env::var("VITE_SUPABASE_URL")
            .ok()
            .or_else(|| option_env!("VITE_SUPABASE_URL").map(|s| s.to_string()))
            .unwrap_or_else(|| supabase_defaults::SUPABASE_URL.to_string());
        let anon_key = std::env::var("VITE_SUPABASE_ANON_KEY")
            .ok()
            .or_else(|| option_env!("VITE_SUPABASE_ANON_KEY").map(|s| s.to_string()))
            .unwrap_or_else(|| supabase_defaults::SUPABASE_ANON_KEY.to_string());
        Some(Self { url, anon_key })
    }
}

#[derive(Debug, Clone, Deserialize)]
struct CurrentPriceRow {
    game_id: i64,
    price: f64,
    last_updated: DateTime<Utc>,
}

/// Цена с информацией о лиге (для fallback логики)
#[derive(Debug, Clone, Deserialize)]
pub struct PriceWithLeague {
    pub game_id: i64,
    pub price: f64,
    pub last_updated: DateTime<Utc>,
    pub league_id: i32,
    pub league_name: String,
    pub is_current_league: bool,
}

/// Fetch current prices (legacy, без информации о лиге)
pub async fn fetch_current_prices(
    client: &reqwest::Client,
    cfg: &SupabaseConfig,
) -> Result<Vec<(i64, f64, DateTime<Utc>)>, String> {
    let endpoint = format!(
        "{}/rest/v1/tli_current_prices?select=game_id,price,last_updated",
        cfg.url.trim_end_matches('/')
    );

    let resp = client
        .get(endpoint)
        .header("apikey", &cfg.anon_key)
        .header("Authorization", format!("Bearer {}", cfg.anon_key))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Supabase fetch_current_prices failed: {}", resp.status()));
    }

    let rows: Vec<CurrentPriceRow> = resp.json().await.map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| (r.game_id, r.price, r.last_updated))
        .collect())
}

/// Fetch prices with fallback to previous season
/// Возвращает цены текущей лиги + цены предыдущей лиги для предметов без цены в текущей
pub async fn fetch_prices_with_fallback(
    client: &reqwest::Client,
    cfg: &SupabaseConfig,
) -> Result<Vec<PriceWithLeague>, String> {
    let endpoint = format!(
        "{}/rest/v1/rpc/get_prices_with_fallback",
        cfg.url.trim_end_matches('/')
    );

    let resp = client
        .post(&endpoint)
        .header("apikey", &cfg.anon_key)
        .header("Authorization", format!("Bearer {}", cfg.anon_key))
        .header("Content-Type", "application/json")
        .body("{}")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("fetch_prices_with_fallback failed: {} {}", status, text));
    }

    let rows: Vec<PriceWithLeague> = resp.json().await.map_err(|e| e.to_string())?;
    Ok(rows)
}

pub async fn upsert_market_price(
    client: &reqwest::Client,
    cfg: &SupabaseConfig,
    user_jwt: &str,
    game_id: i64,
    prices: &[f64],
    currency_id: i64,
) -> Result<(), String> {
    if prices.is_empty() {
        return Ok(());
    }

    let endpoint = format!(
        "{}/rest/v1/rpc/upsert_market_price",
        cfg.url.trim_end_matches('/')
    );

    let body = serde_json::json!({
        "p_game_id": game_id,
        "p_prices": prices,
        "p_currency_id": currency_id
    });

    let resp = client
        .post(endpoint)
        .header("apikey", &cfg.anon_key)
        .header("Authorization", format!("Bearer {}", user_jwt))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Supabase upsert_market_price failed: {} {}", status, text));
    }

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Game Items (names, categories, icons)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
struct GameItemRow {
    game_id: i64,
    name_en: Option<String>,
    name_ru: Option<String>,
    name_cn: Option<String>,
    category: Option<String>,
    icon_url: Option<String>,
    #[serde(default)]
    is_base_currency: bool,
}

/// Fetch all game items from Supabase (public read, anon key)
pub async fn fetch_game_items(
    client: &reqwest::Client,
    cfg: &SupabaseConfig,
) -> Result<Vec<ItemInfo>, String> {
    let endpoint = format!(
        "{}/rest/v1/tli_game_items?select=game_id,name_en,name_ru,name_cn,category,icon_url,is_base_currency",
        cfg.url.trim_end_matches('/')
    );

    let resp = client
        .get(endpoint)
        .header("apikey", &cfg.anon_key)
        .header("Authorization", format!("Bearer {}", cfg.anon_key))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Supabase fetch_game_items failed: {}", resp.status()));
    }

    let rows: Vec<GameItemRow> = resp.json().await.map_err(|e| e.to_string())?;
    
    Ok(rows
        .into_iter()
        .map(|r| ItemInfo {
            game_id: r.game_id,
            name: r.name_en.clone().unwrap_or_else(|| format!("ID: {}", r.game_id)),
            name_en: r.name_en,
            name_ru: r.name_ru,
            name_cn: r.name_cn,
            category: r.category.unwrap_or_else(|| "unknown".to_string()),
            icon_url: r.icon_url,
            is_base_currency: r.is_base_currency,
        })
        .collect())
}

// ─────────────────────────────────────────────────────────────────────────────
// Farm Sessions Sync
// ─────────────────────────────────────────────────────────────────────────────

/// Session data for upload to Supabase
#[derive(Debug, Clone, Serialize)]
struct SessionUpload {
    started_at: DateTime<Utc>,
    ended_at: DateTime<Utc>,
    maps_completed: i32,
    total_duration_sec: i32,
    total_profit_calculated: f64,
    expenses_calculated: f64,
    client_version: String,
    preset_id: Option<String>,
    drops_data: serde_json::Value,
}

/// Session history item returned from Supabase
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SessionHistoryItem {
    pub id: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub maps_completed: i32,
    pub total_duration_sec: i32,
    pub total_profit_calculated: Option<f64>,
    pub expenses_calculated: Option<f64>,
}

/// Sync completed session to Supabase
pub async fn sync_farm_session(
    client: &reqwest::Client,
    cfg: &SupabaseConfig,
    user_jwt: &str,
    user_id: &str,
    session: &FarmSessionState,
    total_profit: f64,
    total_expenses: f64,
    app_version: &str,
) -> Result<String, String> {
    let started_at = session.started_at.ok_or("Session has no start time")?;
    let ended_at = Utc::now();
    
    let endpoint = format!(
        "{}/rest/v1/tli_farm_sessions",
        cfg.url.trim_end_matches('/')
    );

    let body = serde_json::json!({
        "user_id": user_id,
        "started_at": started_at,
        "ended_at": ended_at,
        "maps_completed": session.maps_completed,
        "total_duration_sec": session.total_duration_sec,
        "total_profit_calculated": total_profit,
        "expenses_calculated": total_expenses,
        "client_version": app_version,
        "preset_id": session.preset_id,
        "sync_status": "synced"
    });

    let resp = client
        .post(&endpoint)
        .header("apikey", &cfg.anon_key)
        .header("Authorization", format!("Bearer {}", user_jwt))
        .header("Content-Type", "application/json")
        .header("Prefer", "return=representation")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("sync_farm_session failed: {} {}", status, text));
    }

    // Parse response to get session ID
    let result: Vec<serde_json::Value> = resp.json().await.map_err(|e| e.to_string())?;
    let session_id = result
        .first()
        .and_then(|r| r.get("id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    
    log::info!("Session synced to Supabase: {}", session_id);
    
    // Sync individual drops
    if !session.drops.is_empty() {
        let _ = sync_session_drops(client, cfg, user_jwt, &session_id, &session.drops).await;
    }
    
    Ok(session_id)
}

/// Sync session drops to tli_session_drops
async fn sync_session_drops(
    client: &reqwest::Client,
    cfg: &SupabaseConfig,
    user_jwt: &str,
    session_id: &str,
    drops: &std::collections::HashMap<i64, i32>,
) -> Result<(), String> {
    if drops.is_empty() {
        return Ok(());
    }
    
    let endpoint = format!(
        "{}/rest/v1/tli_session_drops",
        cfg.url.trim_end_matches('/')
    );
    
    let records: Vec<serde_json::Value> = drops
        .iter()
        .map(|(game_id, quantity)| {
            serde_json::json!({
                "session_id": session_id,
                "game_id": game_id,
                "quantity": quantity,
            })
        })
        .collect();

    let resp = client
        .post(&endpoint)
        .header("apikey", &cfg.anon_key)
        .header("Authorization", format!("Bearer {}", user_jwt))
        .header("Content-Type", "application/json")
        .json(&records)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("sync_session_drops failed: {} {}", status, text));
    }

    Ok(())
}

/// Fetch session history for current user
pub async fn fetch_session_history(
    client: &reqwest::Client,
    cfg: &SupabaseConfig,
    user_jwt: &str,
    limit: i32,
) -> Result<Vec<SessionHistoryItem>, String> {
    let endpoint = format!(
        "{}/rest/v1/tli_farm_sessions?select=id,started_at,ended_at,maps_completed,total_duration_sec,total_profit_calculated,expenses_calculated&order=started_at.desc&limit={}",
        cfg.url.trim_end_matches('/'),
        limit
    );

    let resp = client
        .get(&endpoint)
        .header("apikey", &cfg.anon_key)
        .header("Authorization", format!("Bearer {}", user_jwt))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("fetch_session_history failed: {} {}", status, text));
    }

    let sessions: Vec<SessionHistoryItem> = resp.json().await.map_err(|e| e.to_string())?;
    Ok(sessions)
}
