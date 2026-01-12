//! Supabase Auth integration (desktop)
//!
//! Security model:
//! - Supabase URL + anon key are PUBLIC (safe to ship in app).
//! - We NEVER ship service_role key.
//! - We store refresh token in OS keychain (via `keyring` crate).
//! - Access token is kept in memory and refreshed as needed.

use chrono::{DateTime, Duration, Utc};
use base64::Engine;
use log::{debug, warn};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use rand::RngCore;

use crate::supabase_sync::SupabaseConfig;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const KEYRING_SERVICE: &str = "tli-companion";
const KEYRING_USERNAME: &str = "supabase_refresh_token";
const TOKEN_FILE_NAME: &str = "auth_token.dat";

#[derive(Debug, Clone)]
pub struct AuthSession {
    pub access_token: String,
    pub expires_at: DateTime<Utc>,
    pub user_id: Option<String>,
    pub user_email: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct TokenResponseUser {
    id: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
    token_type: String,
    user: Option<TokenResponseUser>,
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USERNAME).map_err(|e| e.to_string())
}

/// Get the path to the token file in app data directory
fn token_file_path() -> Option<std::path::PathBuf> {
    dirs::data_local_dir().map(|p| p.join("com.kripika.tli-companion").join(TOKEN_FILE_NAME))
}

/// Simple obfuscation (not crypto-secure, but prevents casual reading)
fn obfuscate(data: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(data.as_bytes())
}

fn deobfuscate(data: &str) -> Option<String> {
    base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

pub fn store_refresh_token(token: &str) -> Result<(), String> {
    // Try keyring first
    log::debug!("Attempting to store refresh token in keyring...");
    let keyring_result = keyring_entry().and_then(|e| e.set_password(token).map_err(|e| e.to_string()));
    
    // Always also store to file as fallback
    if let Some(path) = token_file_path() {
        log::debug!("Storing refresh token to file: {:?}", path);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let obfuscated = obfuscate(token);
        if let Err(e) = std::fs::write(&path, &obfuscated) {
            log::error!("Failed to write token file: {}", e);
            // If keyring also failed, return error
            if keyring_result.is_err() {
                return Err(format!("Failed to store token: keyring and file both failed"));
            }
        } else {
            log::info!("Refresh token stored to file successfully");
        }
    }
    
    // Verify by reading back
    match load_refresh_token() {
        Ok(Some(loaded)) if loaded == token => {
            log::debug!("Verified: token read back matches");
            Ok(())
        }
        Ok(Some(_)) => {
            log::warn!("Token stored but read back different value");
            Ok(())
        }
        Ok(None) => {
            log::error!("Token stored but read back returned None");
            Err("Token verification failed".to_string())
        }
        Err(e) => {
            log::error!("Token stored but read back failed: {}", e);
            Err(format!("Token verification failed: {}", e))
        }
    }
}

pub fn load_refresh_token() -> Result<Option<String>, String> {
    // Try keyring first
    log::debug!("Attempting to load refresh token from keyring...");
    if let Ok(entry) = keyring_entry() {
        match entry.get_password() {
            Ok(v) if !v.trim().is_empty() => {
                log::debug!("Loaded token from keyring (length {})", v.len());
                return Ok(Some(v));
            }
            _ => {}
        }
    }
    
    // Fallback to file
    if let Some(path) = token_file_path() {
        log::debug!("Attempting to load refresh token from file: {:?}", path);
        if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(content) => {
                    if let Some(token) = deobfuscate(&content) {
                        if !token.is_empty() {
                            log::debug!("Loaded token from file (length {})", token.len());
                            return Ok(Some(token));
                        }
                    }
                }
                Err(e) => {
                    log::warn!("Failed to read token file: {}", e);
                }
            }
        }
    }
    
    log::debug!("No refresh token found");
    Ok(None)
}

pub fn clear_refresh_token() -> Result<(), String> {
    // Clear from keyring
    let _ = keyring_entry().and_then(|e| e.set_password("").map_err(|e| e.to_string()));
    
    // Clear from file
    if let Some(path) = token_file_path() {
        let _ = std::fs::remove_file(&path);
    }
    
    Ok(())
}

