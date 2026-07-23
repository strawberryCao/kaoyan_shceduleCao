#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Local;
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, GenericImageView};
use regex::Regex;
use reqwest::Client;
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::Manager;

const KEYRING_SERVICE: &str = "com.strawberrycao.cylinder-image-renamer";
const OPERATION_LOG: &str = "last-operation.json";

#[derive(Debug, Clone, Deserialize)]
struct AiConfig {
    profile_id: String,
    base_url: String,
    first_model: String,
    review_model: String,
    strict_model: String,
    temperature: f32,
    max_tokens: u32,
    timeout_seconds: u64,
    max_dimension: u32,
    first_prompt: String,
    review_prompt: String,
    strict_prompt: String,
}

#[derive(Debug, Clone, Deserialize)]
struct NumberRules {
    pattern: String,
    separator: String,
    number_padding: usize,
    uppercase: bool,
    remove_spaces: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct AiRawResult {
    #[serde(default, alias = "cylinderNumber", alias = "number", alias = "result")]
    cylinder_number: Option<String>,
    #[serde(default)]
    uncertain: bool,
    #[serde(default, alias = "uncertainCharacters")]
    uncertain_characters: Vec<String>,
    #[serde(default, alias = "multipleCandidates", alias = "candidates")]
    multiple_candidates: Vec<String>,
    #[serde(default)]
    evidence: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct PassResult {
    stage: String,
    model: String,
    raw_value: Option<String>,
    normalized: Option<String>,
    uncertain: bool,
    valid: bool,
    note: String,
}

#[derive(Debug, Clone)]
struct ModelOutcome {
    pass: PassResult,
    raw: AiRawResult,
}

impl ModelOutcome {
    fn eligible_value(&self) -> Option<&str> {
        if self.pass.valid && !self.pass.uncertain {
            self.pass.normalized.as_deref()
        } else {
            None
        }
    }
}

#[derive(Debug, Serialize)]
struct AnalysisResult {
    status: String,
    suggested_number: Option<String>,
    candidates: Vec<String>,
    reason: String,
    passes: Vec<PassResult>,
}

#[derive(Debug, Deserialize)]
struct ExecuteItem {
    source_path: String,
    target_name: String,
}

#[derive(Debug, Deserialize)]
struct ExecuteRequest {
    output_dir: Option<String>,
    operation_mode: String,
    items: Vec<ExecuteItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OperationEntry {
    source: String,
    target: String,
    mode: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct OperationLog {
    created_at: String,
    entries: Vec<OperationEntry>,
}

#[derive(Debug, Serialize)]
struct ExecutionSummary {
    completed: usize,
    skipped: usize,
    messages: Vec<String>,
}

fn key_entry(profile_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("profile:{profile_id}"))
        .map_err(|error| format!("无法访问系统凭据库：{error}"))
}

fn get_api_key(profile_id: &str) -> Result<String, String> {
    key_entry(profile_id)?
        .get_password()
        .map_err(|_| "尚未保存 API Key，请先在设置中填写并保存".to_string())
}

#[tauri::command]
fn save_api_key(profile_id: String, api_key: String) -> Result<(), String> {
    if api_key.trim().is_empty() {
        return Err("API Key 不能为空".to_string());
    }
    key_entry(&profile_id)?
        .set_password(api_key.trim())
        .map_err(|error| format!("保存 API Key 失败：{error}"))
}

#[tauri::command]
fn has_api_key(profile_id: String) -> Result<bool, String> {
    match key_entry(&profile_id)?.get_password() {
        Ok(value) => Ok(!value.trim().is_empty()),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(format!("读取系统凭据库失败：{error}")),
    }
}

#[tauri::command]
fn clear_api_key(profile_id: String) -> Result<(), String> {
    match key_entry(&profile_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("清除 API Key 失败：{error}")),
    }
}

#[tauri::command]
fn pick_images() -> Vec<String> {
    FileDialog::new()
        .add_filter("图片", &["jpg", "jpeg", "png", "webp", "bmp", "gif"])
        .set_title("选择需要识别和命名的图片")
        .pick_files()
        .unwrap_or_default()
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

#[tauri::command]
fn pick_directory() -> Option<String> {
    FileDialog::new()
        .set_title("选择整理后的输出目录")
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}

fn encode_jpeg(path: &Path, max_dimension: u32, quality: u8) -> Result<Vec<u8>, String> {
    let image = image::open(path).map_err(|error| format!("无法读取图片 {}：{error}", path.display()))?;
    let (width, height) = image.dimensions();
    let limit = max_dimension.max(640);
    let resized = if width > limit || height > limit {
        image.resize(limit, limit, FilterType::Triangle)
    } else {
        image
    };
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, quality)
        .encode_image(&resized)
        .map_err(|error| format!("图片压缩失败：{error}"))?;
    Ok(bytes)
}

fn image_data_url(path: &Path, max_dimension: u32) -> Result<String, String> {
    let bytes = encode_jpeg(path, max_dimension, 90)?;
    Ok(format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command]
fn load_thumbnail(path: String, max_side: u32) -> Result<String, String> {
    image_data_url(Path::new(&path), max_side.clamp(320, 1600))
}

fn endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

fn extract_message_content(response: &Value) -> Result<String, String> {
    let content = response
        .pointer("/choices/0/message/content")
        .or_else(|| response.pointer("/output/choices/0/message/content"))
        .ok_or_else(|| format!("模型响应中没有 message.content：{response}"))?;
    if let Some(text) = content.as_str() {
        return Ok(text.to_string());
    }
    if let Some(parts) = content.as_array() {
        let combined = parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        if !combined.is_empty() {
            return Ok(combined);
        }
    }
    Err("模型返回了无法解析的内容格式".to_string())
}

fn parse_model_json(content: &str) -> Result<AiRawResult, String> {
    let cleaned = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    if let Ok(value) = serde_json::from_str::<AiRawResult>(cleaned) {
        return Ok(value);
    }
    let start = cleaned.find('{').ok_or_else(|| format!("模型未返回 JSON：{cleaned}"))?;
    let end = cleaned.rfind('}').ok_or_else(|| format!("模型 JSON 不完整：{cleaned}"))?;
    serde_json::from_str::<AiRawResult>(&cleaned[start..=end])
        .map_err(|error| format!("模型 JSON 解析失败：{error}；原始内容：{cleaned}"))
}

fn normalize_number(value: &str, rules: &NumberRules) -> String {
    let mut result = value.trim().replace(['—', '–', '－', '_'], &rules.separator);
    if rules.remove_spaces {
        result = result.chars().filter(|character| !character.is_whitespace()).collect();
    } else {
        result = result.split_whitespace().collect::<Vec<_>>().join(&rules.separator);
    }
    if rules.uppercase {
        result = result.to_uppercase();
    }
    while result.contains(&format!("{}{}", rules.separator, rules.separator)) {
        result = result.replace(&format!("{}{}", rules.separator, rules.separator), &rules.separator);
    }
    result = result.trim_matches(|character| rules.separator.contains(character)).to_string();
    if rules.number_padding > 0 {
        if let Ok(trailing_digits) = Regex::new(r"(\d+)$") {
            if let Some(captures) = trailing_digits.captures(&result) {
                if let Some(digits) = captures.get(1) {
                    if digits.as_str().len() < rules.number_padding {
                        let padded = format!("{:0>width$}", digits.as_str(), width = rules.number_padding);
                        result.replace_range(digits.start()..digits.end(), &padded);
                    }
                }
            }
        }
    }
    result
}

fn contains_unknown(value: &str) -> bool {
    value.contains('?') || value.contains('*') || value.contains('�')
}

async fn request_model(
    client: &Client,
    api_key: &str,
    config: &AiConfig,
    rules: &NumberRules,
    model: &str,
    prompt: &str,
    stage: &str,
    data_url: &str,
    source_name: &str,
) -> Result<ModelOutcome, String> {
    let body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": prompt },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": format!("读取这张图片中的缸号。原文件名仅用于定位文件，不可作为识别依据：{source_name}")
                    },
                    { "type": "image_url", "image_url": { "url": data_url } }
                ]
            }
        ],
        "temperature": config.temperature,
        "max_tokens": config.max_tokens
    });
    let response = client
        .post(endpoint(&config.base_url))
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("{stage}请求失败：{error}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|error| format!("读取模型响应失败：{error}"))?;
    if !status.is_success() {
        return Err(format!("{stage}模型 {model} 返回 HTTP {status}：{text}"));
    }
    let payload: Value = serde_json::from_str(&text).map_err(|error| format!("模型响应不是 JSON：{error}"))?;
    let content = extract_message_content(&payload)?;
    let raw = parse_model_json(&content)?;
    let normalized = raw
        .cylinder_number
        .as_deref()
        .map(|value| normalize_number(value, rules))
        .filter(|value| !value.is_empty());
    let validator = Regex::new(&rules.pattern).map_err(|error| format!("缸号正则表达式无效：{error}"))?;
    let valid = normalized.as_ref().is_some_and(|value| validator.is_match(value));
    let uncertain = raw.uncertain
        || !raw.uncertain_characters.is_empty()
        || !raw.multiple_candidates.is_empty()
        || normalized.as_ref().is_none_or(|value| contains_unknown(value));
    let mut notes = Vec::new();
    if uncertain { notes.push("模型标记为不确定".to_string()); }
    if !valid { notes.push("未通过缸号格式校验".to_string()); }
    if !raw.multiple_candidates.is_empty() { notes.push("图片中存在多个候选".to_string()); }
    if let Some(evidence) = raw.evidence.clone().filter(|value| !value.trim().is_empty()) { notes.push(evidence); }
    Ok(ModelOutcome {
        pass: PassResult {
            stage: stage.to_string(),
            model: model.to_string(),
            raw_value: raw.cylinder_number.clone(),
            normalized,
            uncertain,
            valid,
            note: notes.join("；"),
        },
        raw,
    })
}

