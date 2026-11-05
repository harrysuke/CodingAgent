//! CodingAgent Tauri 2 shell.
//!
//! Built desktop binaries (debug or release) start the bundled Node.js agent
//! server as a child process, hand the Vue frontend its loopback URL + token via
//! `get_server_config`, and kill the child on exit. `tauri dev` instead reuses
//! the Vite dev server / `npm run dev`. Mobile has no Node runtime, so it talks
//! to a LAN/remote server configured in Settings > Connection.

use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, RunEvent, State};

#[cfg(not(mobile))]
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
};

#[derive(Clone, Serialize)]
pub struct ServerConfig {
    url: String,
    token: String,
}

enum StartupStatus {
    Pending,
    /// Debug desktop build or mobile: the frontend uses its own connection settings.
    Disabled,
    Ready(ServerConfig),
    Failed(String),
}

impl Default for StartupStatus {
    fn default() -> Self {
        Self::Pending
    }
}

#[derive(Default)]
struct ServerState {
    status: Mutex<StartupStatus>,
    #[cfg(not(mobile))]
    child: Mutex<Option<Child>>,
}

fn set_status(state: &State<'_, ServerState>, status: StartupStatus) {
    if let Ok(mut guard) = state.status.lock() {
        *guard = status;
    }
}

/// Called by `apps/web/src/api/client.ts`. Blocks briefly while the sidecar
/// boots; returns `null` when the frontend should use its saved settings.
#[tauri::command]
fn get_server_config(state: State<'_, ServerState>) -> Option<ServerConfig> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        {
            let guard = match state.status.lock() {
                Ok(g) => g,
                Err(_) => return None,
            };
            match &*guard {
                StartupStatus::Ready(cfg) => return Some(cfg.clone()),
                StartupStatus::Disabled | StartupStatus::Failed(_) => return None,
                StartupStatus::Pending => {}
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Diagnostics for the Settings screen / support: "starting", "external",
/// "ready http://127.0.0.1:..." or "failed: <reason>".
#[tauri::command]
fn get_server_status(state: State<'_, ServerState>) -> String {
    match state.status.lock() {
        Ok(guard) => match &*guard {
            StartupStatus::Pending => "starting".into(),
            StartupStatus::Disabled => "external".into(),
            StartupStatus::Ready(cfg) => format!("ready {}", cfg.url),
            StartupStatus::Failed(err) => format!("failed: {err}"),
        },
        Err(_) => "unknown".into(),
    }
}

// ---------------------------------------------------------------------------
// Desktop sidecar
// ---------------------------------------------------------------------------
#[cfg(mobile)]
fn start_backend(app: &AppHandle) {
    set_status(&app.state::<ServerState>(), StartupStatus::Disabled);
}

#[cfg(not(mobile))]
fn start_backend(app: &AppHandle) {
    // `cfg(dev)` is emitted by tauri-build for `tauri dev` only (i.e. when the
    // `custom-protocol` feature is off). Every built binary - debug or release -
    // therefore supervises its own sidecar, while `tauri dev` uses the Vite
    // proxy at http://localhost:5173.
    let dev_server_mode = cfg!(dev) && std::env::var("CODINGAGENT_FORCE_SIDECAR").is_err();
    if dev_server_mode {
        set_status(&app.state::<ServerState>(), StartupStatus::Disabled);
        return;
    }

    let handle = app.clone();
    std::thread::spawn(move || {
        let state = handle.state::<ServerState>();
        match spawn_sidecar(&handle) {
            Ok((child, cfg)) => {
                if let Ok(mut guard) = state.child.lock() {
                    *guard = Some(child);
                }
                if wait_for_health(&cfg) {
                    eprintln!("[CodingAgent] sidecar ready at {}", cfg.url);
                    set_status(&state, StartupStatus::Ready(cfg));
                } else {
                    let msg = "agent server did not become healthy (see server.log)".to_string();
                    eprintln!("[CodingAgent] {msg}");
                    set_status(&state, StartupStatus::Failed(msg));
                }
            }
            Err(err) => {
                eprintln!("[CodingAgent] sidecar failed: {err}");
                set_status(&state, StartupStatus::Failed(err));
            }
        }
    });
}

#[cfg(not(mobile))]
fn read_env_file(path: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Ok(text) = fs::read_to_string(path) else {
        return out;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("export ") {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
            out.insert(key.trim().to_string(), value);
        }
    }
    out
}

#[cfg(not(mobile))]
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[cfg(not(mobile))]
fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    Ok(port)
}

#[cfg(not(mobile))]
fn resolve_node(resource_dir: &Path) -> PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let bundled = resource_dir.join("node").join(name);
    if bundled.is_file() {
        return bundled;
    }
    // Development / unpackaged fallback: a Node install on PATH.
    PathBuf::from(name)
}

