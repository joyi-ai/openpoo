mod cli;
mod stt;
#[cfg(windows)]
mod job_object;
mod markdown;
mod window_customizer;

use cli::{install_cli, sync_cli};
use tauri_plugin_clipboard_manager::ClipboardExt;
use futures::FutureExt;
use futures::future;
#[cfg(windows)]
use job_object::*;
use std::{
    collections::VecDeque,
    net::TcpListener,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, LogicalSize, Manager, RunEvent, State, WebviewUrl, WebviewWindow};
#[cfg(windows)]
use tauri_plugin_decorum::WebviewWindowExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_store::StoreExt;
use tokio::sync::oneshot;

use crate::window_customizer::PinchZoomDisablePlugin;

#[derive(Clone, serde::Serialize)]
struct ServerReadyData {
    url: String,
    password: Option<String>,
}

#[derive(Clone)]
struct ServerState {
    child: Arc<Mutex<Option<CommandChild>>>,
    status: future::Shared<oneshot::Receiver<Result<ServerReadyData, String>>>,
}

impl ServerState {
    pub fn new(
        child: Option<CommandChild>,
        status: oneshot::Receiver<Result<ServerReadyData, String>>,
    ) -> Self {
        Self {
            child: Arc::new(Mutex::new(child)),
            status: status.shared(),
        }
    }

    pub fn set_child(&self, child: Option<CommandChild>) {
        *self.child.lock().unwrap() = child;
    }
}

#[derive(Clone)]
struct LogState(Arc<Mutex<VecDeque<String>>>);

#[derive(Default)]
struct AllowedServerCache {
    list: Vec<String>,
    origins: Vec<String>,
}

#[derive(Default)]
struct AllowedServerState(Mutex<AllowedServerCache>);

const MAX_LOG_ENTRIES: usize = 200;
const GLOBAL_STORAGE: &str = "opencode.global.dat";
const SETTINGS_STORE: &str = "opencode.settings.dat";
const DEFAULT_SERVER_URL_KEY: &str = "defaultServerUrl";

fn url_origin(url: &tauri::Url) -> String {
    format!(
        "{}://{}{}",
        url.scheme(),
        url.host_str().unwrap_or(""),
        url.port().map(|p| format!(":{}", p)).unwrap_or_default()
    )
}

fn parse_server_origins(list: &[String]) -> Vec<String> {
    let mut origins = Vec::new();
    for server in list {
        let parsed = tauri::Url::parse(server);
        if let Ok(parsed) = parsed {
            origins.push(url_origin(&parsed));
        }
    }
    origins
}

fn allowed_server_origins(app: &AppHandle, servers: &[String]) -> Vec<String> {
    let state = app.try_state::<AllowedServerState>();
    if let Some(state) = state {
        let cache = state.0.lock();
        if let Ok(mut cache) = cache {
            if cache.list == servers {
                return cache.origins.clone();
            }
            let origins = parse_server_origins(servers);
            cache.list = servers.to_vec();
            cache.origins = origins.clone();
            return origins;
        }
    }
    parse_server_origins(servers)
}

/// Check if a URL's origin matches any configured server in the store.
/// Returns true if the URL should be allowed for internal navigation.
fn is_allowed_server(app: &AppHandle, url: &tauri::Url) -> bool {
    // Always allow localhost and 127.0.0.1
    if let Some(host) = url.host_str() {
        if host == "localhost" || host == "127.0.0.1" {
            return true;
        }
    }

    // Try to read the server list from the store
    let Ok(store) = app.store(GLOBAL_STORAGE) else {
        return false;
    };

    let Some(server_data) = store.get("server") else {
        return false;
    };

    // Parse the server list from the stored JSON
    let Some(list) = server_data.get("list").and_then(|v| v.as_array()) else {
        return false;
    };

    let mut servers = Vec::new();
    for server in list {
        let Some(server_url) = server.as_str() else {
            continue;
        };
        servers.push(server_url.to_string());
    }
    if servers.is_empty() {
        return false;
    }

    // Get the origin of the navigation URL (scheme + host + port)
    let url_origin = url_origin(url);

    let origins = allowed_server_origins(app, &servers);
    for origin in origins {
        if url_origin == origin {
            return true;
        }
    }

    false
}