fn collect_candidates(outcomes: &[&ModelOutcome], rules: &NumberRules) -> Vec<String> {
    let mut candidates = BTreeSet::new();
    for outcome in outcomes {
        if let Some(value) = &outcome.pass.normalized {
            if !contains_unknown(value) { candidates.insert(value.clone()); }
        }
        for value in &outcome.raw.multiple_candidates {
            let normalized = normalize_number(value, rules);
            if !normalized.is_empty() && !contains_unknown(&normalized) { candidates.insert(normalized); }
        }
    }
    candidates.into_iter().collect()
}

#[tauri::command]
async fn test_connection(config: AiConfig) -> Result<String, String> {
    let api_key = get_api_key(&config.profile_id)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(config.timeout_seconds.clamp(10, 300)))
        .build()
        .map_err(|error| format!("创建网络客户端失败：{error}"))?;
    let body = json!({
        "model": config.first_model,
        "messages": [{ "role": "user", "content": "只回复 OK" }],
        "temperature": 0,
        "max_tokens": 16
    });
    let response = client
        .post(endpoint(&config.base_url))
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("网络请求失败：{error}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {status}：{text}"));
    }
    Ok(format!("连接成功，模型 {} 可访问", config.first_model))
}

#[tauri::command]
async fn analyze_image(path: String, config: AiConfig, rules: NumberRules) -> Result<AnalysisResult, String> {
    if config.base_url.trim().is_empty() || config.first_model.trim().is_empty() {
        return Err("API 地址和模型名称不能为空".to_string());
    }
    Regex::new(&rules.pattern).map_err(|error| format!("缸号正则表达式无效：{error}"))?;
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err(format!("图片不存在：{}", source.display()));
    }
    let api_key = get_api_key(&config.profile_id)?;
    let data_url = image_data_url(&source, config.max_dimension.clamp(640, 4096))?;
    let source_name = source.file_name().and_then(|value| value.to_str()).unwrap_or("image");
    let client = Client::builder()
        .timeout(Duration::from_secs(config.timeout_seconds.clamp(10, 300)))
        .build()
        .map_err(|error| format!("创建网络客户端失败：{error}"))?;

    let first = request_model(&client, &api_key, &config, &rules, &config.first_model, &config.first_prompt, "首次识别", &data_url, source_name).await?;
    let review = request_model(&client, &api_key, &config, &rules, &config.review_model, &config.review_prompt, "独立复核", &data_url, source_name).await?;

    if let (Some(first_value), Some(review_value)) = (first.eligible_value(), review.eligible_value()) {
        if first_value == review_value {
            return Ok(AnalysisResult {
                status: "auto".to_string(),
                suggested_number: Some(first_value.to_string()),
                candidates: vec![first_value.to_string()],
                reason: "两次独立识别一致且通过格式校验".to_string(),
                passes: vec![first.pass, review.pass],
            });
        }
    }

    let strict = request_model(&client, &api_key, &config, &rules, &config.strict_model, &config.strict_prompt, "加强复核", &data_url, source_name).await?;
    let first_two_distinct = [first.eligible_value(), review.eligible_value()]
        .into_iter()
        .flatten()
        .collect::<BTreeSet<_>>();
    let candidates = collect_candidates(&[&first, &review, &strict], &rules);

    if first_two_distinct.len() == 1 {
        let candidate = *first_two_distinct.iter().next().expect("set contains one value");
        if strict.eligible_value() == Some(candidate) {
            return Ok(AnalysisResult {
                status: "auto-reviewed".to_string(),
                suggested_number: Some(candidate.to_string()),
                candidates,
                reason: "一次识别明确，另一结果不完整；加强复核与明确结果一致".to_string(),
                passes: vec![first.pass, review.pass, strict.pass],
            });
        }
    }

    let has_character_conflict = first_two_distinct.len() > 1;
    let any_readable = !candidates.is_empty();
    Ok(AnalysisResult {
        status: if any_readable { "manual" } else { "failed" }.to_string(),
        suggested_number: None,
        candidates,
        reason: if has_character_conflict {
            "两次独立识别存在实质字符冲突，系统不会猜测，请填写正确缸号".to_string()
        } else if any_readable {
            "模型结果包含不确定字符、多个候选或未通过格式校验，请填写正确缸号".to_string()
        } else {
            "图片无法可靠读取缸号，请手动填写".to_string()
        },
        passes: vec![first.pass, review.pass, strict.pass],
    })
}

