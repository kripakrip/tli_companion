import { useEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { open } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import "./Overlay.css";
import {
  IconStats,
  IconPause,
  IconPlay,
  IconCoins,
  IconExpense,
  IconSettings,
  IconClose,
  IconMinus,
  IconBox,
  IconWarning,
  IconFolder,
  IconStar,
  IconUser,
  IconCollapse,
  IconExpand,
  IconMove,
  IconClipboard,
  IconHeart,
  IconExternalLink,
} from "./icons";

// ============================================
// Tooltip Component
// ============================================
interface TooltipState {
  text: string;
  x: number;
  y: number;
}

function Tooltip({ text, x, y }: TooltipState) {
  // If cursor is near bottom of window, show tooltip above
  const isNearBottom = y > window.innerHeight - 60;
  const isNearRight = x > window.innerWidth - 200;
  
  const style: React.CSSProperties = {
    left: isNearRight ? x - 12 : x + 12,
    transform: isNearRight ? 'translateX(-100%)' : 'none',
    top: isNearBottom ? y - 40 : y - 10,
  };
  
  return createPortal(
    <div className="tooltip-portal" style={style}>
      {text}
    </div>,
    document.body
  );
}

// ============================================
// Storage Keys
// ============================================
const STORAGE_KEY_VIEW_MODE = 'tli-overlay-view-mode';
const STORAGE_KEY_POSITION = 'tli-overlay-position';

// Default log path hint for users (Steam version)
const LOG_PATH_HINT = '...\\steamapps\\common\\Torchlight Infinite\\UE_game\\TorchLight\\Saved\\Logs\\UE_game.log';
const LOG_PATH_EXAMPLE = 'D:\\Steam\\steamapps\\common\\Torchlight Infinite\\UE_game\\TorchLight\\Saved\\Logs\\UE_game.log';

// ============================================
// Localization
// ============================================
const translations = {
  ru: {
    // Tabs & Navigation
    stats: 'Статистика',
    addDrop: 'Добавить дроп',
    sessionPresets: 'Пресеты сессий',
    settings: 'Настройки',
    profile: 'Профиль',
    
    // Session
    startSession: 'Начать сессию',
    selectPreset: 'Выбрать пресет',
    endSession: 'Завершить',
    pause: 'Пауза',
    resume: 'Продолжить',
    paused: 'ПАУЗА',
    pausedDescription: 'Дроп не записывается. Нажмите для продолжения',
    
    // Stats
    time: 'Время',
    maps: 'Карт',
    remaining: 'Осталось',
    perMap: 'На карту',
    fePerHour: 'FE/ч',
    income: 'Доход',
    expenses: 'Траты',
    commission: 'Комиссия',
    netProfit: 'Чистая прибыль',
    
    // Drops
    drop: 'ДРОП',
    waitingForDrop: 'Ожидание дропа...',
    addManually: 'Добавить вручную',
    
    // Presets
    newPreset: 'Новый пресет',
    editPreset: 'Редактировать',
    deletePreset: 'Удалить',
    sharePreset: 'Поделиться',
    importPreset: 'Импорт',
    presetName: 'Название пресета',
    targetMaps: 'Целевое кол-во карт',
    totalExpenses: 'Общие траты',
    save: 'Сохранить',
    cancel: 'Отмена',
    back: 'Назад',
    import: 'Импортировать',
    emptyPreset: 'Пустой пресет',
    emptyPresetDesc: 'Без трат и целей',
    
    // Manual entry
    searchItem: 'Поиск предмета...',
    quantity: 'Кол-во',
    price: 'Цена (FE)',
    add: 'Добавить',
    addCustomItem: 'Добавить вручную',
    customItem: 'Свой предмет с ценой',
    
    // Profile
    login: 'Войти',
    logout: 'Выйти',
    loginViaKripika: 'Войти через kripika.com',
    loggingIn: 'Входим...',
    logoutConfirm: 'Выйти из аккаунта?',
    yes: 'Да',
    no: 'Нет',
    sessionHistory: 'История сессий',
    noSessions: 'Нет сохранённых сессий',
    deleteSession: 'Удалить сессию',
    
    // Settings
    language: 'Язык',
    interfaceOrientation: 'Ориентация интерфейса',
    vertical: 'Вертикальная',
    horizontal: 'Горизонтальная',
    panelDirection: 'Направление панелей',
    left: 'Влево',
    right: 'Вправо',
    top: 'Вверх',
    bottom: 'Вниз',
    auctionFee: 'Комиссия аукциона',
    windowOpacity: 'Прозрачность окна',
    alwaysOnTop: 'Всегда поверх окон',
    minimizeToTray: 'Сворачивать в трей',
    logFilePath: 'Путь к лог-файлу',
    autoDetect: 'Автоопределение',
    examplePath: 'Пример пути',
    selectFile: 'Выбрать файл',
    
    // Log modal
    logNotFound: 'Лог-файл не найден',
    logRequired: 'Для работы TLI Companion нужен лог-файл игры.',
    pathToFile: 'Путь к файлу',
    fullPathExample: 'Пример полного пути',
    selectLogFile: 'Нажмите кнопку ниже и выберите файл',
    
    // Status
    logActive: 'Лог активен',
    logInactive: 'Лог неактивен',
    synced: 'Синхр.',
    notSynced: 'Не синхр.',
    
    // Misc
    collapse: 'Свернуть панель',
    expand: 'Развернуть панель',
    dragWindow: 'Перетащить окно',
    close: 'Закрыть',
    minimize: 'Свернуть',
    copied: 'Скопировано!',
    total: 'Итого',
    
    // About & Support
    about: 'О программе',
    supportProject: 'Поддержать проект',
    visitWebsite: 'Перейти на сайт',
    
    // Updates
    newVersion: 'Доступна новая версия',
    update: 'Обновить',
    updating: 'Обновление',
    madeWith: 'Сделано с',
    forCommunity: 'для сообщества TLI',
  },
  en: {
    // Tabs & Navigation
    stats: 'Statistics',
    addDrop: 'Add Drop',
    sessionPresets: 'Session Presets',
    settings: 'Settings',
    profile: 'Profile',
    
    // Session
    startSession: 'Start Session',
    selectPreset: 'Select Preset',
    endSession: 'End Session',
    pause: 'Pause',
    resume: 'Resume',
    paused: 'PAUSED',
    pausedDescription: 'Drops not recorded. Click to continue',
    
    // Stats
    time: 'Time',
    maps: 'Maps',
    remaining: 'Remaining',
    perMap: 'Per map',
    fePerHour: 'FE/hr',
    income: 'Income',
    expenses: 'Expenses',
    commission: 'Commission',
    netProfit: 'Net Profit',
    
    // Drops
    drop: 'DROP',
    waitingForDrop: 'Waiting for drop...',
    addManually: 'Add manually',
    
    // Presets
    newPreset: 'New Preset',
    editPreset: 'Edit',
    deletePreset: 'Delete',
    sharePreset: 'Share',
    importPreset: 'Import',
    presetName: 'Preset name',
    targetMaps: 'Target maps',
    totalExpenses: 'Total expenses',
    save: 'Save',
    cancel: 'Cancel',
    back: 'Back',
    import: 'Import',
    emptyPreset: 'Empty Preset',
    emptyPresetDesc: 'No expenses or goals',
    
    // Manual entry
    searchItem: 'Search item...',
    quantity: 'Qty',
    price: 'Price (FE)',
    add: 'Add',
    addCustomItem: 'Add manually',
    customItem: 'Custom item with price',
    
    // Profile
    login: 'Login',
    logout: 'Logout',
    loginViaKripika: 'Login via kripika.com',
    loggingIn: 'Logging in...',
    logoutConfirm: 'Log out?',
    yes: 'Yes',
    no: 'No',
    sessionHistory: 'Session History',
    noSessions: 'No saved sessions',
    deleteSession: 'Delete session',
    
    // Settings
    language: 'Language',
    interfaceOrientation: 'Interface Orientation',
    vertical: 'Vertical',
    horizontal: 'Horizontal',
    panelDirection: 'Panel Direction',
    left: 'Left',
    right: 'Right',
    top: 'Top',
    bottom: 'Bottom',
    auctionFee: 'Auction Fee',
    windowOpacity: 'Window Opacity',
    alwaysOnTop: 'Always on top',
    minimizeToTray: 'Minimize to tray',
    logFilePath: 'Log file path',
    autoDetect: 'Auto-detect',
    examplePath: 'Example path',
    selectFile: 'Select file',
    
    // Log modal
    logNotFound: 'Log file not found',
    logRequired: 'TLI Companion requires the game log file.',
    pathToFile: 'Path to file',
    fullPathExample: 'Full path example',
    selectLogFile: 'Click the button below to select file',
    
    // Status
    logActive: 'Log active',
    logInactive: 'Log inactive',
    synced: 'Synced',
    notSynced: 'Not synced',
    
    // Misc
    collapse: 'Collapse panel',
    expand: 'Expand panel',
    dragWindow: 'Drag window',
    close: 'Close',
    minimize: 'Minimize',
    copied: 'Copied!',
    total: 'Total',
    
    // About & Support
    about: 'About',
    supportProject: 'Support Project',
    visitWebsite: 'Visit Website',
    
    // Updates
    newVersion: 'New version available',
    update: 'Update',
    updating: 'Updating',
    madeWith: 'Made with',
    forCommunity: 'for TLI community',
  }
};

type Lang = 'ru' | 'en';
const t = (lang: Lang, key: keyof typeof translations.ru) => translations[lang][key] || key;

// ============================================
// Types
// ============================================

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

interface AppSettings {
  custom_log_path: string | null;
  auto_start: boolean;
  minimize_to_tray: boolean;
  language: string;
  api_url: string;
  layout_orientation: 'vertical' | 'horizontal';
  panel_direction: 'left' | 'right' | 'top' | 'bottom';
  auction_fee_rate: number;
  opacity: number;
  always_on_top: boolean;
}

interface ItemInfo {
  game_id: number;
  name: string;
  name_en: string | null;
  name_ru: string | null;
  name_cn: string | null;
  category: string;
  icon_url: string | null;
  is_base_currency?: boolean;
}

interface ExpenseEntry {
  id: string;
  game_id: number | null;
  name: string;
  name_ru: string | null;
  quantity: number;
  price: number;
}

interface ManualDropEntry {
  id: string;
  game_id: number | null;
  name: string;
  name_ru: string | null;
  quantity: number;
  price: number;
}

interface SessionPreset {
  id: string;
  name: string;
  items: ExpenseEntry[];
  targetMaps: number; // 0 = бесконечно, >0 = плановое кол-во карт
  createdAt: string;
}

const STORAGE_KEY_PRESETS = 'tli-session-presets';
const STORAGE_KEY_ACTIVE_PRESET = 'tli-active-preset-id';

interface AggregatedDrop {
  game_id: number;
  item_info: ItemInfo | null;
  quantity: number;
  total_value: number;
  unit_price: number;
  price_updated_at: string | null;
  price_is_stale: boolean;
  is_previous_season: boolean;
  league_name: string | null;
}

interface LogFileStatus {
  exists: boolean;
  is_active: boolean;
  last_modified_secs_ago: number | null;
  size_bytes: number | null;
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

interface SessionHistoryItem {
  id: string;
  started_at: string;
  ended_at: string;
  maps_completed: number;
  total_duration_sec: number;
  total_profit: number;
  total_expenses: number;
  total_income: number;
}

type ViewMode = 'collapsed' | 'expanded';
type ActiveTab = 'stats' | 'profile' | 'add-drop' | 'session-preset' | 'settings' | 'about';

// ============================================
// Constants
// ============================================

// Комиссия аукциона теперь берётся из appSettings.auction_fee_rate
const BASE_CURRENCY_ID = 100300; // Flame Elementium

// ============================================
// Component
// ============================================

export function Overlay() {
  // State
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_VIEW_MODE);
    if (saved === 'collapsed' || saved === 'expanded') return saved;
    return 'expanded';
  });
  const [activeTab, setActiveTab] = useState<ActiveTab>('stats');
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [drops, setDrops] = useState<AggregatedDrop[]>([]);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [, setLogPath] = useState<string | null>(null);
  const [version, setVersion] = useState("");
  const [showLogModal, setShowLogModal] = useState(false);
  
  // Update state
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings>({
    custom_log_path: null,
    auto_start: false,
    minimize_to_tray: true,
    language: 'ru',
    api_url: 'https://www.kripika.com',
    layout_orientation: 'vertical',
    panel_direction: 'right',
    auction_fee_rate: 0.125,
    opacity: 1.0,
    always_on_top: true,
  });
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [logStatus, setLogStatus] = useState<LogFileStatus | null>(null);
  const [pricesCache, setPricesCache] = useState<Record<number, number>>({});
  
  // Auth state
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [sessionHistory, setSessionHistory] = useState<SessionHistoryItem[]>([]);
  const [sessionHistoryLoading, setSessionHistoryLoading] = useState(false);
  
  // Manual entry state
  const [manualSearch, setManualSearch] = useState('');
  const [manualQuantity, setManualQuantity] = useState(1);
  const [manualPrice, setManualPrice] = useState(0);
  const [selectedItem, setSelectedItem] = useState<ItemInfo | null>(null);
  const [searchResults, setSearchResults] = useState<ItemInfo[]>([]);
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);
  const [isCustomItem, setIsCustomItem] = useState(false);
  
  // Expense presets system
  const [presets, setPresets] = useState<SessionPreset[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_PRESETS);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [activePresetId, setActivePresetId] = useState<string | null>(() => {
    return localStorage.getItem(STORAGE_KEY_ACTIVE_PRESET);
  });
  const [editingPreset, setEditingPreset] = useState<SessionPreset | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null); // Выбранный для запуска
  const [presetName, setPresetName] = useState('');
  const [presetTargetMaps, setPresetTargetMaps] = useState(0); // 0 = бесконечно
  const [presetView, setPresetView] = useState<'list' | 'edit' | 'import'>('list');
  const [importCode, setImportCode] = useState('');
  const [importError, setImportError] = useState('');
  
  // Editing individual expense item
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [editExpenseQty, setEditExpenseQty] = useState(1);
  const [editExpensePrice, setEditExpensePrice] = useState(0);
  
  // Current expenses (from active preset or editing)
  const [expenses, setExpenses] = useState<ExpenseEntry[]>([]);
  
  // Manual drops list
  const [manualDrops, setManualDrops] = useState<ManualDropEntry[]>([]);
  
  // Get active preset
  const activePreset = presets.find(p => p.id === activePresetId) || null;
  
  // Calculate total expenses from list
  const totalExpenses = expenses.reduce((sum, e) => sum + e.quantity * e.price, 0);
  
  // Локальный таймер (простой счётчик секунд)
  const [localDuration, setLocalDuration] = useState(0);
  
  // Отображаемое время - просто localDuration
  const displayDuration = localDuration;
  
  // Tooltip handlers - отключаем в collapsed режиме
  const showTooltip = (text: string) => (e: React.MouseEvent) => {
    if (viewMode === 'collapsed') return;
    setTooltip({ text, x: e.clientX, y: e.clientY });
  };
  const hideTooltip = () => setTooltip(null);
  const moveTooltip = (e: React.MouseEvent) => {
    if (viewMode === 'collapsed') return;
    if (tooltip) setTooltip({ ...tooltip, x: e.clientX, y: e.clientY });
  };
  
  // Save position on move
  const positionSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ============================================
  // Calculations
  // ============================================

  const calculateFee = useCallback((grossIncome: number, drops: AggregatedDrop[]) => {
    // Fee applies to everything except Flame Elementium
    const feIncome = drops
      .filter(d => d.game_id === BASE_CURRENCY_ID)
      .reduce((sum, d) => sum + d.total_value, 0);
    const taxableIncome = grossIncome - feIncome;
    return taxableIncome > 0 ? taxableIncome * appSettings.auction_fee_rate : 0;
  }, [appSettings.auction_fee_rate]);

  // Calculate manual drops income
  const manualDropsIncome = manualDrops.reduce((sum, d) => sum + d.quantity * d.price, 0);
  // Комиссия только на ручные дропы, которые НЕ являются FE (Flame Elementium)
  const manualDropsTaxable = manualDrops
    .filter(d => d.game_id !== BASE_CURRENCY_ID)
    .reduce((sum, d) => sum + d.quantity * d.price, 0);
  const manualDropsFee = manualDropsTaxable * appSettings.auction_fee_rate;
  
  // Total income = auto drops + manual drops
  const totalIncome = (stats?.total_value || 0) + manualDropsIncome;
  const totalFee = calculateFee(stats?.total_value || 0, drops) + manualDropsFee;
  
  const netProfit = totalIncome - totalExpenses - totalFee;
  // Use displayDuration for profit calculation to account for pauses
  const profitPerHour = displayDuration > 0 
    ? (netProfit / displayDuration) * 3600 
    : 0;

  // ============================================
  // Initialization
  // ============================================

  // Disable browser context menu
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      // Allow context menu only on input/textarea elements
      const target = e.target as HTMLElement;
      if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
        e.preventDefault();
      }
    };
    document.addEventListener('contextmenu', handleContextMenu);
    return () => document.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  // Динамически изменяем размер окна под контент, чтобы избежать "мёртвых" зон
  useEffect(() => {
    const updateWindowSize = async () => {
      try {
        const win = getCurrentWindow();
        const { LogicalSize } = await import('@tauri-apps/api/window');
        const isHorizontal = appSettings.layout_orientation === 'horizontal';
        
        if (viewMode === 'collapsed') {
          // В свёрнутом режиме - только sidebar
          if (isHorizontal) {
            await win.setSize(new LogicalSize(500, 70));
          } else {
            await win.setSize(new LogicalSize(75, 500));
          }
        } else {
          // В развёрнутом режиме - полный размер
          if (isHorizontal) {
            await win.setSize(new LogicalSize(600, 420));
          } else {
            await win.setSize(new LogicalSize(420, 600));
          }
        }
      } catch (err) {
        console.error("Failed to update window size:", err);
      }
    };
    updateWindowSize();
  }, [viewMode, appSettings.layout_orientation]);

  useEffect(() => {
    async function init() {
      try {
        const ver = await invoke<string>("get_app_version");
        setVersion(ver);

        // Загружаем настройки
        const settings = await invoke<AppSettings>("get_settings");
        setAppSettings(settings);

        const path = await invoke<string | null>("get_log_path");
        setLogPath(path);

        if (!path) {
          const foundPath = await invoke<string | null>("find_log_file");
          if (foundPath) {
            setLogPath(foundPath);
          } else {
            // Show log selection modal if log not found
            setShowLogModal(true);
          }
        }

        const active = await invoke<boolean>("is_session_active");
        setIsSessionActive(active);

        // Load manual drops if session is active
        if (active) {
          try {
            const mDrops = await invoke<ManualDropEntry[]>("get_manual_drops");
            setManualDrops(mDrops);
          } catch (e) {
            console.error("Failed to load manual drops:", e);
          }
        }
        
        // Load active preset expenses
        const savedPresetId = localStorage.getItem(STORAGE_KEY_ACTIVE_PRESET);
        if (savedPresetId) {
          const savedPresets: SessionPreset[] = JSON.parse(localStorage.getItem(STORAGE_KEY_PRESETS) || '[]');
          const preset = savedPresets.find(p => p.id === savedPresetId);
          if (preset) {
            setExpenses(preset.items);
          }
        }

        // Load auth status
        try {
          const a = await invoke<AuthStatus>("auth_status");
          setAuth(a);
          if (a.is_logged_in) {
            const p = await invoke<UserProfile | null>("get_my_profile");
            setProfile(p);
            // Load session history
            try {
              const history = await invoke<SessionHistoryItem[]>("get_session_history", { limit: 10 });
              setSessionHistory(history);
            } catch (e) {
              console.error("Failed to load session history:", e);
            }
          }
        } catch (e) {
          console.error("Failed to load auth status:", e);
        }

        // Load prices cache
        const prices = await invoke<Record<number, number>>("get_cached_prices");
        setPricesCache(prices);

        if (active) {
          const currentStats = await invoke<SessionStats>("get_session_stats");
          setStats(currentStats);
          // Восстанавливаем состояние паузы и время из сохранённой сессии
          setIsPaused(currentStats.is_paused);
          setLocalDuration(currentStats.duration_sec);
          const currentDrops = await invoke<AggregatedDrop[]>("get_drops");
          setDrops(currentDrops);
        }

        // Restore window position
        const savedPos = localStorage.getItem(STORAGE_KEY_POSITION);
        if (savedPos) {
          try {
            const { x, y } = JSON.parse(savedPos);
            const win = getCurrentWindow();
            await win.setPosition(new PhysicalPosition(x, y));
          } catch (e) {
            console.error("Failed to restore position:", e);
          }
        }
      } catch (err) {
        console.error("Init error:", err);
      }
    }
    init();
    
    // Проверяем обновления при запуске
    checkForUpdates();
  }, []);

  // Save view mode on change
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_VIEW_MODE, viewMode);
  }, [viewMode]);

  // Save presets to localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_PRESETS, JSON.stringify(presets));
  }, [presets]);

  // Save active preset id
  useEffect(() => {
    if (activePresetId) {
      localStorage.setItem(STORAGE_KEY_ACTIVE_PRESET, activePresetId);
    } else {
      localStorage.removeItem(STORAGE_KEY_ACTIVE_PRESET);
    }
  }, [activePresetId]);

  // Track window position changes
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    
    const setupMoveListener = async () => {
      const win = getCurrentWindow();
      unlisten = await win.onMoved(({ payload }) => {
        // Debounce saves
        if (positionSaveTimeout.current) {
          clearTimeout(positionSaveTimeout.current);
        }
        positionSaveTimeout.current = setTimeout(() => {
          localStorage.setItem(STORAGE_KEY_POSITION, JSON.stringify({ 
            x: payload.x, 
            y: payload.y 
          }));
        }, 500);
      });
    };
    
    setupMoveListener();
    
    return () => {
      if (unlisten) unlisten();
      if (positionSaveTimeout.current) clearTimeout(positionSaveTimeout.current);
    };
  }, []);

  // ============================================
  // Event Listeners
  // ============================================

  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    listen<AggregatedDrop>("item-drop", () => {
      invoke<AggregatedDrop[]>("get_drops").then(setDrops).catch(console.error);
    }).then(unlisten => unlisteners.push(unlisten));

    listen("price-update", () => {
      invoke<AggregatedDrop[]>("get_drops").then(setDrops).catch(console.error);
      invoke<Record<number, number>>("get_cached_prices").then(setPricesCache).catch(console.error);
    }).then(unlisten => unlisteners.push(unlisten));

    listen<SessionStats>("stats-update", (event) => {
      setStats(event.payload);
    }).then(unlisten => unlisteners.push(unlisten));

    return () => unlisteners.forEach(fn => fn());
  }, []);

  // Локальный таймер: каждую секунду увеличиваем время если не на паузе
  useEffect(() => {
    if (!isSessionActive || isPaused) return;
    const id = setInterval(() => {
      setLocalDuration(prev => prev + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [isSessionActive, isPaused]);
  
  // Периодическая синхронизация: сохраняем время на бэкенд и получаем stats
  useEffect(() => {
    if (!isSessionActive) return;
    const id = setInterval(() => {
      // Сохраняем время на бэкенд
      invoke("update_session_duration", { durationSec: localDuration }).catch(console.error);
      // Получаем остальные stats
      invoke<SessionStats>("get_session_stats").then(setStats).catch(console.error);
    }, 5000);
    return () => clearInterval(id);
  }, [isSessionActive, localDuration]);

  // Check log status periodically
  useEffect(() => {
    const checkStatus = () => {
      invoke<LogFileStatus>("check_log_status")
        .then(setLogStatus)
        .catch(console.error);
    };
    
    checkStatus(); // Initial check
    const id = setInterval(checkStatus, 5000); // Check every 5 seconds
    return () => clearInterval(id);
  }, []);

  // Item search with debounce
  useEffect(() => {
    if (manualSearch.length < 2) {
      setSearchResults([]);
      setShowSearchDropdown(false);
      return;
    }
    
    const timer = setTimeout(async () => {
      try {
        const results = await invoke<ItemInfo[]>("search_items", { query: manualSearch });
        setSearchResults(results);
        setShowSearchDropdown(results.length > 0 || manualSearch.length >= 2);
      } catch (e) {
        console.error("Search failed:", e);
      }
    }, 200);
    
    return () => clearTimeout(timer);
  }, [manualSearch]);

  // ============================================
  // Handlers
  // ============================================


  const handleEndSession = async () => {
    try {
      const finalStats = await invoke<SessionStats>("end_session");
      setStats(finalStats);
      setIsSessionActive(false);
      setIsPaused(false);
    } catch (err) {
      console.error("End session error:", err);
    }
  };

  // Auth handlers
  const loadSessionHistory = async () => {
    setSessionHistoryLoading(true);
    try {
      const history = await invoke<SessionHistoryItem[]>("get_session_history", { limit: 10 });
      setSessionHistory(history);
    } catch (e) {
      console.error("Failed to load session history:", e);
    } finally {
      setSessionHistoryLoading(false);
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    try {
      await invoke<boolean>("delete_session_history", { sessionId });
      // Удаляем из локального состояния
      setSessionHistory(prev => prev.filter(s => s.id !== sessionId));
    } catch (e) {
      console.error("Failed to delete session:", e);
    }
  };

  const handleAuthSignIn = async () => {
    setAuthError(null);
    try {
      const res = await invoke<AuthStatus>("auth_sign_in_kripika");
      setAuth(res);
      if (res.is_logged_in) {
        const p = await invoke<UserProfile | null>("get_my_profile");
        setProfile(p);
        // Load session history after login
        loadSessionHistory();
      } else {
        setProfile(null);
      }
    } catch (e: unknown) {
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
      setShowLogoutConfirm(false);
      setActiveTab('stats'); // Return to stats after logout
    } catch (e: unknown) {
      setAuthError(String(e));
    }
  };

  // Get cached price for item
  const getCachedPrice = (gameId: number): number | null => {
    // First try prices cache from backend
    if (pricesCache[gameId] !== undefined) {
      return pricesCache[gameId];
    }
    // Fallback to drops (for items in current session)
    const drop = drops.find(d => d.game_id === gameId);
    return drop?.unit_price || null;
  };

  // Manual entry handlers
  const handleSelectItem = (item: ItemInfo) => {
    setSelectedItem(item);
    setManualSearch(item.name_ru || item.name_en || item.name);
    setShowSearchDropdown(false);
    setIsCustomItem(false);
    
    // Auto-fill price from cache
    const cachedPrice = getCachedPrice(item.game_id);
    if (cachedPrice) {
      setManualPrice(cachedPrice);
    }
  };

  const handleUseCustomItem = () => {
    setSelectedItem(null);
    setIsCustomItem(true);
    setShowSearchDropdown(false);
  };

  const resetManualForm = () => {
    setManualSearch('');
    setManualQuantity(1);
    setManualPrice(0);
    setSelectedItem(null);
    setIsCustomItem(false);
    setSearchResults([]);
    setShowSearchDropdown(false);
  };

  const handleAddExpense = () => {
    const hasItem = selectedItem || (isCustomItem && manualSearch.trim());
    if (!hasItem || manualQuantity <= 0 || manualPrice <= 0) return;
    
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const gameId = selectedItem?.game_id || null;
    const name = selectedItem?.name_en || selectedItem?.name || manualSearch.trim();
    const nameRu = selectedItem?.name_ru || null;
    
    // Add to local state (will be synced when preset is used)
    setExpenses(prev => [...prev, { 
      id, 
      game_id: gameId, 
      name, 
      name_ru: nameRu, 
      quantity: manualQuantity, 
      price: manualPrice 
    }]);
    
    resetManualForm();
    // Stay on expenses tab to add more
  };

  const handleRemoveExpense = async (id: string) => {
    try {
      await invoke("remove_expense", { id });
      setExpenses(prev => prev.filter(e => e.id !== id));
    } catch (e) {
      console.error("Failed to remove expense:", e);
    }
  };

  const handleStartEditExpense = (exp: ExpenseEntry) => {
    setEditingExpenseId(exp.id);
    setEditExpenseQty(exp.quantity);
    setEditExpensePrice(exp.price);
  };

  const handleSaveEditExpense = () => {
    if (!editingExpenseId || editExpenseQty <= 0 || editExpensePrice <= 0) return;
    
    setExpenses(prev => prev.map(e => 
      e.id === editingExpenseId 
        ? { ...e, quantity: editExpenseQty, price: editExpensePrice }
        : e
    ));
    setEditingExpenseId(null);
  };

  const handleCancelEditExpense = () => {
    setEditingExpenseId(null);
  };

  const handleAddManualDrop = async () => {
    const hasItem = selectedItem || (isCustomItem && manualSearch.trim());
    if (!hasItem || manualQuantity <= 0 || manualPrice <= 0) return;
    
    // Manual drop can only be added during active session
    if (!isSessionActive) {
      console.warn("Cannot add manual drop without active session");
      return;
    }
    
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const gameId = selectedItem?.game_id || null;
    const name = selectedItem?.name_en || selectedItem?.name || manualSearch.trim();
    const nameRu = selectedItem?.name_ru || null;
    
    try {
      await invoke("add_manual_drop", { 
        id, 
        gameId, 
        name, 
        nameRu, 
        quantity: manualQuantity, 
        price: manualPrice 
      });
      
      setManualDrops(prev => [...prev, { 
        id, 
        game_id: gameId, 
        name, 
        name_ru: nameRu, 
        quantity: manualQuantity, 
        price: manualPrice 
      }]);
      
      resetManualForm();
      setActiveTab('stats'); // Return to stats after adding drop
    } catch (e) {
      console.error("Failed to add manual drop:", e);
    }
  };

  const handleRemoveManualDrop = async (id: string) => {
    try {
      await invoke("remove_manual_drop", { id });
      setManualDrops(prev => prev.filter(e => e.id !== id));
    } catch (e) {
      console.error("Failed to remove manual drop:", e);
    }
  };

  // Preset management
  const handleCreatePreset = () => {
    setEditingPreset(null);
    setExpenses([]);
    setPresetName('');
    setPresetTargetMaps(0);
    setPresetView('edit');
  };

  const handleEditPreset = (preset: SessionPreset) => {
    setEditingPreset(preset);
    setExpenses([...preset.items]);
    setPresetName(preset.name);
    setPresetTargetMaps(preset.targetMaps || 0);
    setPresetView('edit');
  };

  const [shareSuccess, setShareSuccess] = useState<string | null>(null);

  const handleSharePreset = async (preset: SessionPreset) => {
    try {
      // Create shareable code (base64 encoded JSON with Unicode support)
      const shareData = {
        v: 1, // version for future compatibility
        n: preset.name,
        m: preset.targetMaps || 0,
        i: preset.items.map(item => ({
          g: item.game_id,
          n: item.name,
          r: item.name_ru,
          q: item.quantity,
          p: item.price,
        }))
      };
      // Encode Unicode properly: JSON -> UTF-8 -> base64
      const jsonStr = JSON.stringify(shareData);
      const code = btoa(unescape(encodeURIComponent(jsonStr)));
      const shareCode = `TLI:${code}`;
      
      await writeText(shareCode);
      console.log("Preset shared:", shareCode);
      setShareSuccess(preset.id);
      setTimeout(() => setShareSuccess(null), 2000);
    } catch (e) {
      console.error("Failed to share preset:", e);
    }
  };

  const handleOpenImport = () => {
    setImportCode('');
    setImportError('');
    setPresetView('import');
  };

  const handleImportPreset = () => {
    try {
      const text = importCode.trim();
      if (!text.startsWith('TLI:')) {
        setImportError('Неверный формат кода');
        return;
      }
      
      const code = text.substring(4);
      // Decode base64 -> UTF-8 -> JSON (Unicode support)
      const jsonStr = decodeURIComponent(escape(atob(code)));
      const shareData = JSON.parse(jsonStr);
      
      if (shareData.v !== 1) {
        setImportError('Неподдерживаемая версия');
        return;
      }
      
      const newPreset: SessionPreset = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: shareData.n || 'Импортированный пресет',
        createdAt: new Date().toISOString(),
        targetMaps: shareData.m || 0,
        items: shareData.i.map((item: { g?: number; n: string; r?: string; q: number; p: number }) => ({
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          game_id: item.g || null,
          name: item.n,
          name_ru: item.r || null,
          quantity: item.q,
          price: item.p,
        }))
      };
      
      setPresets(prev => [...prev, newPreset]);
      setPresetView('list');
      setImportCode('');
      setImportError('');
    } catch (e) {
      console.error("Failed to import preset:", e);
      setImportError('Ошибка декодирования');
    }
  };

  const handleSavePreset = () => {
    if (!presetName.trim()) return;
    
    if (editingPreset) {
      // Update existing preset
      setPresets(prev => prev.map(p => 
        p.id === editingPreset.id 
          ? { ...p, name: presetName.trim(), items: expenses, targetMaps: presetTargetMaps }
          : p
      ));
    } else {
      // Create new preset
      const newPreset: SessionPreset = {
        id: `preset-${Date.now()}`,
        name: presetName.trim(),
        items: expenses,
        targetMaps: presetTargetMaps,
        createdAt: new Date().toISOString(),
      };
      setPresets(prev => [...prev, newPreset]);
    }
    
    setPresetView('list');
    setEditingPreset(null);
    setExpenses([]);
    setPresetName('');
    setPresetTargetMaps(0);
  };

  const handleDeletePreset = (id: string) => {
    setPresets(prev => prev.filter(p => p.id !== id));
    if (activePresetId === id) {
      setActivePresetId(null);
    }
  };

  // Запустить сессию с пресетом
  const handleStartWithPreset = async (preset: SessionPreset | null) => {
    try {
      await invoke("start_session", { presetId: preset?.id || null });
      setIsSessionActive(true);
      setIsPaused(false);
      setManualDrops([]);
      setLocalDuration(0);
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
      
      if (preset) {
        setActivePresetId(preset.id);
        setExpenses([...preset.items]);
        // Sync expenses with backend
        for (const item of preset.items) {
          try {
            await invoke("add_expense", {
              id: item.id,
              gameId: item.game_id,
              name: item.name,
              nameRu: item.name_ru,
              quantity: item.quantity,
              price: item.price,
            });
          } catch (e) {
            console.error("Failed to sync expense:", e);
          }
        }
      } else {
        setActivePresetId(null);
        setExpenses([]);
      }
      
      setSelectedPresetId(null); // Сбросить выбор
      setActiveTab('stats');
    } catch (err) {
      console.error("Start session error:", err);
    }
  };

  const handleCancelPresetEdit = () => {
    setPresetView('list');
    setEditingPreset(null);
    setExpenses(activePreset?.items || []);
    setPresetName('');
    setPresetTargetMaps(0);
  };

  const handleTogglePause = async () => {
    const newPaused = !isPaused;
    
    // Сохраняем текущее время на бэкенд перед паузой
    try {
      await invoke("update_session_duration", { durationSec: localDuration });
      await invoke("set_paused", { paused: newPaused });
    } catch (e) {
      console.error("Failed to set pause state:", e);
    }
    
    setIsPaused(newPaused);
  };

  const handleMinimize = async () => {
    try {
      const win = getCurrentWindow();
      // Всегда используем hide() для прозрачных окон,
      // чтобы избежать проблемы с "призрачным" хитбоксом
      await win.hide();
    } catch (err) {
      console.error("Minimize error:", err);
    }
  };


  const handleSaveSettings = async (newSettings: AppSettings) => {
    try {
      await invoke("save_settings", { settings: newSettings });
      setAppSettings(newSettings);
      
      // Применяем настройки, которые требуют немедленного применения
      const win = getCurrentWindow();
      await win.setAlwaysOnTop(newSettings.always_on_top);
      // Прозрачность применяется через CSS
    } catch (err) {
      console.error("Failed to save settings:", err);
    }
  };

  const handleClose = async () => {
    try {
      // Сохраняем время перед закрытием
      if (isSessionActive) {
        await invoke("update_session_duration", { durationSec: localDuration });
      }
      const win = getCurrentWindow();
      await win.close();
    } catch (err) {
      console.error("Close error:", err);
    }
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
          setShowLogModal(false);
        }
      }
    } catch (e) {
      console.error("Failed to select log file:", e);
    }
  };

  // ============================================
  // Formatters
  // ============================================

  const formatDuration = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  const formatNumber = (num: number): string => {
    const abs = Math.abs(num);
    if (abs >= 10000) {
      return (num / 1000).toFixed(1) + "k";
    }
    // Adaptive decimal places based on value
    if (abs >= 100) return num.toFixed(0);
    if (abs >= 10) return num.toFixed(1);
    if (abs >= 1) return num.toFixed(2);
    if (abs >= 0.1) return num.toFixed(3);
    if (abs === 0) return "0";
    return num.toFixed(4);
  };

  const formatDurationShort = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    if (m >= 60) {
      const h = Math.floor(m / 60);
      return `${h}ч ${m % 60}м`;
    }
    return `${m}м ${s}с`;
  };

  // Compact duration format for mini stats
  const formatDurationCompact = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      // 1ч 30м format for hours
      return `${h}ч${m > 0 ? m + 'м' : ''}`;
    }
    // 5:30 format for under an hour
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Average time per map
  const avgTimePerMap = stats && stats.maps_completed > 0 
    ? displayDuration / stats.maps_completed 
    : 0;

  const formatPriceAge = (iso: string | null): string => {
    if (!iso) return "—";
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return "—";
    const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    const min = Math.floor(diffSec / 60);
    if (min < 60) return `${min}м`;
    const h = Math.floor(min / 60);
    if (h < 24) {
      const m = min % 60;
      return `${h}ч ${m}м`;
    }
    const days = Math.floor(h / 24);
    return `${days}д`;
  };

  const getItemName = (drop: AggregatedDrop): string => {
    if (drop.item_info) {
      return drop.item_info.name || drop.item_info.name_en || `ID: ${drop.game_id}`;
    }
    return `ID: ${drop.game_id}`;
  };

  // ============================================
  // Render
  // ============================================

  // Классы для ориентации
  const orientationClass = `orientation-${appSettings.layout_orientation}`;
  const directionClass = `direction-${appSettings.panel_direction}`;
  
  // Локализация
  const lang = (appSettings.language || 'ru') as Lang;
  const L = (key: keyof typeof translations.ru) => t(lang, key);

  return (
    <div className={`overlay-container ${viewMode} ${orientationClass} ${directionClass}`}>
      {/* Update Banner */}
      {updateAvailable && (
        <div className="update-banner">
          {isUpdating ? (
            <div className="update-progress">
              {L('updating')}... {updateProgress !== null ? `${Math.round(updateProgress)}%` : ''}
            </div>
          ) : (
            <>
              <span>{L('newVersion')} v{updateAvailable}</span>
              <button className="btn-update" onClick={handleUpdate}>{L('update')}</button>
            </>
          )}
        </div>
      )}
      
      {/* Sidebar */}
      <div className="overlay-sidebar">
        <button 
          className={`overlay-btn ${activeTab === 'stats' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('stats');
            if (viewMode === 'collapsed') setViewMode('expanded');
          }}
          onMouseEnter={showTooltip(L('stats'))}
          onMouseLeave={hideTooltip}
          onMouseMove={moveTooltip}
        >
          <IconStats size={18} />
        </button>
        
        {isSessionActive && (
          <button 
            className={`overlay-btn ${isPaused ? 'paused' : ''}`}
            onClick={handleTogglePause}
            onMouseEnter={showTooltip(isPaused ? L('resume') : L('pause'))}
            onMouseLeave={hideTooltip}
            onMouseMove={moveTooltip}
          >
            {isPaused ? <IconPlay size={18} /> : <IconPause size={18} />}
          </button>
        )}
        
        <button 
          className={`overlay-btn ${activeTab === 'add-drop' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('add-drop');
            if (viewMode === 'collapsed') setViewMode('expanded');
          }}
          onMouseEnter={showTooltip(L('addDrop'))}
          onMouseLeave={hideTooltip}
          onMouseMove={moveTooltip}
        >
          <IconCoins size={18} />
        </button>
        
        <button 
          className={`overlay-btn ${activeTab === 'session-preset' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('session-preset');
            if (viewMode === 'collapsed') setViewMode('expanded');
          }}
          onMouseEnter={showTooltip(L('sessionPresets'))}
          onMouseLeave={hideTooltip}
          onMouseMove={moveTooltip}
        >
          <IconExpense size={18} />
        </button>
        
        <div className="overlay-btn-divider" />
        
        <button 
          className={`overlay-btn ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('settings');
            if (viewMode === 'collapsed') setViewMode('expanded');
          }}
          onMouseEnter={showTooltip(L('settings'))}
          onMouseLeave={hideTooltip}
          onMouseMove={moveTooltip}
        >
          <IconSettings size={18} />
        </button>
        
        {/* Mini stats when collapsed and session active */}
        {viewMode === 'collapsed' && isSessionActive && stats && (
          <div className="sidebar-mini-stats">
            <div 
              className="mini-stat"
              onMouseEnter={showTooltip(lang === 'ru' ? `Время сессии: ${formatDuration(displayDuration)}` : `Session time: ${formatDuration(displayDuration)}`)}
              onMouseLeave={hideTooltip}
              onMouseMove={moveTooltip}
            >
              <span className="mini-stat-value">{formatDurationCompact(displayDuration)}</span>
              <span className="mini-stat-label">{lang === 'ru' ? 'время' : 'time'}</span>
            </div>
            <div 
              className="mini-stat"
              onMouseEnter={showTooltip(
                activePreset?.targetMaps 
                  ? (lang === 'ru' 
                      ? `Осталось ${Math.max(0, activePreset.targetMaps - stats.maps_completed)} из ${activePreset.targetMaps} карт`
                      : `${Math.max(0, activePreset.targetMaps - stats.maps_completed)} of ${activePreset.targetMaps} maps remaining`)
                  : (lang === 'ru' ? `Пройдено карт: ${stats.maps_completed}` : `Maps completed: ${stats.maps_completed}`)
              )}
              onMouseLeave={hideTooltip}
              onMouseMove={moveTooltip}
            >
              <span className="mini-stat-value">
                {activePreset?.targetMaps 
                  ? Math.max(0, activePreset.targetMaps - stats.maps_completed)
                  : stats.maps_completed
                }
              </span>
              <span className="mini-stat-label">
                {activePreset?.targetMaps ? (lang === 'ru' ? 'ост.' : 'left') : (lang === 'ru' ? 'карт' : 'maps')}
              </span>
            </div>
            <div 
              className="mini-stat"
              onMouseEnter={showTooltip(lang === 'ru' 
                ? `Среднее время на карту: ${avgTimePerMap > 0 ? formatDurationShort(avgTimePerMap) : 'нет данных'}`
                : `Avg time per map: ${avgTimePerMap > 0 ? formatDurationShort(avgTimePerMap) : 'no data'}`
              )}
              onMouseLeave={hideTooltip}
              onMouseMove={moveTooltip}
            >
              <span className="mini-stat-value">{avgTimePerMap > 0 ? formatDurationShort(avgTimePerMap) : '—'}</span>
              <span className="mini-stat-label">{lang === 'ru' ? '/карта' : '/map'}</span>
            </div>
            <div 
              className="mini-stat"
              onMouseEnter={showTooltip(lang === 'ru' ? `Профит в час: ${formatNumber(profitPerHour)} FE` : `Profit per hour: ${formatNumber(profitPerHour)} FE`)}
              onMouseLeave={hideTooltip}
              onMouseMove={moveTooltip}
            >
              <span className={`mini-stat-value ${profitPerHour >= 0 ? 'profit' : 'expense'}`}>
                {formatNumber(profitPerHour)}
              </span>
              <span className="mini-stat-label">{L('fePerHour')}</span>
            </div>
          </div>
        )}
        
        {/* Drag area + spacer to push profile to bottom */}
        <div className="sidebar-drag-spacer drag-handle" />
        
        {/* Drag handle button */}
        <div 
          className="overlay-btn drag-btn"
          data-tauri-drag-region
          onMouseEnter={showTooltip(L('dragWindow'))}
          onMouseLeave={hideTooltip}
          onMouseMove={moveTooltip}
        >
          <IconMove size={16} />
        </div>
        
        {/* Toggle collapse button */}
        <button 
          className="overlay-btn toggle-btn"
          onClick={() => setViewMode(viewMode === 'collapsed' ? 'expanded' : 'collapsed')}
          onMouseEnter={showTooltip(viewMode === 'collapsed' ? L('expand') : L('collapse'))}
          onMouseLeave={hideTooltip}
          onMouseMove={moveTooltip}
        >
          {viewMode === 'collapsed' ? <IconExpand size={16} /> : <IconCollapse size={16} />}
        </button>
        
        {/* Profile/Login button - always at bottom */}
        {/* About button */}
        <button 
          className={`overlay-btn about-btn ${activeTab === 'about' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('about');
            if (viewMode === 'collapsed') setViewMode('expanded');
          }}
          onMouseEnter={showTooltip(L('about'))}
          onMouseLeave={hideTooltip}
          onMouseMove={moveTooltip}
        >
          <IconHeart size={16} />
        </button>
        
        {/* Profile button */}
        <button 
          className={`overlay-btn profile-btn ${activeTab === 'profile' ? 'active' : ''} ${auth?.is_logged_in ? 'logged-in' : ''}`}
          onClick={() => {
            setActiveTab('profile');
            if (viewMode === 'collapsed') setViewMode('expanded');
          }}
          onMouseEnter={showTooltip(auth?.is_logged_in 
            ? (profile?.display_name || profile?.username || auth.email || L('profile'))
            : L('login')
          )}
          onMouseLeave={hideTooltip}
          onMouseMove={moveTooltip}
        >
          {profile?.avatar_url ? (
            <img 
              src={profile.avatar_url} 
              alt="" 
              className="profile-avatar-btn"
            />
          ) : (
            <IconUser size={18} />
          )}
        </button>
      </div>
      
      {/* Tooltip Portal */}
      {tooltip && <Tooltip {...tooltip} />}

      {/* Main Panel */}
      {viewMode === 'expanded' && (
        <div className="overlay-main" style={{ opacity: appSettings.opacity }}>
          {/* Header - drag region for window moving */}
          <div className="overlay-header">
            <div className="overlay-title drag-handle">
              <h1>TLI Companion</h1>
              <span className="overlay-version">v{version}</span>
            </div>
            <div className="window-controls">
              <button className="window-btn minimize" onClick={handleMinimize}>
                <IconMinus size={12} />
              </button>
              <button className="window-btn close" onClick={handleClose}>
                <IconClose size={12} />
              </button>
            </div>
          </div>

          {/* ======== STATS TAB ======== */}
          {activeTab === 'stats' && (
            <>
              {/* Paused Banner */}
              {isPaused && (
                <div className="overlay-paused-banner" onClick={handleTogglePause}>
                  <IconPause size={16} />
                  <div className="pause-banner-content">
                    <span className="pause-banner-title">{L('paused')}</span>
                    <span className="pause-banner-hint">{L('pausedDescription')}</span>
                  </div>
                </div>
              )}

              {/* Compact Stats Row */}
          {stats && (
            <div className="overlay-stats-compact">
              <div className="stat-item">
                <span className="stat-value">{formatDuration(displayDuration)}</span>
                <span className="stat-label">{L('time')}</span>
              </div>
              <div className="stat-item">
                <span className="stat-value">
                  {activePreset?.targetMaps 
                    ? Math.max(0, activePreset.targetMaps - stats.maps_completed)
                    : stats.maps_completed
                  }
                </span>
                <span className="stat-label">
                  {activePreset?.targetMaps ? L('remaining') : L('maps')}
                </span>
              </div>
              <div className="stat-item">
                <span className="stat-value">{avgTimePerMap > 0 ? formatDurationShort(avgTimePerMap) : '—'}</span>
                <span className="stat-label">{L('perMap')}</span>
              </div>
              <div className="stat-item highlight">
                <span className="stat-value">{formatNumber(profitPerHour)}</span>
                <span className="stat-label">{L('fePerHour')}</span>
              </div>
            </div>
          )}

          {/* Financial Summary */}
          {stats && (
            <div className="overlay-summary">
              <div className="summary-row">
                <span className="summary-label"><IconCoins size={12} /> {L('income')}</span>
                <span className="summary-value income">+{formatNumber(totalIncome)}</span>
              </div>
              {manualDrops.length > 0 && (
                <div className="manual-drops-note">
                  +{formatNumber(manualDropsIncome)} {lang === 'ru' ? 'вручную' : 'manual'}
                </div>
              )}
              {stats.stale_price_lines > 0 && (
                <div className="stale-warning">
                  <IconWarning size={11} /> {stats.stale_price_lines} {lang === 'ru' ? 'устар. цен' : 'stale prices'}
                </div>
              )}
              <div className="summary-row">
                <span className="summary-label"><IconExpense size={12} /> {L('expenses')}</span>
                <span className="summary-value expense">-{formatNumber(totalExpenses)}</span>
              </div>
              <div className="summary-row">
                <span className="summary-label"><IconSettings size={12} /> {L('commission')} {(appSettings.auction_fee_rate * 100).toFixed(1)}%</span>
                <span className="summary-value expense">-{formatNumber(totalFee)}</span>
              </div>
              <div className="summary-divider" />
              <div className="summary-row total">
                <span className="summary-label"><IconStar size={12} /> {L('netProfit')}</span>
                <span className={`summary-value ${netProfit >= 0 ? 'profit' : 'expense'}`}>
                  {netProfit >= 0 ? '+' : ''}{formatNumber(netProfit)}
                </span>
              </div>
            </div>
          )}

          {/* Drops List */}
          <div className="overlay-drops">
            <div className="drops-header">
              <span className="drops-title">{L('drop')}</span>
              <div className="drops-header-right">
                {isSessionActive && (
                  <button 
                    className="drops-add-btn"
                    onClick={() => setActiveTab('add-drop')}
                    title={L('addDrop')}
                  >
                    +
                  </button>
                )}
                <span className="drops-count">{drops.length + manualDrops.length}</span>
              </div>
            </div>
            
            {drops.length === 0 && manualDrops.length === 0 ? (
              <div className="drops-empty">
                <IconBox size={24} style={{ opacity: 0.4 }} />
                <span>{isSessionActive ? L('waitingForDrop') : L('selectPreset')}</span>
              </div>
            ) : (
              <div className="drops-list-scroll">
                {/* Manual drops first - with special styling */}
                {manualDrops.map((drop) => (
                  <div key={drop.id} className="drop-item manual">
                    <div className="drop-info">
                      <span className="drop-manual-badge" title="Добавлено вручную">✎</span>
                      <span className="drop-name">{lang === 'ru' ? (drop.name_ru || drop.name) : (drop.name || drop.name_ru)}</span>
                      <span className="drop-qty">x{drop.quantity}</span>
                    </div>
                    <div className="drop-value-wrapper">
                      <span className="drop-value manual">
                        {formatNumber(drop.quantity * drop.price)}
                      </span>
                      <button 
                        className="drop-remove-btn"
                        onClick={() => handleRemoveManualDrop(drop.id)}
                        title="Удалить"
                      >
                        <IconClose size={10} />
                      </button>
                    </div>
                  </div>
                ))}
                
                {/* Auto-tracked drops */}
                {drops.map((drop) => (
                  <div key={drop.game_id} className="drop-item">
                    <div className="drop-info">
                      <span className="drop-name">{getItemName(drop)}</span>
                      <span className="drop-qty">x{drop.quantity}</span>
                    </div>
                    <div className="drop-value-wrapper">
                      <span className={`drop-value ${drop.price_is_stale || drop.is_previous_season ? 'stale' : ''}`}>
                        {drop.total_value > 0 ? formatNumber(drop.total_value) : '-'}
                      </span>
                      {drop.is_previous_season ? (
                        <span 
                          className="price-badge old-season"
                          onMouseEnter={showTooltip(`Цена из ${drop.league_name || 'прошлого сезона'} — нужен новый прайсчек`)}
                          onMouseLeave={hideTooltip}
                          onMouseMove={moveTooltip}
                        >
                          <IconWarning size={10} /> {drop.league_name || 'стар.'}
                        </span>
                      ) : drop.price_is_stale ? (
                        <span 
                          className="price-badge stale"
                          onMouseEnter={showTooltip(`Цена устарела — обновите прайсчеком`)}
                          onMouseLeave={hideTooltip}
                          onMouseMove={moveTooltip}
                        >
                          {formatPriceAge(drop.price_updated_at)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Controls */}
          <div className="overlay-controls">
            {!isSessionActive ? (
              <button className="control-btn start" onClick={() => {
                setPresetView('list');
                setSelectedPresetId('empty'); // По умолчанию выбран быстрый старт
                setActiveTab('session-preset');
              }}>
                <IconExpense size={14} /> {L('selectPreset')}
              </button>
            ) : (
              <button className="control-btn stop" onClick={handleEndSession}>
                {L('endSession')}
              </button>
            )}
          </div>

          {/* Status Bar */}
          <div className="overlay-status">
            <button 
              className="status-item"
              onClick={() => setShowLogModal(true)}
              onMouseEnter={showTooltip(
                logStatus?.is_active 
                  ? (lang === 'ru' ? 'Лог активен — игра пишет данные' : 'Log active — game is writing data')
                  : logStatus?.exists 
                    ? (lang === 'ru' ? 'Лог неактивен — включите логи в игре (ESC → Other → Enable Log)' : 'Log inactive — enable logging in game (ESC → Other → Enable Log)')
                    : (lang === 'ru' ? 'Лог не найден — нажмите чтобы выбрать' : 'Log not found — click to select')
              )}
              onMouseLeave={hideTooltip}
              onMouseMove={moveTooltip}
            >
              <span className={`status-dot ${logStatus?.is_active ? 'ok' : logStatus?.exists ? 'pending' : 'error'}`} />
              {logStatus?.is_active ? L('logActive') : logStatus?.exists ? L('logInactive') : (lang === 'ru' ? 'Нет лога' : 'No log')}
            </button>
            <div 
              className="status-item"
              onMouseEnter={showTooltip(
                auth?.is_logged_in 
                  ? (lang === 'ru' ? 'Прайсчеки записываются в общую БД' : 'Price checks saved to shared DB')
                  : (lang === 'ru' ? 'Войдите для записи прайсчеков в общую БД' : 'Login to save price checks to shared DB')
              )}
              onMouseLeave={hideTooltip}
              onMouseMove={moveTooltip}
            >
              <span className={`status-dot ${auth?.is_logged_in ? 'ok' : 'muted'}`} />
              {auth?.is_logged_in ? L('synced') : (lang === 'ru' ? 'Локально' : 'Local')}
            </div>
          </div>
            </>
          )}

          {/* ======== PROFILE TAB ======== */}
          {activeTab === 'profile' && (
            <div className="profile-tab">
              {auth?.is_logged_in ? (
                <>
                  {/* User Profile */}
                  <div className="profile-header">
                    {profile?.avatar_url && (
                      <img className="profile-avatar-large" src={profile.avatar_url} alt="" />
                    )}
                    <div className="profile-info">
                      <div className="profile-name">
                        {profile?.display_name || profile?.username || auth.email}
                      </div>
                      {profile?.level && (
                        <div className="profile-level">
                          Уровень {profile.level}
                          {profile.total_xp ? ` · ${profile.total_xp} XP` : ''}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Sessions Section */}
                  <div className="profile-section">
                    <div className="section-title">
                      <IconBox size={14} /> {L('sessionHistory')}
                      <button 
                        className="refresh-btn" 
                        onClick={loadSessionHistory}
                        disabled={sessionHistoryLoading}
                      >
                        {sessionHistoryLoading ? '...' : '↻'}
                      </button>
                    </div>
                    {sessionHistoryLoading ? (
                      <div className="sessions-loading">{lang === 'ru' ? 'Загрузка...' : 'Loading...'}</div>
                    ) : sessionHistory.length === 0 ? (
                      <div className="sessions-placeholder">
                        <p>{lang === 'ru' ? 'История сессий появится здесь' : 'Session history will appear here'}</p>
                        <p className="hint">{lang === 'ru' ? 'Завершите сессию для сохранения' : 'Complete a session to save'}</p>
                      </div>
                    ) : (
                      <div className="sessions-list">
                        {sessionHistory.map((session) => {
                          const profit = session.total_profit;
                          const expenses = session.total_expenses;
                          const duration = session.total_duration_sec;
                          const hours = Math.floor(duration / 3600);
                          const mins = Math.floor((duration % 3600) / 60);
                          const durationStr = hours > 0 
                            ? `${hours}${lang === 'ru' ? 'ч' : 'h'} ${mins}${lang === 'ru' ? 'м' : 'm'}` 
                            : `${mins}${lang === 'ru' ? 'м' : 'm'}`;
                          const date = new Date(session.started_at);
                          const dateStr = date.toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-US', { 
                            day: 'numeric', 
                            month: 'short' 
                          });
                          
                          return (
                            <div key={session.id} className="session-card">
                              <div className="session-card-header">
                                <div className="session-date">{dateStr}</div>
                                <button 
                                  className="session-delete-btn"
                                  onClick={() => handleDeleteSession(session.id)}
                                  title={L('deleteSession')}
                                >
                                  <IconClose size={12} />
                                </button>
                              </div>
                              <div className="session-stats">
                                <span className="session-maps">
                                  {session.maps_completed} {lang === 'ru' ? 'карт' : 'maps'}
                                </span>
                                <span className="session-duration">{durationStr}</span>
                              </div>
                              <div className="session-profit">
                                <span className={profit >= 0 ? 'positive' : 'negative'}>
                                  {profit >= 0 ? '+' : ''}{formatNumber(profit)} FE
                                </span>
                                {expenses > 0 && (
                                  <span className="session-expenses">
                                    -{formatNumber(expenses)}
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Logout Button */}
                  <div className="profile-actions">
                    {!showLogoutConfirm ? (
                      <button className="control-btn logout" onClick={() => setShowLogoutConfirm(true)}>
                        {L('logout')}
                      </button>
                    ) : (
                      <div className="logout-confirm">
                        <span className="logout-confirm-text">{L('logoutConfirm')}</span>
                        <div className="logout-confirm-actions">
                          <button className="confirm-btn cancel" onClick={() => setShowLogoutConfirm(false)}>
                            {L('no')}
                          </button>
                          <button className="confirm-btn danger" onClick={handleAuthSignOut}>
                            {L('yes')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <>
                  {/* Login Prompt */}
                  <div className="login-prompt">
                    <IconUser size={48} style={{ opacity: 0.3 }} />
                    <h3>{lang === 'ru' ? 'Вход в аккаунт' : 'Sign In'}</h3>
                    <p>
                      {lang === 'ru' 
                        ? 'Войдите для синхронизации сессий и записи прайсчеков в общую базу данных.'
                        : 'Sign in to sync sessions and record price checks to shared database.'
                      }
                    </p>
                    <p className="hint">
                      {lang === 'ru' 
                        ? 'Трекинг работает и без логина — данные сохраняются локально.'
                        : 'Tracking works without login — data is saved locally.'
                      }
                    </p>
                  </div>

                  <div className="profile-actions">
                    <button className="control-btn start" onClick={handleAuthSignIn}>
                      {L('loginViaKripika')}
                    </button>
                  </div>

                  {authError && (
                    <div className="auth-error">{authError}</div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ======== ADD DROP TAB ======== */}
          {activeTab === 'add-drop' && (
            <div className="manual-entry-tab">
              <div className="manual-entry-header">
                <IconCoins size={18} />
                <h3>{L('addDrop')}</h3>
              </div>
              <p className="manual-entry-hint">
                {lang === 'ru' 
                  ? 'Для экипировки и уников с разными статами.'
                  : 'For gear and uniques with different stats.'
                }
                {!isSessionActive && <span className="warning"> {lang === 'ru' ? 'Нужна активная сессия!' : 'Active session required!'}</span>}
              </p>
              
              <div className="manual-entry-form">
                <div className="form-group search-group">
                  <label>{L('searchItem')}</label>
                  <input 
                    type="text" 
                    className="overlay-input"
                    placeholder={lang === 'ru' ? 'Введите название...' : 'Enter item name...'}
                    value={manualSearch}
                    onChange={e => {
                      setManualSearch(e.target.value);
                      setSelectedItem(null);
                      setIsCustomItem(false);
                    }}
                    onFocus={() => !selectedItem && !isCustomItem && manualSearch.length >= 2 && setShowSearchDropdown(true)}
                  />
                  {showSearchDropdown && !selectedItem && !isCustomItem && (
                    <div className="search-dropdown">
                      {searchResults.map(item => {
                        const price = getCachedPrice(item.game_id);
                        return (
                          <div 
                            key={item.game_id} 
                            className="search-item"
                            onClick={() => handleSelectItem(item)}
                          >
                            <div className="search-item-info">
                              <span className="search-item-name">
                                {lang === 'ru' ? (item.name_ru || item.name_en || item.name) : (item.name_en || item.name_ru || item.name)}
                              </span>
                              {item.name_en && item.name_ru && (
                                <span className="search-item-name-en">{lang === 'ru' ? item.name_en : item.name_ru}</span>
                              )}
                            </div>
                            {price !== null && (
                              <span className="search-item-price">{formatNumber(price)} FE</span>
                            )}
                          </div>
                        );
                      })}
                      {/* Always show custom item option */}
                      {manualSearch.length >= 2 && (
                        <div className="search-item custom" onClick={handleUseCustomItem}>
                          <span className="search-item-name">+ {lang === 'ru' ? `Добавить "${manualSearch}" вручную` : `Add "${manualSearch}" manually`}</span>
                          <span className="search-item-hint">{L('customItem')}</span>
                        </div>
                      )}
                    </div>
                  )}
                  {(selectedItem || isCustomItem) && (
                    <div className="selected-item-badge">
                      {selectedItem ? (
                        <>
                          <span className="selected-item-name">
                            {lang === 'ru' ? (selectedItem.name_ru || selectedItem.name_en || selectedItem.name) : (selectedItem.name_en || selectedItem.name_ru || selectedItem.name)}
                          </span>
                          {selectedItem.name_en && selectedItem.name_ru && (
                            <span className="selected-item-name-en">{lang === 'ru' ? selectedItem.name_en : selectedItem.name_ru}</span>
                          )}
                        </>
                      ) : (
                        <span className="custom-badge">{lang === 'ru' ? 'Кастомный:' : 'Custom:'} {manualSearch}</span>
                      )}
                    </div>
                  )}
                </div>
                
                <div className="form-row">
                  <div className="form-group">
                    <label>{L('quantity')}</label>
                    <input 
                      type="number" 
                      className="overlay-input"
                      min="1"
                      value={manualQuantity}
                      onChange={e => setManualQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                    />
                  </div>
                  <div className="form-group">
                    <label>{L('price')}</label>
                    <input 
                      type="number" 
                      className="overlay-input"
                      min="0"
                      step="0.1"
                      placeholder="0"
                      value={manualPrice || ''}
                      onChange={e => setManualPrice(parseFloat(e.target.value) || 0)}
                    />
                  </div>
                </div>
                
                <div className="form-total">
                  {L('total')}: <strong>{formatNumber(manualQuantity * manualPrice)} FE</strong>
                </div>
              </div>

              {/* Current manual drops */}
              {manualDrops.length > 0 && (
                <div className="expenses-list">
                  <div className="expenses-list-title">{lang === 'ru' ? 'Добавленный дроп:' : 'Added drops:'}</div>
                  {manualDrops.map(drop => (
                    <div key={drop.id} className="expense-item">
                      <div className="expense-info">
                        <span className="expense-name">{lang === 'ru' ? (drop.name_ru || drop.name) : (drop.name || drop.name_ru)}</span>
                        <span className="expense-qty">×{drop.quantity}</span>
                      </div>
                      <div className="expense-value">
                        <span className="income">+{formatNumber(drop.quantity * drop.price)}</span>
                        <button 
                          className="expense-remove"
                          onClick={() => handleRemoveManualDrop(drop.id)}
                        >
                          <IconClose size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              
              <div className="manual-entry-actions">
                <button className="control-btn" onClick={() => { resetManualForm(); setActiveTab('stats'); }}>
                  {L('back')}
                </button>
                <button 
                  className="control-btn start" 
                  onClick={handleAddManualDrop}
                  disabled={!(selectedItem || isCustomItem) || manualPrice <= 0 || !isSessionActive}
                >
                  {L('add')}
                </button>
              </div>
            </div>
          )}

          {/* ======== SESSION PRESET TAB ======== */}
          {activeTab === 'session-preset' && (
            <div className="manual-entry-tab">
              <div className="manual-entry-header">
                <IconExpense size={18} />
                <h3>{L('sessionPresets')}</h3>
              </div>
              
              {presetView === 'list' && (
                <>
                  <p className="manual-entry-hint">
                    {lang === 'ru' ? 'Выберите пресет и нажмите кнопку запуска' : 'Select a preset and click start'}
                  </p>
                  
                  {/* Presets list */}
                  <div className="presets-list">
                    {/* Empty preset option */}
                    <div 
                      className={`preset-card selectable ${selectedPresetId === 'empty' ? 'selected' : ''}`}
                      onClick={() => setSelectedPresetId('empty')}
                    >
                      <div className="preset-select-indicator">
                        {selectedPresetId === 'empty' && <IconStar size={14} />}
                      </div>
                      <div className="preset-info">
                        <div className="preset-name">{lang === 'ru' ? 'Быстрый старт' : 'Quick Start'}</div>
                        <div className="preset-meta">{L('emptyPresetDesc')}</div>
                      </div>
                    </div>
                    
                    {presets.map(preset => {
                      const totalCost = preset.items.reduce((s, i) => s + i.quantity * i.price, 0);
                      const perMap = preset.targetMaps > 0 ? totalCost / preset.targetMaps : totalCost;
                      const isSelected = selectedPresetId === preset.id;
                      return (
                        <div 
                          key={preset.id} 
                          className={`preset-card selectable ${isSelected ? 'selected' : ''}`}
                          onClick={() => setSelectedPresetId(preset.id)}
                        >
                          <div className="preset-select-indicator">
                            {isSelected && <IconStar size={14} />}
                          </div>
                          <div className="preset-info">
                            <div className="preset-name">{preset.name}</div>
                            <div className="preset-meta">
                              {preset.targetMaps > 0 ? `${preset.targetMaps} ${lang === 'ru' ? 'карт' : 'maps'} · ` : ''}
                              {formatNumber(perMap)} FE/{lang === 'ru' ? 'карта' : 'map'}
                            </div>
                          </div>
                          <div className="preset-actions" onClick={e => e.stopPropagation()}>
                            <button 
                              className={`preset-btn share ${shareSuccess === preset.id ? 'success' : ''}`}
                              onClick={() => handleSharePreset(preset)}
                              title={shareSuccess === preset.id ? L('copied') : L('sharePreset')}
                            >
                              <IconExpand size={12} />
                            </button>
                            <button 
                              className="preset-btn edit"
                              onClick={() => handleEditPreset(preset)}
                              title={L('editPreset')}
                            >
                              <IconSettings size={12} />
                            </button>
                            <button 
                              className="preset-btn delete"
                              onClick={() => handleDeletePreset(preset.id)}
                              title={L('deletePreset')}
                            >
                              <IconClose size={12} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  
                  {/* Start session button */}
                  <button 
                    className={`start-session-btn ${selectedPresetId ? 'ready' : ''}`}
                    onClick={() => {
                      if (selectedPresetId === 'empty') {
                        handleStartWithPreset(null);
                      } else if (selectedPresetId) {
                        const preset = presets.find(p => p.id === selectedPresetId);
                        if (preset) handleStartWithPreset(preset);
                      }
                    }}
                    disabled={!selectedPresetId}
                  >
                    <IconPlay size={20} />
                    <span>{L('startSession')}</span>
                  </button>
                  
                  <div className="manual-entry-actions">
                    <button className="control-btn" onClick={() => setActiveTab('stats')}>
                      {L('back')}
                    </button>
                    <button className="control-btn import" onClick={handleOpenImport} title={L('importPreset')}>
                      <IconClipboard size={14} /> {L('import')}
                    </button>
                    <button className="control-btn start" onClick={handleCreatePreset}>
                      <span>+ {lang === 'ru' ? 'Новый' : 'New'}</span>
                    </button>
                  </div>
                </>
              )}
              
              {presetView === 'edit' && (
                <>
                  {/* Preset edit mode */}
                  <div className="form-group">
                    <label>{L('presetName')}</label>
                    <input 
                      type="text" 
                      className="overlay-input"
                      placeholder={lang === 'ru' ? 'Например: T16 Deep Space' : 'e.g. T16 Deep Space'}
                      value={presetName}
                      onChange={e => setPresetName(e.target.value)}
                    />
                  </div>
                  
                  <div className="form-group">
                    <label>{L('targetMaps')}</label>
                    <div className="target-maps-input">
                      <input 
                        type="number" 
                        className="overlay-input"
                        placeholder={lang === 'ru' ? '0 = без ограничения' : '0 = no limit'}
                        min="0"
                        value={presetTargetMaps || ''}
                        onChange={e => setPresetTargetMaps(Math.max(0, parseInt(e.target.value) || 0))}
                      />
                      <span className="input-hint">
                        {presetTargetMaps > 0 
                          ? (lang === 'ru' ? `Затраты будут разделены на ${presetTargetMaps} карт` : `Expenses will be split over ${presetTargetMaps} maps`)
                          : (lang === 'ru' ? 'Указанные затраты — за 1 карту' : 'Expenses listed are per 1 map')
                        }
                      </span>
                    </div>
                  </div>
                  
                  <div className="preset-divider" />
                  
                  {/* Add item form */}
                  <div className="form-group search-group">
                    <label>{lang === 'ru' ? 'Добавить предмет' : 'Add item'}</label>
                    <input 
                      type="text" 
                      className="overlay-input"
                      placeholder={lang === 'ru' ? 'Поиск...' : 'Search...'}
                      value={manualSearch}
                      onChange={e => {
                        setManualSearch(e.target.value);
                        setSelectedItem(null);
                        setIsCustomItem(false);
                      }}
                      onFocus={() => !selectedItem && !isCustomItem && manualSearch.length >= 2 && setShowSearchDropdown(true)}
                    />
                    {showSearchDropdown && !selectedItem && !isCustomItem && (
                      <div className="search-dropdown">
                        {searchResults.map(item => {
                          const price = getCachedPrice(item.game_id);
                          return (
                            <div 
                              key={item.game_id} 
                              className="search-item"
                              onClick={() => handleSelectItem(item)}
                            >
                              <div className="search-item-info">
                                <span className="search-item-name">
                                  {lang === 'ru' ? (item.name_ru || item.name_en || item.name) : (item.name_en || item.name_ru || item.name)}
                                </span>
                                {item.name_en && item.name_ru && (
                                  <span className="search-item-name-en">{lang === 'ru' ? item.name_en : item.name_ru}</span>
                                )}
                              </div>
                              {price !== null && (
                                <span className="search-item-price">{formatNumber(price)} FE</span>
                              )}
                            </div>
                          );
                        })}
                        {/* Always show custom item option */}
                        {manualSearch.length >= 2 && (
                          <div className="search-item custom" onClick={handleUseCustomItem}>
                            <span className="search-item-name">+ {lang === 'ru' ? `Добавить "${manualSearch}" вручную` : `Add "${manualSearch}" manually`}</span>
                            <span className="search-item-hint">{L('customItem')}</span>
                          </div>
                        )}
                      </div>
                    )}
                    {(selectedItem || isCustomItem) && (
                      <div className="selected-item-badge">
                        {selectedItem ? (
                          <>
                            <span className="selected-item-name">
                              {lang === 'ru' ? (selectedItem.name_ru || selectedItem.name_en || selectedItem.name) : (selectedItem.name_en || selectedItem.name_ru || selectedItem.name)}
                            </span>
                            {selectedItem.name_en && selectedItem.name_ru && (
                              <span className="selected-item-name-en">{lang === 'ru' ? selectedItem.name_en : selectedItem.name_ru}</span>
                            )}
                          </>
                        ) : (
                          <span className="custom-badge">{lang === 'ru' ? 'Кастомный:' : 'Custom:'} {manualSearch}</span>
                        )}
                      </div>
                    )}
                  </div>
                  
                  <div className="form-row">
                    <div className="form-group">
                      <label>{L('quantity')}</label>
                      <input 
                        type="number" 
                        className="overlay-input"
                        min="1"
                        value={manualQuantity}
                        onChange={e => setManualQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                      />
                    </div>
                    <div className="form-group">
                      <label>{L('price')}</label>
                      <input 
                        type="number" 
                        className="overlay-input"
                        min="0"
                        step="0.1"
                        placeholder="0"
                        value={manualPrice || ''}
                        onChange={e => setManualPrice(parseFloat(e.target.value) || 0)}
                      />
                    </div>
                    <button 
                      className="add-item-btn"
                      onClick={handleAddExpense}
                      disabled={!(selectedItem || isCustomItem) || manualPrice <= 0}
                    >
                      +
                    </button>
                  </div>
                  
                  {/* Items in preset */}
                  {expenses.length > 0 && (
                    <div className="expenses-list">
                      <div className="expenses-list-title">{lang === 'ru' ? 'Предметы в пресете:' : 'Items in preset:'}</div>
                      {expenses.map(exp => (
                        <div key={exp.id} className={`expense-item ${editingExpenseId === exp.id ? 'editing' : ''}`}>
                          {editingExpenseId === exp.id ? (
                            <>
                              <div className="expense-edit-form">
                                <span className="expense-name">{lang === 'ru' ? (exp.name_ru || exp.name) : (exp.name || exp.name_ru)}</span>
                                <div className="expense-edit-inputs">
                                  <input
                                    type="number"
                                    className="expense-edit-input"
                                    value={editExpenseQty}
                                    onChange={e => setEditExpenseQty(Math.max(1, parseInt(e.target.value) || 1))}
                                    min="1"
                                    placeholder={lang === 'ru' ? 'Кол-во' : 'Qty'}
                                  />
                                  <span className="expense-edit-x">×</span>
                                  <input
                                    type="number"
                                    className="expense-edit-input"
                                    value={editExpensePrice || ''}
                                    onChange={e => setEditExpensePrice(parseFloat(e.target.value) || 0)}
                                    min="0"
                                    step="0.01"
                                    placeholder={lang === 'ru' ? 'Цена' : 'Price'}
                                  />
                                </div>
                              </div>
                              <div className="expense-edit-actions">
                                <button className="expense-edit-btn save" onClick={handleSaveEditExpense}>✓</button>
                                <button className="expense-edit-btn cancel" onClick={handleCancelEditExpense}>✕</button>
                              </div>
                            </>
                          ) : (
                            <>
                              <div 
                                className="expense-info clickable"
                                onClick={() => handleStartEditExpense(exp)}
                                title={lang === 'ru' ? 'Нажмите для редактирования' : 'Click to edit'}
                              >
                                <span className="expense-name">{lang === 'ru' ? (exp.name_ru || exp.name) : (exp.name || exp.name_ru)}</span>
                                <span className="expense-qty">×{exp.quantity}</span>
                                {exp.game_id && <span className="expense-linked">✓</span>}
                              </div>
                              <div className="expense-value">
                                <span>-{formatNumber(exp.quantity * exp.price)}</span>
                                <button 
                                  className="expense-remove"
                                  onClick={() => handleRemoveExpense(exp.id)}
                                >
                                  <IconClose size={12} />
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                      <div className="expenses-total">
                        {L('total')}: <strong>-{formatNumber(totalExpenses)} FE</strong>
                      </div>
                    </div>
                  )}
                  
                  <div className="manual-entry-actions">
                    <button className="control-btn" onClick={handleCancelPresetEdit}>
                      {L('cancel')}
                    </button>
                    <button 
                      className="control-btn start" 
                      onClick={handleSavePreset}
                      disabled={!presetName.trim()}
                    >
                      {L('save')}
                    </button>
                  </div>
                </>
              )}
              
              {/* Import preset view */}
              {presetView === 'import' && (
                <div className="import-preset-view">
                  <p className="manual-entry-hint">
                    {lang === 'ru' 
                      ? 'Вставьте код пресета, который вам отправили (начинается с TLI:)'
                      : 'Paste the preset code you received (starts with TLI:)'
                    }
                  </p>
                  
                  <div className="form-group">
                    <label>{lang === 'ru' ? 'Код пресета' : 'Preset code'}</label>
                    <textarea 
                      className="overlay-input import-textarea"
                      placeholder="TLI:eyJ2IjoxL..."
                      value={importCode}
                      onChange={e => {
                        setImportCode(e.target.value);
                        setImportError('');
                      }}
                      rows={3}
                    />
                  </div>
                  
                  {importError && (
                    <div className="import-error">
                      <IconWarning size={14} /> {importError}
                    </div>
                  )}
                  
                  <div className="manual-entry-actions">
                    <button className="control-btn" onClick={() => setPresetView('list')}>
                      {L('back')}
                    </button>
                    <button 
                      className="control-btn start" 
                      onClick={handleImportPreset}
                      disabled={!importCode.trim()}
                    >
                      {L('import')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          
          {/* Settings Tab */}
          {activeTab === 'settings' && (
            <div className="settings-tab-content">
              <div className="settings-tab-header">
                <h3><IconSettings size={16} /> {L('settings')}</h3>
                <span className="settings-version-inline">v{version}</span>
              </div>
              
              <div className="settings-tab-scroll">
                {/* Язык */}
                <div className="settings-group">
                  <label className="settings-label">{L('language')} / Language</label>
                  <div className="settings-row">
                    <button 
                      className={`settings-toggle ${appSettings.language === 'ru' ? 'active' : ''}`}
                      onClick={() => handleSaveSettings({ ...appSettings, language: 'ru' })}
                    >
                      Русский
                    </button>
                    <button 
                      className={`settings-toggle ${appSettings.language === 'en' ? 'active' : ''}`}
                      onClick={() => handleSaveSettings({ ...appSettings, language: 'en' })}
                    >
                      English
                    </button>
                  </div>
                </div>

                {/* Ориентация */}
                <div className="settings-group">
                  <label className="settings-label">{L('interfaceOrientation')}</label>
                  <div className="settings-row">
                    <button 
                      className={`settings-toggle ${appSettings.layout_orientation === 'vertical' ? 'active' : ''}`}
                      onClick={() => handleSaveSettings({ 
                        ...appSettings, 
                        layout_orientation: 'vertical',
                        panel_direction: appSettings.panel_direction === 'top' || appSettings.panel_direction === 'bottom' 
                          ? 'right' : appSettings.panel_direction
                      })}
                    >
                      {L('vertical')}
                    </button>
                    <button 
                      className={`settings-toggle ${appSettings.layout_orientation === 'horizontal' ? 'active' : ''}`}
                      onClick={() => handleSaveSettings({ 
                        ...appSettings, 
                        layout_orientation: 'horizontal',
                        panel_direction: appSettings.panel_direction === 'left' || appSettings.panel_direction === 'right' 
                          ? 'bottom' : appSettings.panel_direction
                      })}
                    >
                      {L('horizontal')}
                    </button>
                  </div>
                </div>

                {/* Направление панелей */}
                <div className="settings-group">
                  <label className="settings-label">{L('panelDirection')}</label>
                  <div className="settings-row">
                    {appSettings.layout_orientation === 'vertical' ? (
                      <>
                        <button 
                          className={`settings-toggle ${appSettings.panel_direction === 'left' ? 'active' : ''}`}
                          onClick={() => handleSaveSettings({ ...appSettings, panel_direction: 'left' })}
                        >
                          ← {L('left')}
                        </button>
                        <button 
                          className={`settings-toggle ${appSettings.panel_direction === 'right' ? 'active' : ''}`}
                          onClick={() => handleSaveSettings({ ...appSettings, panel_direction: 'right' })}
                        >
                          {L('right')} →
                        </button>
                      </>
                    ) : (
                      <>
                        <button 
                          className={`settings-toggle ${appSettings.panel_direction === 'top' ? 'active' : ''}`}
                          onClick={() => handleSaveSettings({ ...appSettings, panel_direction: 'top' })}
                        >
                          ↑ {L('top')}
                        </button>
                        <button 
                          className={`settings-toggle ${appSettings.panel_direction === 'bottom' ? 'active' : ''}`}
                          onClick={() => handleSaveSettings({ ...appSettings, panel_direction: 'bottom' })}
                        >
                          {L('bottom')} ↓
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Комиссия аукциона */}
                <div className="settings-group">
                  <label className="settings-label">
                    {L('auctionFee')}: {(appSettings.auction_fee_rate * 100).toFixed(1)}%
                  </label>
                  <input 
                    type="range" 
                    min="0" 
                    max="25" 
                    step="0.5"
                    value={appSettings.auction_fee_rate * 100}
                    onChange={(e) => handleSaveSettings({ 
                      ...appSettings, 
                      auction_fee_rate: parseFloat(e.target.value) / 100 
                    })}
                    className="settings-slider"
                  />
                </div>

                {/* Прозрачность */}
                <div className="settings-group">
                  <label className="settings-label">
                    {L('windowOpacity')}: {Math.round(appSettings.opacity * 100)}%
                  </label>
                  <input 
                    type="range" 
                    min="50" 
                    max="100" 
                    step="5"
                    value={appSettings.opacity * 100}
                    onChange={(e) => handleSaveSettings({ 
                      ...appSettings, 
                      opacity: parseFloat(e.target.value) / 100 
                    })}
                    className="settings-slider"
                  />
                </div>

                {/* Всегда поверх окон */}
                <div className="settings-group">
                  <label className="settings-checkbox">
                    <input 
                      type="checkbox" 
                      checked={appSettings.always_on_top}
                      onChange={(e) => handleSaveSettings({ ...appSettings, always_on_top: e.target.checked })}
                    />
                    <span>{L('alwaysOnTop')}</span>
                  </label>
                </div>

                {/* Сворачивать в трей */}
                <div className="settings-group">
                  <label className="settings-checkbox">
                    <input 
                      type="checkbox" 
                      checked={appSettings.minimize_to_tray}
                      onChange={(e) => handleSaveSettings({ ...appSettings, minimize_to_tray: e.target.checked })}
                    />
                    <span>{L('minimizeToTray')}</span>
                  </label>
                </div>

                {/* Путь к логу */}
                <div className="settings-group">
                  <label className="settings-label">{L('logFilePath')}</label>
                  <div className="settings-log-path">
                    <span className="log-path-value">
                      {appSettings.custom_log_path || L('autoDetect')}
                    </span>
                    <button 
                      className="settings-btn-small"
                      onClick={handleSelectLogFile}
                    >
                      <IconFolder size={14} />
                    </button>
                  </div>
                  <div className="settings-hint">
                    {L('examplePath')}:
                    <code className="settings-path-example">
                      ...Steam\steamapps\common\Torchlight Infinite\UE_game\TorchLight\Saved\Logs\UE_game.log
                    </code>
                  </div>
                </div>
              </div>
            </div>
          )}
          
          {/* ======== ABOUT TAB ======== */}
          {activeTab === 'about' && (
            <div className="about-tab">
              <div className="about-header">
                <div className="about-logo">
                  <IconStats size={32} />
                </div>
                <h2>TLI Companion</h2>
                <span className="about-version">v{version}</span>
              </div>
              
              <p className="about-description">
                {L('madeWith')} <IconHeart size={14} className="heart-icon" /> {L('forCommunity')}
              </p>
              
              <div className="about-links">
                <button 
                  className="about-link website"
                  onClick={() => shellOpen('https://kripika.com')}
                >
                  <IconExternalLink size={16} />
                  <span>kripika.com</span>
                </button>
                
                <button 
                  className="about-link donate"
                  onClick={() => shellOpen('https://www.donationalerts.com/r/gametoolskripika')}
                >
                  <IconHeart size={16} />
                  <span>{L('supportProject')}</span>
                </button>
              </div>
              
              <div className="about-footer">
                <p className="about-credits">
                  {lang === 'ru' 
                    ? 'Разработано для сообщества игроков Torchlight Infinite'
                    : 'Developed for Torchlight Infinite gaming community'
                  }
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Log File Selection Modal */}
      {showLogModal && (
        <div className="overlay-modal-backdrop" onClick={() => setShowLogModal(false)}>
          <div className="overlay-modal" onClick={e => e.stopPropagation()}>
            <div className="overlay-modal-title">
              <IconFolder size={18} /> {L('logNotFound')}
            </div>
            <div className="overlay-modal-content">
              <p style={{ marginBottom: 12 }}>
                {L('logRequired')}
              </p>
              <p style={{ marginBottom: 8, fontWeight: 600 }}>{L('pathToFile')}:</p>
              <code className="log-path-hint">{LOG_PATH_HINT}</code>
              <p style={{ marginTop: 12, marginBottom: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                {L('fullPathExample')}:
              </p>
              <code className="log-path-example">{LOG_PATH_EXAMPLE}</code>
              <p style={{ marginTop: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
                {L('selectLogFile')} <strong>UE_game.log</strong>
              </p>
            </div>
            <div className="overlay-modal-actions">
              <button className="modal-btn" onClick={() => setShowLogModal(false)}>
                {L('cancel')}
              </button>
              <button className="modal-btn primary" onClick={handleSelectLogFile}>
                <IconFolder size={14} /> {L('selectFile')}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default Overlay;
