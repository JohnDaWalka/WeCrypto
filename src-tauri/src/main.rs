#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tauri::State;
use std::collections::HashMap;
use reqwest::Client;
use tokio::time::{interval, Duration};
use serde_json;

struct BouncerState {
    client: Client,
}

// Enhanced discrete bouncer with async patterns
#[tauri::command]
async fn discrete_bouncer(
    state: State<'_, BouncerState>,
    category: String,
    url: String,
    method: Option<String>,
    _body: Option<serde_json::Value>,
    extra_headers: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let client = &state.client;

    // Pattern: tokio::select! + timeout for safety
    let request_fut = async {
        let mut req = match category.as_str() {
            "price" => client.request(method.unwrap_or_else(|| "GET".into()).parse().unwrap(), &url),
            "binary" => {
                let mut r = client.request(method.unwrap_or_else(|| "GET".into()).parse().unwrap(), &url);
                r = r.header("User-Agent", "WE-Crypto-CFM-Tauri/1.0");
                if let Ok(key) = std::env::var("KALSHI_KEY") {
                    r = r.header("Authorization", format!("Bearer {}", key));
                }
                r
            }
            "supp" => client.request(method.unwrap_or_else(|| "GET".into()).parse().unwrap(), &url)
                .timeout(Duration::from_secs(15)),
            _ => return Err("Invalid bucket".to_string()),
        };

        if let Some(headers) = extra_headers {
            for (k, v) in headers {
                req = req.header(&k, v);
            }
        }

        let resp = req.send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        resp.text().await.map_err(|e| e.to_string())
    };

    // Race against 30s timeout
    tokio::select! {
        result = request_fut => result,
        _ = tokio::time::sleep(Duration::from_secs(30)) => {
            Err("Request timed out".to_string())
        }
    }
}

// Example: Background 15M resolution poller using interval + spawn
#[tauri::command]
async fn start_15m_poller() -> Result<(), String> {
    tokio::spawn(async {
        let mut interval = interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            // Here you would call Kalshi/Polymarket via bouncer or direct async
            println!("[Poller] Checking 15M settlements...");
            // Dispatch resolved event back to frontend via tauri::Emitter if needed
        }
    });
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(BouncerState { client: Client::new() })
        .invoke_handler(tauri::generate_handler![discrete_bouncer, start_15m_poller])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.set_title("WE|||CRYPTO \u{2014} 15M Market Resolver + Discrete Bouncer").unwrap();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