fn sanitize_target_name(name: &str) -> String {
    let mut cleaned = name
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            value if value.is_control() => '-',
            value => value,
        })
        .collect::<String>();
    while cleaned.ends_with(['.', ' ']) { cleaned.pop(); }
    if cleaned.len() > 220 { cleaned.truncate(220); }
    if cleaned.trim().is_empty() { "未命名".to_string() } else { cleaned }
}

fn unique_path(directory: &Path, target_name: &str) -> PathBuf {
    let safe_name = sanitize_target_name(target_name);
    let initial = directory.join(&safe_name);
    if !initial.exists() { return initial; }
    let path = Path::new(&safe_name);
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("文件");
    let extension = path.extension().and_then(|value| value.to_str()).map(|value| format!(".{value}")).unwrap_or_default();
    for index in 2..100_000 {
        let candidate = directory.join(format!("{stem} ({index}){extension}"));
        if !candidate.exists() { return candidate; }
    }
    directory.join(format!("{stem}-{}{extension}", Local::now().timestamp_millis()))
}

fn move_file(source: &Path, target: &Path) -> Result<(), String> {
    match fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(source, target).map_err(|error| format!("复制文件失败：{error}"))?;
            fs::remove_file(source).map_err(|error| format!("删除原文件失败：{error}"))?;
            Ok(())
        }
    }
}

