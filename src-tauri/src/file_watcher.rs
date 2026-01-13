//! File Watcher для отслеживания изменений в логах TLI
//! 
//! Использует notify для отслеживания изменений файла UE_game.log
//! и читает новые строки по мере их появления (tail -f поведение).

use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
// notify импорты убраны - используем простой polling
use log::{info, warn, error, debug};
use tokio::sync::mpsc;

use crate::log_parser::LogParser;
use crate::types::LogEvent;

/// Найти путь к файлу логов TLI
pub fn find_log_path() -> Option<PathBuf> {
    // Типичные пути установки Steam
    let possible_paths = [
        // Steam по умолчанию
        r"C:\Program Files (x86)\Steam\steamapps\common\Torchlight Infinite\UE_game\TorchLight\Saved\Logs\UE_game.log",
        r"C:\Program Files\Steam\steamapps\common\Torchlight Infinite\UE_game\TorchLight\Saved\Logs\UE_game.log",
        // D: диск
        r"D:\Steam\steamapps\common\Torchlight Infinite\UE_game\TorchLight\Saved\Logs\UE_game.log",
        r"D:\steam\steamapps\common\Torchlight Infinite\UE_game\TorchLight\Saved\Logs\UE_game.log",
        r"D:\Games\Steam\steamapps\common\Torchlight Infinite\UE_game\TorchLight\Saved\Logs\UE_game.log",
        // E: диск
        r"E:\Steam\steamapps\common\Torchlight Infinite\UE_game\TorchLight\Saved\Logs\UE_game.log",
        r"E:\Games\Steam\steamapps\common\Torchlight Infinite\UE_game\TorchLight\Saved\Logs\UE_game.log",
        // F: диск
        r"F:\Steam\steamapps\common\Torchlight Infinite\UE_game\TorchLight\Saved\Logs\UE_game.log",
    ];
    
    for path_str in &possible_paths {
        let path = PathBuf::from(path_str);
        if path.exists() {
            info!("Found TLI log file at: {}", path.display());
            return Some(path);
        }
    }
    
    // Попробуем найти через реестр или libraryfolders.vdf
    // TODO: реализовать поиск через Steam
    
    warn!("Could not find TLI log file automatically");
    None
}

/// Состояние watcher'а
pub struct LogWatcher {
    /// Путь к файлу логов
    log_path: PathBuf,
    /// Текущая позиция в файле
    file_position: Arc<Mutex<u64>>,
    /// Флаг остановки
    running: Arc<Mutex<bool>>,
    /// Парсер логов
    parser: Arc<Mutex<LogParser>>,
}

impl LogWatcher {
    /// Создать новый watcher
    pub fn new(log_path: PathBuf, parser: Arc<Mutex<LogParser>>) -> Self {
        Self {
            log_path,
            file_position: Arc::new(Mutex::new(0)),
            running: Arc::new(Mutex::new(false)),
            parser,
        }
    }
    
