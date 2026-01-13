//! Простая персистентность локальных кэшей (без базы/без supabase)
//!
//! Цель: чтобы цены, полученные из логов, переживали новые сессии и перезапуск приложения.
//! Безопасность: пишем только в data_local_dir()/tli-companion/, никаких произвольных путей.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::types::{AppSettings, FarmSessionState};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PricesCacheFile {
    pub version: u32,
    pub prices: HashMap<i64, PersistedPriceEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedPriceEntry {
    pub price: f64,
    pub updated_at: DateTime<Utc>,
    /// Если false — цена из предыдущего сезона (fallback)
    #[serde(default = "default_true")]
    pub is_current_league: bool,
    /// Название лиги (SS10, SS11, etc)
    #[serde(default)]
    pub league_name: Option<String>,
}

fn default_true() -> bool { true }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingsFile {
    pub version: u32,
    pub settings: AppSettings,
}

fn app_data_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join("tli-companion"))
}

fn prices_cache_path() -> Option<PathBuf> {
    app_data_dir().map(|d| d.join("prices_cache.json"))
}

fn settings_path() -> Option<PathBuf> {
    app_data_dir().map(|d| d.join("settings.json"))
}

fn session_path() -> Option<PathBuf> {
    app_data_dir().map(|d| d.join("active_session.json"))
}

pub fn load_prices_cache() -> io::Result<HashMap<i64, PersistedPriceEntry>> {
    let Some(path) = prices_cache_path() else {
        return Ok(HashMap::new());
    };
    if !path.exists() {
        return Ok(HashMap::new());
    }

    let data = fs::read_to_string(&path)?;
    // v2 format
    if let Ok(parsed) = serde_json::from_str::<PricesCacheFile>(&data) {
        return Ok(parsed.prices);
    }

    // v1 legacy: game_id -> price (without timestamp)
    let legacy: HashMap<i64, f64> = serde_json::from_str(&data).unwrap_or_default();
    let now = Utc::now();
    Ok(legacy
        .into_iter()
        .filter(|(_, p)| p.is_finite() && *p > 0.0)
        .map(|(k, p)| (k, PersistedPriceEntry { 
            price: p, 
            updated_at: now,
            is_current_league: true,
            league_name: None,
        }))
        .collect())
}

fn atomic_write(path: &Path, content: &str) -> io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;

    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, content)?;
    // Windows: rename поверх существующего может падать, поэтому сначала удаляем старый.
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(tmp, path)?;
    Ok(())
}

pub fn save_prices_cache(prices: &HashMap<i64, PersistedPriceEntry>) -> io::Result<()> {
    let Some(path) = prices_cache_path() else {
        return Ok(());
    };

    // Фильтруем мусорные значения (на всякий случай)
    let mut sanitized: HashMap<i64, PersistedPriceEntry> = HashMap::new();
    for (k, v) in prices {
        if v.price.is_finite() && v.price > 0.0 {
            sanitized.insert(*k, v.clone());
        }
    }

    let file = PricesCacheFile {
        version: 2,
        prices: sanitized,
    };
    let json = serde_json::to_string(&file).unwrap_or_else(|_| "{\"version\":1,\"prices\":{}}".to_string());
    atomic_write(&path, &json)
}

pub fn load_settings() -> io::Result<Option<AppSettings>> {
    let Some(path) = settings_path() else {
        return Ok(None);
    };
    if !path.exists() {
        return Ok(None);
    }

    let data = fs::read_to_string(&path)?;
    if let Ok(parsed) = serde_json::from_str::<SettingsFile>(&data) {
        return Ok(Some(parsed.settings));
    }

    // legacy: raw AppSettings without wrapper
    let legacy: AppSettings =
        serde_json::from_str(&data).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(Some(legacy))
}

pub fn save_settings(settings: &AppSettings) -> io::Result<()> {
    let Some(path) = settings_path() else {
        return Ok(());
    };

    let file = SettingsFile {
        version: 1,
        settings: settings.clone(),
    };
    let json =
        serde_json::to_string(&file).unwrap_or_else(|_| "{\"version\":1,\"settings\":{}}".to_string());
    atomic_write(&path, &json)
}

/// Load active session from disk (for recovery after crash/close)
pub fn load_session() -> io::Result<Option<FarmSessionState>> {
    let Some(path) = session_path() else {
        return Ok(None);
    };
    if !path.exists() {
        return Ok(None);
    }

    let data = fs::read_to_string(&path)?;
    let session: FarmSessionState = serde_json::from_str(&data)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    
    // Only return session if it was actually started
    if session.started_at.is_some() {
        Ok(Some(session))
    } else {
        Ok(None)
    }
}

/// Save active session to disk (for recovery)
pub fn save_session(session: &FarmSessionState) -> io::Result<()> {
    let Some(path) = session_path() else {
        return Ok(());
    };

    let json = serde_json::to_string(session)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    atomic_write(&path, &json)
}

/// Delete session file (when session ends normally)
pub fn delete_session() -> io::Result<()> {
    let Some(path) = session_path() else {
        return Ok(());
    };
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Session History (local storage per user)
// ─────────────────────────────────────────────────────────────────────────────

/// Completed session record for history
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionHistoryRecord {
    pub id: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: DateTime<Utc>,
    pub maps_completed: i32,
    pub total_duration_sec: i32,
    pub total_profit: f64,
    pub total_expenses: f64,
    pub total_income: f64,
    /// Remote ID in Supabase (if synced)
    pub remote_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionHistoryFile {
    version: u32,
    sessions: Vec<SessionHistoryRecord>,
}

fn session_history_path(user_id: &str) -> Option<PathBuf> {
    // Sanitize user_id for filename (remove special chars)
    let safe_id: String = user_id.chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    app_data_dir().map(|d| d.join(format!("sessions_{}.json", safe_id)))
}

/// Load session history for user
pub fn load_session_history(user_id: &str) -> io::Result<Vec<SessionHistoryRecord>> {
    let Some(path) = session_history_path(user_id) else {
        return Ok(Vec::new());
    };
    if !path.exists() {
        return Ok(Vec::new());
    }

    let data = fs::read_to_string(&path)?;
    let file: SessionHistoryFile = serde_json::from_str(&data)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(file.sessions)
}

/// Save session history for user
pub fn save_session_history(user_id: &str, sessions: &[SessionHistoryRecord]) -> io::Result<()> {
    let Some(path) = session_history_path(user_id) else {
        return Ok(());
    };

    let file = SessionHistoryFile {
        version: 1,
        sessions: sessions.to_vec(),
    };
    let json = serde_json::to_string(&file)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    atomic_write(&path, &json)
}

/// Add a session to history
pub fn add_session_to_history(user_id: &str, session: SessionHistoryRecord) -> io::Result<()> {
    let mut sessions = load_session_history(user_id)?;
    sessions.insert(0, session); // Add at beginning (newest first)
    
    // Keep only last 100 sessions
    if sessions.len() > 100 {
        sessions.truncate(100);
    }
    
    save_session_history(user_id, &sessions)
}

/// Delete a session from history
pub fn delete_session_from_history(user_id: &str, session_id: &str) -> io::Result<Option<SessionHistoryRecord>> {
    let mut sessions = load_session_history(user_id)?;
    let removed = sessions.iter().position(|s| s.id == session_id)
        .map(|idx| sessions.remove(idx));
    
    if removed.is_some() {
        save_session_history(user_id, &sessions)?;
    }
    
    Ok(removed)
}