#[cfg(not(mobile))]
fn spawn_sidecar(app: &AppHandle) -> Result<(Child, ServerConfig), String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&app_data).map_err(|e| e.to_string())?;

    let server_dir = resource_dir.join("server");
    let entry = server_dir.join("index.js");
    if !entry.is_file() {
        return Err(format!(
            "bundled server not found at {} - run `npm run desktop:build`",
            entry.display()
        ));
    }

    // Per-user, writable config seeded from the shipped .env. This keeps the
    // inherited ENCRYPTION_KEY (needed for the copied SQLite keys) editable
    // without writing into Program Files / the app bundle.
    let env_path = app_data.join("server.env");
    if !env_path.is_file() {
        let bundled_env = server_dir.join(".env");
        if bundled_env.is_file() {
            fs::copy(&bundled_env, &env_path).map_err(|e| e.to_string())?;
        } else {
            fs::write(&env_path, "").map_err(|e| e.to_string())?;
        }
    }
    let vars = read_env_file(&env_path);
    let token = vars
        .get("AGENT_TOKEN")
        .cloned()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "change-me-local-dev-token".to_string());

    // Writable DB copy - the bundled one is a read-only install resource.
    let data_dir = app_data.join("data");
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let db_path = data_dir.join("codingagent.db");
    if !db_path.is_file() {
        let seed = server_dir.join("data").join("codingagent.db");
        if seed.is_file() {
            fs::copy(&seed, &db_path).map_err(|e| e.to_string())?;
        }
    }

    // Writable workspace, seeded once from the bundled workspace.
    let workspace = app_data.join("workspace");
    fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
    let seed_workspace = server_dir.join("workspace");
    let empty = fs::read_dir(&workspace)
        .map(|mut it| it.next().is_none())
        .unwrap_or(false);
    if seed_workspace.is_dir() && empty {
        let _ = copy_dir_all(&seed_workspace, &workspace);
    }

    let port = free_port()?;
    let node = resolve_node(&resource_dir);
    let log = File::create(app_data.join("server.log")).map_err(|e| e.to_string())?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .current_dir(&server_dir)
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    for (key, value) in &vars {
        cmd.env(key, value);
    }
    // Real environment variables win over dotenv (dotenv never overrides).
    cmd.env("HOST", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("DB_PATH", &db_path)
        .env("WORKSPACE_ROOT", &workspace)
        .env("AGENT_TOKEN", &token)
        .env("CODINGAGENT_DESKTOP", "1");

    let child = cmd
        .spawn()
        .map_err(|e| format!("cannot start {}: {e}", node.display()))?;
    Ok((
        child,
        ServerConfig {
            url: format!("http://127.0.0.1:{port}"),
            token,
        },
    ))
}

#[cfg(not(mobile))]
fn wait_for_health(cfg: &ServerConfig) -> bool {
    let port: u16 = cfg
        .url
        .rsplit(':')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if port == 0 {
        return false;
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if health_ok(port, &cfg.token) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// Tiny raw HTTP probe - avoids pulling an HTTP client into the Rust build.
#[cfg(not(mobile))]
fn health_ok(port: u16, token: &str) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(400)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 512];
    let Ok(n) = stream.read(&mut buf) else {
        return false;
    };
    String::from_utf8_lossy(&buf[..n]).contains("200 OK")
}

/// Terminates the sidecar when the app exits. Kept in its own function so the
/// mutex guard's temporaries are dropped before the app handle borrow ends.
#[cfg(not(mobile))]
fn stop_sidecar(handle: &AppHandle) {
    let state = handle.state::<ServerState>();
    let mut guard = match state.child.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    if let Some(child) = guard.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(ServerState::default())
        .invoke_handler(tauri::generate_handler![
            get_server_config,
            get_server_status
        ])
        .setup(|app| {
            start_backend(&app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building CodingAgent");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            #[cfg(not(mobile))]
            stop_sidecar(handle);
            #[cfg(mobile)]
            let _ = handle;
        }
    });
}