#[tauri::command]
fn kill_sidecar(app: AppHandle) {
    let Some(server_state) = app.try_state::<ServerState>() else {
        println!("Server not running");
        return;
    };

    let Some(server_state) = server_state
        .child
        .lock()
        .expect("Failed to acquire mutex lock")
        .take()
    else {
        println!("Server state missing");
        return;
    };

    let _ = server_state.kill();

    println!("Killed server");
}

#[tauri::command]
async fn copy_logs_to_clipboard(app: AppHandle) -> Result<(), String> {
    let log_state = app.try_state::<LogState>().ok_or("Log state not found")?;

    let logs = log_state
        .0
        .lock()
        .map_err(|_| "Failed to acquire log lock")?;

    let log_text = logs.iter().cloned().collect::<Vec<_>>().join("");

    app.clipboard()
        .write_text(log_text)
        .map_err(|e| format!("Failed to copy to clipboard: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn get_logs(app: AppHandle) -> Result<String, String> {
    let log_state = app.try_state::<LogState>().ok_or("Log state not found")?;

    let logs = log_state
        .0
        .lock()
        .map_err(|_| "Failed to acquire log lock")?;

    Ok(logs.iter().cloned().collect::<Vec<_>>().join(""))
}

// ============================================================================
// Speech-to-Text Commands
// ============================================================================

#[tauri::command]
async fn stt_get_status(app: AppHandle) -> Result<stt::SttStatus, String> {
    let state = app
        .try_state::<stt::SharedSttState>()
        .ok_or("STT state not found")?;
    let state = state.lock().map_err(|e| format!("Lock error: {}", e))?;
    Ok(state.get_status())
}

#[tauri::command]
async fn stt_download_model(app: AppHandle) -> Result<(), String> {
    stt::download_models(app).await
}

#[tauri::command]
async fn stt_start_recording(app: AppHandle) -> Result<(), String> {
    let state = app
        .try_state::<stt::SharedSttState>()
        .ok_or("STT state not found")?;
    let mut state = state.lock().map_err(|e| format!("Lock error: {}", e))?;
    state.start_recording()
}

#[tauri::command]
async fn stt_push_audio(app: AppHandle, samples: Vec<f32>) -> Result<(), String> {
    let state = app
        .try_state::<stt::SharedSttState>()
        .ok_or("STT state not found")?;
    let mut state = state.lock().map_err(|e| format!("Lock error: {}", e))?;
    state.push_audio(samples)
}

#[tauri::command]
async fn stt_stop_and_transcribe(app: AppHandle) -> Result<String, String> {
    let state = app
        .try_state::<stt::SharedSttState>()
        .ok_or("STT state not found")?;

    let (audio, inference) = {
        let mut state = state.lock().map_err(|e| format!("Lock error: {}", e))?;
        let audio = state.stop_recording();
        let inference = state.inference()?;
        (audio, inference)
    };

    tauri::async_runtime::spawn_blocking(move || inference.transcribe(&audio))
        .await
        .map_err(|e| format!("Transcription task failed: {}", e))?
}

#[tauri::command]
async fn ensure_server_ready(state: State<'_, ServerState>) -> Result<ServerReadyData, String> {
    state
        .status
        .clone()
        .await
        .map_err(|_| "Failed to get server status".to_string())?
}

#[tauri::command]
async fn ensure_server_started(state: State<'_, ServerState>) -> Result<(), String> {
    state
        .status
        .clone()
        .await
        .map(|_| ())
        .map_err(|_| "Failed to get server status".to_string())?;
    Ok(())
}

#[tauri::command]
fn get_default_server_url(app: AppHandle) -> Result<Option<String>, String> {
    let store = app
        .store(SETTINGS_STORE)
        .map_err(|e| format!("Failed to open settings store: {}", e))?;

    let value = store.get(DEFAULT_SERVER_URL_KEY);
    match value {
        Some(v) => Ok(v.as_str().map(String::from)),
        None => Ok(None),
    }
}

#[tauri::command]
async fn set_default_server_url(app: AppHandle, url: Option<String>) -> Result<(), String> {
    let store = app
        .store(SETTINGS_STORE)
        .map_err(|e| format!("Failed to open settings store: {}", e))?;

    match url {
        Some(u) => {
            store.set(DEFAULT_SERVER_URL_KEY, serde_json::Value::String(u));
        }
        None => {
            store.delete(DEFAULT_SERVER_URL_KEY);
        }
    }

    store
        .save()
        .map_err(|e| format!("Failed to save settings: {}", e))?;

    Ok(())
}

fn get_sidecar_port() -> u32 {
    option_env!("OPENCODE_PORT")
        .map(|s| s.to_string())
        .or_else(|| std::env::var("OPENCODE_PORT").ok())
        .and_then(|port_str| port_str.parse().ok())
        .unwrap_or_else(|| {
            TcpListener::bind("127.0.0.1:0")
                .expect("Failed to bind to find free port")
                .local_addr()
                .expect("Failed to get local address")
                .port()
        }) as u32
}

fn spawn_sidecar(app: &AppHandle, port: u32, password: Option<&str>) -> CommandChild {
    let log_state = app.state::<LogState>();
    let log_state_clone = log_state.inner().clone();

    let args = format!("serve --port {port}");
    let mut command = cli::create_command(app, &args);
    if let Some(password) = password {
        command = command.env("OPENCODE_SERVER_PASSWORD", password);
    }

    let (mut rx, child) = command
        .spawn()
        .expect("Failed to spawn opencode");

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes);
                    print!("{line}");

                    // Store log in shared state
                    if let Ok(mut logs) = log_state_clone.0.lock() {
                        logs.push_back(format!("[STDOUT] {}", line));
                        // Keep only the last MAX_LOG_ENTRIES
                        while logs.len() > MAX_LOG_ENTRIES {
                            logs.pop_front();
                        }
                    }
                }
                CommandEvent::Stderr(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes);
                    eprint!("{line}");

                    // Store log in shared state
                    if let Ok(mut logs) = log_state_clone.0.lock() {
                        logs.push_back(format!("[STDERR] {}", line));
                        // Keep only the last MAX_LOG_ENTRIES
                        while logs.len() > MAX_LOG_ENTRIES {
                            logs.pop_front();
                        }
                    }
                }
                _ => {}
            }
        }
    });

    child
}