fn log_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_data_dir().map_err(|error| format!("无法取得应用数据目录：{error}"))?;
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Ok(directory.join(OPERATION_LOG))
}

#[tauri::command]
fn execute_plan(app: tauri::AppHandle, request: ExecuteRequest) -> Result<ExecutionSummary, String> {
    if request.operation_mode != "copy" && request.operation_mode != "move" {
        return Err("文件处理模式必须是 copy 或 move".to_string());
    }
    let mut completed = 0;
    let mut skipped = 0;
    let mut messages = Vec::new();
    let mut entries = Vec::new();
    for item in request.items {
        let source = PathBuf::from(&item.source_path);
        if !source.is_file() {
            skipped += 1;
            messages.push(format!("跳过不存在的文件：{}", source.display()));
            continue;
        }
        let directory = request
            .output_dir
            .as_ref()
            .map(PathBuf::from)
            .or_else(|| source.parent().map(Path::to_path_buf))
            .ok_or_else(|| format!("无法确定输出目录：{}", source.display()))?;
        fs::create_dir_all(&directory).map_err(|error| format!("无法创建输出目录 {}：{error}", directory.display()))?;
        let target = unique_path(&directory, &item.target_name);
        let operation = if request.operation_mode == "move" {
            move_file(&source, &target)
        } else {
            fs::copy(&source, &target).map(|_| ()).map_err(|error| format!("复制文件失败：{error}"))
        };
        match operation {
            Ok(()) => {
                completed += 1;
                entries.push(OperationEntry {
                    source: source.to_string_lossy().to_string(),
                    target: target.to_string_lossy().to_string(),
                    mode: request.operation_mode.clone(),
                });
            }
            Err(error) => {
                skipped += 1;
                messages.push(format!("{}：{error}", source.display()));
            }
        }
    }
    if !entries.is_empty() {
        let log = OperationLog { created_at: Local::now().to_rfc3339(), entries };
        fs::write(log_path(&app)?, serde_json::to_vec_pretty(&log).map_err(|error| error.to_string())?)
            .map_err(|error| format!("写入撤销记录失败：{error}"))?;
    }
    Ok(ExecutionSummary { completed, skipped, messages })
}