    /// Запустить отслеживание файла
    /// Возвращает канал для получения событий
    pub fn start(&self) -> mpsc::Receiver<LogEvent> {
        let (tx, rx) = mpsc::channel(1000);
        
        let log_path = self.log_path.clone();
        let file_position = self.file_position.clone();
        let running = self.running.clone();
        let parser = self.parser.clone();
        
        // Устанавливаем флаг работы
        *running.lock().unwrap() = true;
        
        // Запускаем поток чтения
        thread::spawn(move || {
            info!("Starting log watcher for: {}", log_path.display());
            
            // Открываем файл и переходим в конец (не читаем историю)
            let file = match File::open(&log_path) {
                Ok(f) => f,
                Err(e) => {
                    error!("Failed to open log file: {}", e);
                    return;
                }
            };
            
            let mut reader = BufReader::new(file);

            // Warm-up: читаем небольшой хвост файла, чтобы собрать baseline по слотам,
            // иначе первый дроп стаков часто теряется.
            if let Ok(metadata) = std::fs::metadata(&log_path) {
                let len = metadata.len();
                // 1MB хвост — обычно достаточно, чтобы захватить несколько PickItems и BagMgr линий.
                let warmup_start = len.saturating_sub(1024 * 1024);
                if reader.seek(SeekFrom::Start(warmup_start)).is_ok() {
                    let mut warm_line = String::new();
                    // Если не с начала файла — отбросим первую “обрезанную” строку.
                    if warmup_start > 0 {
                        let _ = reader.read_line(&mut warm_line);
                        warm_line.clear();
                    }

                    let mut warmed = 0usize;
                    while reader.read_line(&mut warm_line).unwrap_or(0) > 0 {
                        let line = warm_line.trim_end();
                        parser.lock().unwrap().warmup_line(line);
                        warmed += 1;
                        warm_line.clear();
                    }
                    debug!("Warm-up parsed {} lines from tail", warmed);
                }
            }

            // Переходим в конец файла (реальный tail)
            if let Ok(pos) = reader.seek(SeekFrom::End(0)) {
                *file_position.lock().unwrap() = pos;
                info!("Starting from position: {}", pos);
            }
            
            // Буфер для многострочных событий (например, цены)
            let mut price_buffer: Vec<String> = Vec::new();
            let mut in_price_block = false;
            let mut current_price_event: Option<crate::types::PriceSearchEvent> = None;
            
            while *running.lock().unwrap() {
                let mut line = String::new();
                
                match reader.read_line(&mut line) {
                    Ok(0) => {
                        // Нет новых данных, ждём
                        thread::sleep(Duration::from_millis(100));
                        
                        // Проверяем, не был ли файл пересоздан (ротация логов)
                        if let Ok(metadata) = std::fs::metadata(&log_path) {
                            let current_pos = *file_position.lock().unwrap();
                            if metadata.len() < current_pos {
                                // Файл стал меньше - он был пересоздан
                                info!("Log file was rotated, restarting from beginning");
                                
                                // Переоткрываем файл
                                if let Ok(new_file) = File::open(&log_path) {
                                    reader = BufReader::new(new_file);
                                    *file_position.lock().unwrap() = 0;
                                    parser.lock().unwrap().reset_slot_cache();
                                }
                            }
                        }
                    }
                    Ok(bytes) => {
                        // Обновляем позицию
                        let mut pos = file_position.lock().unwrap();
                        *pos += bytes as u64;
                        drop(pos);
                        
                        // Убираем trailing whitespace
                        let line = line.trim_end();
                        
                        let is_price_recv_start =
                            line.contains("----Socket RecvMessage STT----XchgSearchPrice");

                        // Обработка многострочных блоков цен
                        if is_price_recv_start {
                            // Сначала даём парсеру обработать STT строку, чтобы появился PriceSearchEvent
                            // (иначе current_price_event останется None).
                            if let Some(event) = parser.lock().unwrap().parse_line(line) {
                                if let LogEvent::PriceSearch(pe) = &event {
                                    current_price_event = Some(pe.clone());
                                }
                            }

                            in_price_block = true;
                            price_buffer.clear();
                            price_buffer.push(line.to_string());
                            continue;
                        }
                        
                        if in_price_block {
                            price_buffer.push(line.to_string());
                            
                            if line.contains("----Socket RecvMessage End----") {
                                in_price_block = false;
                                
                                // Парсим блок цен
                                if let Some(mut event) = current_price_event.take() {
                                    let lines: Vec<&str> = price_buffer.iter().map(|s| s.as_str()).collect();
                                    let (prices, currency) = parser.lock().unwrap().parse_price_block(&lines);
                                    event.prices = prices;
                                    event.currency_id = currency;
                                    
                                    if !event.prices.is_empty() {
                                        debug!("Price event complete: game_id={}, prices={:?}", 
                                               event.game_id, event.prices);
                                        let _ = tx.blocking_send(LogEvent::PriceSearch(event));
                                    }
                                }
                                price_buffer.clear();
                            }
                            continue;
                        }
                        
                        // Парсим строку
                        let mut parser_guard = parser.lock().unwrap();
                        if let Some(event) = parser_guard.parse_line(line) {
                            match &event {
                                LogEvent::PriceSearch(pe) => {
                                    // Сохраняем для заполнения ценами
                                    current_price_event = Some(pe.clone());
                                }
                                _ => {
                                    // Отправляем событие
                                    if tx.blocking_send(event).is_err() {
                                        warn!("Failed to send event, receiver dropped");
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        error!("Error reading log file: {}", e);
                        thread::sleep(Duration::from_secs(1));
                    }
                }
            }
            
            info!("Log watcher stopped");
        });
        
        rx
    }
    
    /// Остановить отслеживание
    #[allow(dead_code)]
    pub fn stop(&self) {
        *self.running.lock().unwrap() = false;
    }
    
    /// Проверить, работает ли watcher
    #[allow(dead_code)]
    pub fn is_running(&self) -> bool {
        *self.running.lock().unwrap()
    }
    
    /// Получить текущую позицию в файле
    #[allow(dead_code)]
    pub fn get_position(&self) -> u64 {
        *self.file_position.lock().unwrap()
    }
    
    /// Сбросить парсер (при начале новой сессии)
    #[allow(dead_code)]
    pub fn reset_parser(&self) {
        self.parser.lock().unwrap().reset_slot_cache();
    }
}