fn url_is_localhost(url: &reqwest::Url) -> bool {
    url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    })
}

async fn check_server_health(url: &str, password: Option<&str>) -> bool {
    let Ok(url) = reqwest::Url::parse(url) else {
        return false;
    };

    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(3));

    if url_is_localhost(&url) {
        // Some environments set proxy variables (HTTP_PROXY/HTTPS_PROXY/ALL_PROXY) without
        // excluding loopback. reqwest respects these by default, which can prevent the desktop
        // app from reaching its own local sidecar server.
        builder = builder.no_proxy();
    };

    let Ok(client) = builder.build() else {
        return false;
    };
    let Ok(health_url) = url.join("/global/health") else {
        return false;
    };

    let mut req = client.get(health_url);

    if let Some(password) = password {
        req = req.basic_auth("opencode", Some(password));
    }

    req.send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Converts a bind address hostname to a valid URL hostname for connection.
/// - `0.0.0.0` and `::` are wildcard bind addresses, not valid connect targets
/// - IPv6 addresses need brackets in URLs (e.g., `::1` -> `[::1]`)
fn normalize_hostname_for_url(hostname: &str) -> String {
    if hostname == "0.0.0.0" {
        return "127.0.0.1".to_string();
    }
    if hostname == "::" {
        return "[::1]".to_string();
    }

    if hostname.contains(':') && !hostname.starts_with('[') {
        return format!("[{}]", hostname);
    }

    hostname.to_string()
}

