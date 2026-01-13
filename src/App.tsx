import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import "./App.css";
import { getItemName, isKnownItem } from "./itemsData";

// Типы данных
interface SessionStats {
  total_items: number;
  unique_items: number;
  total_value: number;
  maps_completed: number;
  duration_sec: number;
  avg_map_duration_sec: number;
  stale_price_lines: number;
  hourly_profit: number;
  is_paused: boolean;
}

interface ItemInfo {
  game_id: number;
  name: string;
  name_en: string | null;
  name_ru: string | null;
  name_cn: string | null;
  category: string;
  icon_url: string | null;
}

interface AggregatedDrop {
  game_id: number;
  item_info: ItemInfo | null;
  quantity: number;
  total_value: number;
  unit_price: number;
  price_updated_at: string | null;
  price_is_stale: boolean;
  /** Цена из предыдущего сезона (нужен новый прайсчек) */
  is_previous_season: boolean;
  /** Название лиги откуда цена */
  league_name: string | null;
}

interface ItemDropEvent {
  game_id: number;
  quantity: number;
  timestamp: string;
}

interface AuthStatus {
  is_logged_in: boolean;
  email: string | null;
}

interface UserProfile {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  level: number | null;
  total_xp: number | null;
}

function App() {
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [drops, setDrops] = useState<AggregatedDrop[]>([]);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [logPath, setLogPath] = useState<string | null>(null);
  const [version, setVersion] = useState("");
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [showAuth, setShowAuth] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  
  // Auto-update state
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);

  // Загружаем начальные данные
  useEffect(() => {
    async function init() {
      try {
        // Получаем версию
        const ver = await invoke<string>("get_app_version");
        setVersion(ver);

        // Проверяем путь к логам
        const path = await invoke<string | null>("get_log_path");
        setLogPath(path);

        // Если путь не найден, пытаемся найти автоматически
        if (!path) {
          const foundPath = await invoke<string | null>("find_log_file");
          if (foundPath) {
            setLogPath(foundPath);
          }
        }

        // Проверяем статус сессии
        const active = await invoke<boolean>("is_session_active");
        setIsSessionActive(active);

        // Авторизация
        const a = await invoke<AuthStatus>("auth_status");
        setAuth(a);
        if (a.is_logged_in) {
          const p = await invoke<UserProfile | null>("get_my_profile");
          setProfile(p);
        } else {
          setProfile(null);
        }

        // Проверяем обновления (в фоне, не блокируем UI)
        checkForUpdates();

        if (active) {
          const currentStats = await invoke<SessionStats>("get_session_stats");
          setStats(currentStats);

          const currentDrops = await invoke<AggregatedDrop[]>("get_drops");
          setDrops(currentDrops);
        }
      } catch (err) {
        console.error("Init error:", err);
      }
    }

    init();
  }, []);

  // Подписываемся на события от Rust
  useEffect(() => {
    console.log("Setting up event listeners...");
    const unlisteners: (() => void)[] = [];

    // Событие дропа предмета
    listen<ItemDropEvent>("item-drop", (event) => {
      console.log("Item dropped:", event.payload);
      // Обновляем список дропов
      invoke<AggregatedDrop[]>("get_drops").then(setDrops).catch(console.error);
    }).then((unlisten) => {
      console.log("item-drop listener registered");
      unlisteners.push(unlisten);
    });

    // Обновление цен: пересчитываем totals в списке (иначе будет "-" пока не придёт следующий item-drop)
    listen("price-update", () => {
      invoke<AggregatedDrop[]>("get_drops").then(setDrops).catch(console.error);
    }).then((unlisten) => unlisteners.push(unlisten));

    // Событие обновления статистики
    listen<SessionStats>("stats-update", (event) => {
      console.log("Stats update received:", event.payload);
      setStats(event.payload);
    }).then((unlisten) => unlisteners.push(unlisten));

    // Событие что нужен путь к логам
    listen("log-path-needed", () => {
      console.log("Log path configuration needed");
    }).then((unlisten) => unlisteners.push(unlisten));

    return () => {
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  // Держим UI в синхроне с backend: на случай если сессия была старт/стоп вне текущего UI стейта
  // (или приложение перезапускалось, или был race при end_session).
  useEffect(() => {
    let cancelled = false;

    const sync = async () => {
      try {
        const active = await invoke<boolean>("is_session_active");
        if (cancelled) return;

        setIsSessionActive(active);
        if (active) {
          const [s, d] = await Promise.all([
            invoke<SessionStats>("get_session_stats"),
            invoke<AggregatedDrop[]>("get_drops"),
          ]);
          if (!cancelled) {
            setStats(s);
            setDrops(d);
          }
        }
      } catch (e) {
        console.error(e);
      }
    };

    sync();
    const id = window.setInterval(sync, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Тикер для таймера: обновляем stats даже если в логе нет новых событий.
  useEffect(() => {
    if (!isSessionActive) return;

    let cancelled = false;
    const id = window.setInterval(() => {
      invoke<SessionStats>("get_session_stats")
        .then((s) => {
          if (!cancelled) setStats(s);
        })
        .catch(console.error);
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [isSessionActive]);

  // Начать сессию
  const handleStartSession = async () => {
    try {
      await invoke("start_session", { presetId: null });
      setIsSessionActive(true);
      setStats({
        total_items: 0,
        unique_items: 0,
        total_value: 0,
        maps_completed: 0,
        duration_sec: 0,
        avg_map_duration_sec: 0,
        stale_price_lines: 0,
        hourly_profit: 0,
        is_paused: false,
      });
      setDrops([]);
    } catch (err) {
      console.error("Start session error:", err);
    }
  };

  // Завершить сессию
  const handleEndSession = async () => {
    try {
      const finalStats = await invoke<SessionStats>("end_session");
      setStats(finalStats);
      setIsSessionActive(false);
    } catch (err) {
      console.error("End session error:", err);
    }
  };

  // Форматирование времени
  const formatDuration = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  // Форматирование числа
  const formatNumber = (num: number): string => {
    return num.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
  };

  const formatPriceAge = (iso: string | null): string => {
    if (!iso) return "—";
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return "—";
    const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    const min = Math.floor(diffSec / 60);
    if (min < 60) return `${min}м`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${h}ч ${m}м`;
  };

  // Получить имя предмета (приоритет: Supabase → локальный кэш → ID)
  const getItemDisplayName = (drop: AggregatedDrop): string => {
    // Приоритет 1: данные из Supabase (через item_info)
    if (drop.item_info) {
      // Пока только английские названия, потом добавим переключение языка
      return drop.item_info.name || drop.item_info.name_en || `ID: ${drop.game_id}`;
    }
    // Приоритет 2: локальный fallback (для offline режима)
    if (isKnownItem(drop.game_id)) {
      return getItemName(drop.game_id, 'en');
    }
    // Неизвестный предмет
    return `❓ ID: ${drop.game_id}`;
  };
  
  // Проверить известен ли предмет
  const isItemKnown = (drop: AggregatedDrop): boolean => {
    return !!drop.item_info || isKnownItem(drop.game_id);
  };

  // Проверка обновлений
  const checkForUpdates = async () => {
    try {
      const update = await check();
      if (update?.available) {
        console.log("Update available:", update.version);
        setUpdateAvailable(update.version);
      }
    } catch (e) {
      console.log("Update check failed (normal in dev):", e);
    }
  };

  // Скачать и установить обновление
  const handleUpdate = async () => {
    if (!updateAvailable) return;
    
    setIsUpdating(true);
    setUpdateProgress(0);
    
    try {
      const update = await check();
      if (!update?.available) return;

      // Скачиваем и устанавливаем с прогрессом
      await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          setUpdateProgress(0);
        } else if (event.event === "Progress") {
          // Обновляем прогресс
          const progress = event.data.chunkLength;
          setUpdateProgress((prev) => Math.min((prev || 0) + progress / 1024 / 10, 99));
        } else if (event.event === "Finished") {
          setUpdateProgress(100);
        }
      });
      
      // Перезапускаем приложение
      await relaunch();
    } catch (e) {
      console.error("Update failed:", e);
      setIsUpdating(false);
      setUpdateProgress(null);
      alert("Ошибка обновления: " + String(e));
    }
  };

  // Выбрать файл логов вручную
  const handleSelectLogFile = async () => {
    try {
      const selected = await open({
        title: "Выберите UE_game.log",
        filters: [{
          name: "Log files",
          extensions: ["log"]
        }],
        multiple: false,
      });
      if (selected && typeof selected === "string") {
        const result = await invoke<boolean>("set_log_path", { path: selected });
        if (result) {
          setLogPath(selected);
          // Перезапуск потребуется для подключения watcher'а
          alert("Путь сохранён! Перезапустите приложение для применения.");
        }
      }
    } catch (e) {
      console.error("Failed to select log file:", e);
    }
  };

  const handleAuthSignInKripika = async () => {
    setAuthError(null);
    try {
      const res = await invoke<AuthStatus>("auth_sign_in_kripika");
      setAuth(res);
      if (res.is_logged_in) {
        const p = await invoke<UserProfile | null>("get_my_profile");
        setProfile(p);
      } else {
        setProfile(null);
      }
      setShowAuth(false);
    } catch (e: any) {
      setAuthError(String(e));
    }
  };

  const handleAuthSignOut = async () => {
    setAuthError(null);
    try {
      await invoke("auth_sign_out");
      const res = await invoke<AuthStatus>("auth_status");
      setAuth(res);
      setProfile(null);
    } catch (e: any) {
      setAuthError(String(e));
    }
  };

  const handleAuthCancel = async () => {
    setAuthError(null);
    try {
      await invoke("auth_cancel_login");
    } catch {
      // ignore
    } finally {
      setShowAuth(false);
    }
  };

  return (
    <div className="container">
      {/* Update Banner */}
      {updateAvailable && (
        <div className="update-banner">
          {isUpdating ? (
            <span>
              ⏳ Обновление... {updateProgress !== null ? `${Math.round(updateProgress)}%` : ""}
            </span>
          ) : (
            <>
              <span>🚀 Доступна версия {updateAvailable}</span>
              <button className="btn-update" onClick={handleUpdate}>
                Обновить
              </button>
            </>
          )}
        </div>
      )}

      {/* Header */}
      <header className="header">
        <div className="header-title">
          <h1>TLI Companion</h1>
          <span className="version">v{version}</span>
        </div>
        <div className="status">
          {logPath ? (
            <span className="status-ok" title={logPath}>● Лог найден</span>
          ) : (
            <button className="btn-link status-error" onClick={handleSelectLogFile}>
              ● Лог не найден — выбрать
            </button>
          )}
          <div className="auth-status">
            {auth?.is_logged_in ? (
              <button className="link" onClick={() => setShowAuth(true)}>
                {profile?.display_name || profile?.username || auth.email || "Войти"}
              </button>
            ) : (
              <button className="link" onClick={() => setShowAuth(true)}>
                Войти
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Auth Modal */}
      {showAuth && (
        <div className="modal-backdrop" onClick={() => setShowAuth(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">kripika.com — вход</div>
            {!auth?.is_logged_in ? (
              <div className="offline-hint">
                Оффлайн режим: трекинг дропа и локальные цены работают без логина. Войти нужно только для
                синхронизации и crowd-цен.
              </div>
            ) : null}
            {auth?.is_logged_in ? (
              <>
                <div className="modal-row">
                  <div className="profile-row">
                    {profile?.avatar_url ? (
                      <img className="profile-avatar" src={profile.avatar_url} alt="" />
                    ) : null}
                    <div className="profile-meta">
                      <div>
                        Вы вошли как{" "}
                        <b>{profile?.display_name || profile?.username || auth.email}</b>
                      </div>
                      {profile?.level ? (
                        <div className="profile-sub">
                          Уровень {profile.level}
                          {Number.isFinite(profile?.total_xp) ? ` · XP ${profile?.total_xp}` : ""}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div className="modal-actions">
                  <button className="btn btn-stop" onClick={handleAuthSignOut}>
                    Выйти
                  </button>
                  <button className="btn" onClick={() => setShowAuth(false)}>
                    Закрыть
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="modal-actions">
                  <button className="btn btn-start" onClick={handleAuthSignInKripika}>
                    Войти через kripika.com
                  </button>
                </div>
                {authError ? <div className="modal-error">{authError}</div> : null}
                <div className="modal-actions">
                  <button className="btn" onClick={handleAuthCancel}>
                    Отмена
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Stats Panel */}
      {stats && (
        <div className="stats-panel">
          <div className="stat-row">
            <div className="stat">
              <span className="stat-value">{formatDuration(stats.duration_sec)}</span>
              <span className="stat-label">Время</span>
            </div>
            <div className="stat">
              <span className="stat-value">{stats.maps_completed}</span>
              <span className="stat-label">Карт</span>
              <span className="stat-sub">
                Ср/карта: {stats.avg_map_duration_sec > 0 ? formatDuration(stats.avg_map_duration_sec) : "—"}
              </span>
            </div>
          </div>
          <div className="stat-row">
            <div className="stat">
              <span className="stat-value">{formatNumber(stats.total_value)}</span>
              <span className="stat-label">Доход</span>
              {stats.stale_price_lines > 0 ? (
                <span className="stat-sub stat-warn">
                  Есть устаревшие цены ({stats.stale_price_lines}) — обнови прайсчеком
                </span>
              ) : null}
            </div>
            <div className="stat highlight">
              <span className="stat-value">{formatNumber(stats.hourly_profit)}</span>
              <span className="stat-label">В час</span>
            </div>
          </div>
        </div>
      )}

      {/* Control Buttons */}
      <div className="controls">
        {!isSessionActive ? (
          <button className="btn btn-start" onClick={handleStartSession}>
            ▶ Начать сессию
          </button>
        ) : (
          <button className="btn btn-stop" onClick={handleEndSession}>
            ■ Завершить
          </button>
        )}
      </div>

      {/* Drops List */}
      <div className="drops-panel">
        <h2>Дроп ({drops.length})</h2>
        {drops.length === 0 ? (
          <div className="empty-state">
            {isSessionActive ? "Ожидание дропа..." : "Начните сессию для отслеживания"}
          </div>
        ) : (
          <div className="drops-list">
            {drops.map((drop) => (
              <div 
                key={drop.game_id} 
                className={`drop-item ${!isItemKnown(drop) ? 'unknown' : ''}`}
              >
                <div className="drop-info">
                  <span className={`drop-name ${!isItemKnown(drop) ? 'unknown' : ''}`}>
                    {getItemDisplayName(drop)}
                  </span>
                  <span className="drop-qty">x{drop.quantity}</span>
                </div>
                <span className="drop-value">
                  {drop.total_value > 0 ? (
                    <span className={`${drop.price_is_stale ? "price-stale" : "price-ok"} ${drop.is_previous_season ? "price-old-season" : ""}`}>
                      {formatNumber(drop.total_value)}
                      {drop.is_previous_season ? (
                        <span className="price-old-season-badge" title={`Цена из ${drop.league_name || 'прошлого сезона'}, нужен новый прайсчек`}>
                          ⚠️ {drop.league_name || 'стар.'}
                        </span>
                      ) : drop.price_is_stale ? (
                        <span className="price-stale-badge">стар. {formatPriceAge(drop.price_updated_at)}</span>
                      ) : null}
                    </span>
                  ) : (
                    <span className={drop.price_is_stale ? "price-stale" : ""}>-</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="footer">
        <a href="#" onClick={() => invoke("open_url", { url: "https://kripika.com" })}>
          kripika.com
        </a>
      </footer>
    </div>
  );
}

export default App;