#[tauri::command]
fn undo_last(app: tauri::AppHandle) -> Result<ExecutionSummary, String> {
    let path = log_path(&app)?;
    if !path.exists() {
        return Err("没有可撤销的操作记录".to_string());
    }
    let log: OperationLog = serde_json::from_slice(&fs::read(&path).map_err(|error| format!("读取撤销记录失败：{error}"))?)
        .map_err(|error| format!("撤销记录已损坏：{error}"))?;
    let mut completed = 0;
    let mut skipped = 0;
    let mut messages = Vec::new();
    for entry in log.entries.iter().rev() {
        let source = PathBuf::from(&entry.source);
        let target = PathBuf::from(&entry.target);
        let result = if entry.mode == "copy" {
            if target.exists() { fs::remove_file(&target).map_err(|error| error.to_string()) } else { Ok(()) }
        } else if !target.exists() {
            Ok(())
        } else if source.exists() {
            Err("原位置已有同名文件，无法自动恢复".to_string())
        } else {
            move_file(&target, &source)
        };
        match result {
            Ok(()) => completed += 1,
            Err(error) => {
                skipped += 1;
                messages.push(format!("{}：{error}", target.display()));
            }
        }
    }
    if skipped == 0 { let _ = fs::remove_file(path); }
    Ok(ExecutionSummary { completed, skipped, messages })
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            save_api_key,
            has_api_key,
            clear_api_key,
            pick_images,
            pick_directory,
            load_thumbnail,
            test_connection,
            analyze_image,
            execute_plan,
            undo_last,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AI cylinder image renamer");
}