fn get_server_url_from_config(config: &cli::Config) -> Option<String> {
    let server = config.server.as_ref()?;
    let port = server.port?;
    println!("server.port found in OC config: {port}");
    let hostname = server
        .hostname
        .as_ref()
        .map(|v| normalize_hostname_for_url(v))
        .unwrap_or_else(|| "127.0.0.1".to_string());

    Some(format!("http://{}:{}", hostname, port))
}

async fn setup_server_connection(
    app: &AppHandle,
    custom_url: Option<String>,
    local_port: u32,
) -> Result<(Option<CommandChild>, ServerReadyData), String> {
    if let Some(url) = custom_url {
        loop {
            if check_server_health(&url, None).await {
                println!("Connected to custom server: {}", url);
                return Ok((
                    None,
                    ServerReadyData {
                        url: url.clone(),
                        password: None,
                    },
                ));
            }

            const RETRY: &str = "Retry";

            let res = app
                .dialog()
                .message(format!(
                    "Could not connect to configured server:\n{}\n\nWould you like to retry or start a local server instead?",
                    url
                ))
                .title("Connection Failed")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    RETRY.to_string(),
                    "Start Local".to_string(),
                ))
                .blocking_show_with_result();

            match res {
                MessageDialogResult::Custom(name) if name == RETRY => {
                    continue;
                }
                _ => {
                    break;
                }
            }
        }
    }

    let local_url = format!("http://127.0.0.1:{local_port}");

    if !check_server_health(&local_url, None).await {
        let password = uuid::Uuid::new_v4().to_string();

        match spawn_local_server(app, local_port, &password).await {
            Ok(child) => Ok((
                Some(child),
                ServerReadyData {
                    url: local_url,
                    password: Some(password),
                },
            )),
            Err(err) => Err(err),
        }
    } else {
        Ok((
            None,
            ServerReadyData {
                url: local_url,
                password: None,
            },
        ))
    }
}