fn compute_expires_at(expires_in: i64) -> DateTime<Utc> {
    // небольшой запас, чтобы не словить race на границе истечения
    Utc::now() + Duration::seconds(expires_in.saturating_sub(30).max(0))
}

pub async fn sign_in_with_password(
    http: &reqwest::Client,
    cfg: &SupabaseConfig,
    email: &str,
    password: &str,
) -> Result<AuthSession, String> {
    let endpoint = format!(
        "{}/auth/v1/token?grant_type=password",
        cfg.url.trim_end_matches('/')
    );

    let body = serde_json::json!({
        "email": email,
        "password": password,
    });

    let resp = http
        .post(endpoint)
        .header("apikey", &cfg.anon_key)
        .header("Authorization", format!("Bearer {}", cfg.anon_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Auth sign-in failed: {} {}", status, text));
    }

    let tok: TokenResponse = resp.json().await.map_err(|e| e.to_string())?;
    if tok.token_type.to_lowercase() != "bearer" {
        warn!("Unexpected token_type: {}", tok.token_type);
    }

    store_refresh_token(&tok.refresh_token)?;
    debug!("Stored refresh token in keychain");

    Ok(AuthSession {
        access_token: tok.access_token,
        expires_at: compute_expires_at(tok.expires_in),
        user_id: tok.user.as_ref().and_then(|u| u.id.clone()),
        user_email: tok.user.and_then(|u| u.email),
    })
}

pub async fn refresh_access_token(
    http: &reqwest::Client,
    cfg: &SupabaseConfig,
    refresh_token: &str,
) -> Result<AuthSession, String> {
    let endpoint = format!(
        "{}/auth/v1/token?grant_type=refresh_token",
        cfg.url.trim_end_matches('/')
    );

    let body = serde_json::json!({
        "refresh_token": refresh_token
    });

    let resp = http
        .post(endpoint)
        .header("apikey", &cfg.anon_key)
        .header("Authorization", format!("Bearer {}", cfg.anon_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Auth refresh failed: {} {}", status, text));
    }

    let tok: TokenResponse = resp.json().await.map_err(|e| e.to_string())?;

    // Supabase обычно возвращает новый refresh_token — сохраняем его.
    store_refresh_token(&tok.refresh_token)?;
    debug!("Refreshed session and stored new refresh token");

    Ok(AuthSession {
        access_token: tok.access_token,
        expires_at: compute_expires_at(tok.expires_in),
        user_id: tok.user.as_ref().and_then(|u| u.id.clone()),
        user_email: tok.user.and_then(|u| u.email),
    })
}

fn base64url_no_pad(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn generate_pkce_pair() -> (String, String) {
    // RFC 7636: verifier length 43..128. Use 32 random bytes -> 43 chars base64url.
    let mut buf = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    let verifier = base64url_no_pad(&buf);
    let challenge = base64url_no_pad(&Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn generate_state() -> String {
    let mut buf = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    base64url_no_pad(&buf)
}

fn parse_query_param(url_path: &str, key: &str) -> Option<String> {
    // url_path example: "/auth/callback?code=...&state=..."
    let idx = url_path.find('?')?;
    let q = &url_path[idx + 1..];
    for part in q.split('&') {
        let mut it = part.splitn(2, '=');
        let k = it.next()?;
        let v = it.next().unwrap_or("");
        if k == key {
            // minimal percent-decoding for typical supabase codes (mostly URL-safe),
            // but handle '+' and %xx anyway.
            let v = v.replace('+', "%20");
            return urlencoding::decode(&v).ok().map(|s| s.to_string());
        }
    }
    None
}

// Порты для OAuth callback (пробуем несколько на случай блокировки)
const OAUTH_CALLBACK_PORTS: &[u16] = &[49733, 49734, 49735, 49736, 49737];

fn bind_localhost_callback() -> Result<(std::net::TcpListener, u16), String> {
    // Пробуем несколько портов на случай блокировки firewall
    for &port in OAUTH_CALLBACK_PORTS {
        match std::net::TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => {
                if let Err(e) = listener.set_nonblocking(true) {
                    log::warn!("Failed to set nonblocking on port {}: {}", port, e);
                    continue;
                }
                log::info!("OAuth callback listener bound to port {}", port);
                return Ok((listener, port));
            }
            Err(e) => {
                log::warn!("Cannot bind port {}: {} (kind: {:?})", port, e, e.kind());
                // Продолжаем пробовать другие порты
            }
        }
    }
    
    // Если ни один порт не подошёл
    Err(
        "Не удалось открыть порт для авторизации. \
        Возможные причины:\n\
        • Windows Firewall блокирует приложение\n\
        • Антивирус блокирует сетевой доступ\n\n\
        Решение: добавьте TLI Companion в исключения брандмауэра \
        или запустите приложение от имени администратора.".to_string()
    )
}

async fn wait_for_localhost_callback(
    listener: std::net::TcpListener,
    expected_state: &str,
    cancel: Arc<AtomicBool>,
) -> Result<String, String> {

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("OAuth cancelled".to_string());
        }
        if std::time::Instant::now() > deadline {
            return Err("OAuth timeout (no callback received)".to_string());
        }
        match listener.accept() {
            Ok((mut stream, _addr)) => {
                use std::io::{Read, Write};
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let first = req.lines().next().unwrap_or("");
                // "GET /auth/callback?code=... HTTP/1.1"
                let mut parts = first.split_whitespace();
                let _method = parts.next().unwrap_or("");
                let path = parts.next().unwrap_or("");

                let state = parse_query_param(path, "state").unwrap_or_default();
                let code = parse_query_param(path, "code");

                let (status, body) = if state != expected_state {
                    (
                        "400 Bad Request",
                        "<h3>Invalid state. You can close this window.</h3>".to_string(),
                    )
                } else if let Some(_code) = code {
                    (
                        "200 OK",
                        "<h3>Login complete. You can close this window and return to TLI Companion.</h3>".to_string(),
                    )
                } else {
                    (
                        "400 Bad Request",
                        "<h3>Missing code. You can close this window.</h3>".to_string(),
                    )
                };

                let resp = format!(
                    "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<!doctype html><html><body>{}</body></html>",
                    status, body
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();

                if status.starts_with("200") {
                    // safe unwrap: if 200 then code exists above
                    return Ok(parse_query_param(path, "code").unwrap());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Simplified callback listener that doesn't verify state (PKCE provides security).
async fn wait_for_localhost_callback_no_state(
    listener: std::net::TcpListener,
    cancel: Arc<AtomicBool>,
) -> Result<String, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("OAuth cancelled".to_string());
        }
        if std::time::Instant::now() > deadline {
            return Err("OAuth timeout (no callback received)".to_string());
        }
        match listener.accept() {
            Ok((mut stream, _addr)) => {
                use std::io::{Read, Write};
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let first = req.lines().next().unwrap_or("");
                let mut parts = first.split_whitespace();
                let _method = parts.next().unwrap_or("");
                let path = parts.next().unwrap_or("");

                let code = parse_query_param(path, "code");
                let error = parse_query_param(path, "error");
                let error_desc = parse_query_param(path, "error_description")
                    .unwrap_or_default();

                let (status, title, message, icon, result) = if error.is_some() {
                    (
                        "400 Bad Request",
                        "Ошибка входа",
                        format!("{}: {}", error.as_deref().unwrap_or("Ошибка"), &error_desc),
                        "✕",
                        Err(format!("OAuth error: {}", error_desc)),
                    )
                } else if let Some(c) = code {
                    (
                        "200 OK",
                        "Вход выполнен!",
                        "Можете закрыть эту страницу и вернуться в TLI Companion.".to_string(),
                        "✓",
                        Ok(c),
                    )
                } else {
                    (
                        "400 Bad Request",
                        "Ошибка",
                        "Отсутствует код авторизации.".to_string(),
                        "✕",
                        Err("Missing code in callback".to_string()),
                    )
                };

                let is_success = status.starts_with("200");
                let accent = if is_success { "#c9a227" } else { "#e74c3c" };
                
                let html = format!(r#"<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{} — TLI Companion</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            font-family: 'Segoe UI', system-ui, sans-serif;
            background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 50%, #16213e 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #e0e0e0;
        }}
        .container {{
            text-align: center;
            padding: 3rem;
            background: rgba(20, 20, 30, 0.9);
            border-radius: 16px;
            border: 1px solid rgba(201, 162, 39, 0.2);
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
            max-width: 420px;
        }}
        .icon {{
            width: 80px;
            height: 80px;
            border-radius: 50%;
            background: {};
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 1.5rem;
            font-size: 2.5rem;
            color: #0a0a0f;
            font-weight: bold;
        }}
        .brand {{
            font-size: 0.9rem;
            color: #c9a227;
            letter-spacing: 0.3em;
            text-transform: uppercase;
            margin-bottom: 0.5rem;
        }}
        h1 {{
            font-size: 1.8rem;
            font-weight: 300;
            margin-bottom: 1rem;
            color: #fff;
        }}
        p {{
            color: #a0a0a0;
            line-height: 1.6;
        }}
        .footer {{
            margin-top: 2rem;
            padding-top: 1.5rem;
            border-top: 1px solid rgba(255,255,255,0.1);
            font-size: 0.85rem;
            color: #666;
        }}
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">{}</div>
        <div class="brand">Kripika</div>
        <h1>{}</h1>
        <p>{}</p>
        <div class="footer">TLI Companion</div>
    </div>
</body>
</html>"#, title, accent, icon, title, message);

                let resp = format!(
                    "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n{}",
                    status, html
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();

                return result;
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Direct Supabase OAuth with PKCE — no website proxy, more reliable.
pub async fn sign_in_via_kripika(
    http: &reqwest::Client,
    cfg: &SupabaseConfig,
    _kripika_origin: &str, // kept for API compat, not used
    cancel: Arc<AtomicBool>,
) -> Result<AuthSession, String> {
    let (verifier, challenge) = generate_pkce_pair();

    // Bind callback listener BEFORE opening browser to avoid race.
    // Returns (listener, port) - port may vary if firewall blocks some.
    let (listener, port) = bind_localhost_callback()?;
    
    // Build redirect URI with the actual bound port
    let redirect_uri = format!("http://127.0.0.1:{}/auth/callback", port);

    // Direct Supabase OAuth URL with PKCE. Supabase will redirect to our localhost listener.
    // IMPORTANT: All possible ports (49733-49737) must be in Supabase's allowed Redirect URLs.
    // NOTE: We don't pass our own `state` - Supabase manages state internally for the OAuth
    // flow with Discord. PKCE (code_verifier) provides cryptographic security.
    let authorize_url = format!(
        "{}/auth/v1/authorize?provider=discord&redirect_to={}&code_challenge={}&code_challenge_method=s256",
        cfg.url.trim_end_matches('/'),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(&challenge),
    );

    open::that(&authorize_url).map_err(|e| e.to_string())?;

    // Accept any state from Supabase callback (we verify via PKCE code_verifier instead)
    let code = wait_for_localhost_callback_no_state(listener, cancel).await?;

    // Exchange code for session (PKCE)
    let endpoint = format!(
        "{}/auth/v1/token?grant_type=pkce",
        cfg.url.trim_end_matches('/')
    );

    let body = serde_json::json!({
        "auth_code": code,
        "code_verifier": verifier
    });

    let resp = http
        .post(endpoint)
        .header("apikey", &cfg.anon_key)
        .header("Authorization", format!("Bearer {}", cfg.anon_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("OAuth token exchange failed: {} {}", status, text));
    }

    let tok: TokenResponse = resp.json().await.map_err(|e| e.to_string())?;
    log::info!("OAuth token exchange successful, storing refresh token...");
    match store_refresh_token(&tok.refresh_token) {
        Ok(()) => log::info!("Refresh token stored successfully in keychain"),
        Err(e) => {
            log::error!("Failed to store refresh token in keychain: {}", e);
            return Err(format!("Failed to store refresh token: {}", e));
        }
    }
    Ok(AuthSession {
        access_token: tok.access_token,
        expires_at: compute_expires_at(tok.expires_in),
        user_id: tok.user.as_ref().and_then(|u| u.id.clone()),
        user_email: tok.user.and_then(|u| u.email),
    })
}