async fn spawn_local_server(
    app: &AppHandle,
    port: u32,
    password: &str,
) -> Result<CommandChild, String> {
    let child = spawn_sidecar(app, port, Some(password));
    let url = format!("http://127.0.0.1:{port}");

    let timestamp = Instant::now();
    let mut delay = Duration::from_millis(10);
    let max_delay = Duration::from_millis(200);

    loop {
        if timestamp.elapsed() > Duration::from_secs(30) {
            break Err(format!(
                "Failed to spawn OpenCode Server. Logs:\n{}",
                get_logs(app.clone()).await.unwrap()
            ));
        }

        tokio::time::sleep(delay).await;

        if check_server_health(&url, Some(password)).await {
            println!("Server ready after {:?}", timestamp.elapsed());
            break Ok(child);
        }

        let next = delay.saturating_mul(2);
        if next > max_delay {
            delay = max_delay;
            continue;
        }
        delay = next;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let updater_enabled = option_env!("TAURI_SIGNING_PRIVATE_KEY").is_some();

    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("killall")
        .arg("opencode-cli")
        .output();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus existing window when another instance is launched
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(PinchZoomDisablePlugin)
        .plugin(tauri_plugin_decorum::init())
        .invoke_handler(tauri::generate_handler![
            kill_sidecar,
            copy_logs_to_clipboard,
            get_logs,
            install_cli,
            ensure_server_started,
            ensure_server_ready,
            get_default_server_url,
            set_default_server_url,
            stt_get_status,
            stt_download_model,
            stt_start_recording,
            stt_push_audio,
            stt_stop_and_transcribe,
            markdown::parse_markdown_command
        ])
        .setup(move |app| {
            let app = app.handle().clone();

            // Initialize log state
            app.manage(LogState(Arc::new(Mutex::new(VecDeque::new()))));
            app.manage(AllowedServerState::default());

            // Initialize STT state
            app.manage(stt::init_stt_state(&app));

            #[cfg(windows)]
            app.manage(JobObjectState::new());

            // Get port and create window immediately for faster perceived startup
            let port = get_sidecar_port();

            let primary_monitor = app.primary_monitor().ok().flatten();
            let size = primary_monitor
                .map(|m| m.size().to_logical(m.scale_factor()))
                .unwrap_or(LogicalSize::new(1920, 1080));

            let app_for_nav = app.clone();
            let mut window_builder =
                WebviewWindow::builder(&app, "main", WebviewUrl::App("/".into()))
                    .title("Aura")
                    .inner_size(size.width as f64, size.height as f64)
                    .decorations(true)
                    .zoom_hotkeys_enabled(true)
                    .disable_drag_drop_handler()
                    .on_navigation(move |url| {
                        // Allow internal navigation (tauri:// scheme)
                        if url.scheme() == "tauri" {
                            return true;
                        }
                        // Allow navigation to configured servers (localhost, 127.0.0.1, or remote)
                        if is_allowed_server(&app_for_nav, url) {
                            return true;
                        }
                        // Open external http/https URLs in default browser
                        if url.scheme() == "http" || url.scheme() == "https" {
                            let _ = app_for_nav.shell().open(url.as_str(), None);
                            return false; // Cancel internal navigation
                        }
                        true
                    })
                    .initialization_script(format!(
                        r#"
                      window.__OPENCODE__ ??= {{}};
                      window.__OPENCODE__.updaterEnabled = {updater_enabled};
                      window.__OPENCODE__.port = {port};
                    "#
                    ));

            #[cfg(target_os = "macos")]
            {
                window_builder = window_builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
            }

            #[cfg(windows)]
            let window_builder = window_builder.decorations(false);

            let window = window_builder.build().expect("Failed to create window");

            #[cfg(windows)]
            let _ = window.create_overlay_titlebar();

            let (tx, rx) = oneshot::channel();
            app.manage(ServerState::new(None, rx));

            {
                let app = app.clone();
                let window = window.clone();
                tauri::async_runtime::spawn(async move {
                    let mut custom_url = get_default_server_url(app.clone()).ok().flatten();

                    if custom_url.is_none() {
                        if let Some(cli_config) = cli::get_config(&app).await {
                            if let Some(url) = get_server_url_from_config(&cli_config) {
                                println!("Using custom server URL from config: {}", url);
                                custom_url = Some(url);
                            }
                        }
                    } else if let Some(url) = &custom_url {
                        println!("Using desktop-specific custom URL: {}", url);
                    }

                    let res = setup_server_connection(&app, custom_url, port)
                        .await
                        .map(|(child, data)| {
                            #[cfg(windows)]
                            if let Some(child) = &child {
                                let job_state = app.state::<JobObjectState>();
                                job_state.assign_pid(child.pid());
                            }

                            app.state::<ServerState>().set_child(child);

                            if let Ok(parsed) = tauri::Url::parse(&data.url) {
                                if let Some(port) = parsed.port() {
                                    let _ = window.eval(&format!(
                                        "window.__OPENCODE__.port = {port};"
                                    ));
                                }
                            }

                            let _ = window.eval("window.__OPENCODE__.serverReady = true;");

                            data
                        });

                    let _ = tx.send(res);
                });
            }

            {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = sync_cli(app) {
                        eprintln!("Failed to sync CLI: {e}");
                    }
                });
            }

            Ok(())
        });

    if updater_enabled {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                println!("Received Exit");

                kill_sidecar(app.clone());
            }
        });
}
