//! Optional CC Switch v4.0.21 in-process bridge. Never exports credential material.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

pub const ACCOUNT_ID_DOMAIN: &[u8] = b"cc-switch/codex-account/v1\0";
pub const MAX_CLOCK_SKEW_MS: u64 = 60_000;
const MAX_URL_BYTES: usize = 8_192;
type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Status,
    Activate,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub version: u32,
    pub operation: Operation,
    pub nonce: String,
    pub issued_at: u64,
    pub account_code: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SafeError {
    InvalidRequest,
    ExpiredRequest,
    Replay,
    ControlUnavailable,
    AppNotReady,
    AccountNotFound,
    AccountAmbiguous,
    ReauthRequired,
    ProviderNotBound,
    ProviderAmbiguous,
    ProviderReadFailed,
    ActivationFailed,
    AccountIdentityUnavailable,
}

pub struct VerifiedRequest {
    pub request: Request,
    key: [u8; 32],
}

pub struct AccountMetadata {
    pub local_id: String,
    pub email: String,
    pub reauth_required: bool,
}

pub struct ProviderBinding {
    pub provider_id: String,
    pub local_account_id: Option<String>,
    pub official: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub account_code: String,
    pub masked_email: String,
    pub email_hash: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub payload: String,
    pub signature: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    version: u32,
    nonce: String,
    issued_at: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    account_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    masked_email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    email_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<SafeError>,
}

pub fn account_code(local_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(ACCOUNT_ID_DOMAIN);
    hash.update(local_id.as_bytes());
    format!("ccs-{}", hex(&hash.finalize())[..12].to_owned())
}

pub fn account_email_hash(email: &str) -> String {
    hex(&Sha256::digest(email.trim().to_lowercase().as_bytes()))
}

pub fn mask_email(value: &str) -> String {
    static EMAIL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let pattern = EMAIL.get_or_init(|| {
        regex::Regex::new(r"^([\p{L}\p{N}])[\p{L}\p{N}._%+-]*@([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)$")
            .expect("constant email expression")
    });
    match pattern.captures(value.trim()) {
        Some(parts) if !parts[2].contains("..") => {
            format!("{}***@{}", &parts[1], parts[2].to_ascii_lowercase())
        }
        _ => "未提供邮箱".to_owned(),
    }
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn is_bridge_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "ccswitch" && url.host_str() == Some("v1") && url.path() == "/bridge"
    })
}

fn envelope_from_url(value: &str) -> Result<Envelope, SafeError> {
    if value.len() > MAX_URL_BYTES || !is_bridge_url(value) {
        return Err(SafeError::InvalidRequest);
    }
    let url = url::Url::parse(value).map_err(|_| SafeError::InvalidRequest)?;
    if !url.username().is_empty() || url.password().is_some() || url.port().is_some() || url.fragment().is_some() {
        return Err(SafeError::InvalidRequest);
    }
    let mut payload = None;
    let mut signature = None;
    for (name, value) in url.query_pairs() {
        match name.as_ref() {
            "payload" if payload.is_none() => payload = Some(value.into_owned()),
            "signature" if signature.is_none() => signature = Some(value.into_owned()),
            _ => return Err(SafeError::InvalidRequest),
        }
    }
    let envelope = Envelope {
        payload: payload.ok_or(SafeError::InvalidRequest)?,
        signature: signature.ok_or(SafeError::InvalidRequest)?,
    };
    if envelope.payload.is_empty() || !is_lower_hex(&envelope.signature, 64) {
        return Err(SafeError::InvalidRequest);
    }
    Ok(envelope)
}

fn read_key(control: &Path) -> Result<[u8; 32], SafeError> {
    let path = control.join("key");
    let metadata = fs::symlink_metadata(&path).map_err(|_| SafeError::ControlUnavailable)?;
    if !metadata.file_type().is_file() || metadata.len() != 32 {
        return Err(SafeError::ControlUnavailable);
    }
    let mut bytes = Vec::new();
    File::open(path).and_then(|file| file.take(33).read_to_end(&mut bytes))
        .map_err(|_| SafeError::ControlUnavailable)?;
    bytes.try_into().map_err(|_| SafeError::ControlUnavailable)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn sign_payload(key: &[u8; 32], payload: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts a 32-byte key");
    mac.update(payload.as_bytes());
    hex(&mac.finalize().into_bytes())
}

fn signature_bytes(value: &str) -> Result<Vec<u8>, SafeError> {
    if !is_lower_hex(value, 64) { return Err(SafeError::InvalidRequest); }
    (0..value.len()).step_by(2)
        .map(|offset| u8::from_str_radix(&value[offset..offset + 2], 16).map_err(|_| SafeError::InvalidRequest))
        .collect()
}

/// Authenticate first; reserve a nonce before any operation or error response.
/// Replays must not replace an earlier response, even while its operation is in flight.
pub fn prepare_request(control: &Path, value: &str) -> Result<VerifiedRequest, SafeError> {
    let envelope = envelope_from_url(value)?;
    let key = read_key(control)?;
    let mut mac = HmacSha256::new_from_slice(&key).expect("HMAC accepts a 32-byte key");
    mac.update(envelope.payload.as_bytes());
    mac.verify_slice(&signature_bytes(&envelope.signature)?).map_err(|_| SafeError::InvalidRequest)?;
    let bytes = URL_SAFE_NO_PAD.decode(&envelope.payload).map_err(|_| SafeError::InvalidRequest)?;
    if URL_SAFE_NO_PAD.encode(&bytes) != envelope.payload { return Err(SafeError::InvalidRequest); }
    let request: Request = serde_json::from_slice(&bytes).map_err(|_| SafeError::InvalidRequest)?;
    if !is_lower_hex(&request.nonce, 32) { return Err(SafeError::InvalidRequest); }
    let nonces = control.join("nonces");
    fs::create_dir_all(&nonces).map_err(|_| SafeError::ControlUnavailable)?;
    let mut marker = OpenOptions::new().write(true).create_new(true).open(nonces.join(&request.nonce))
        .map_err(|error| if error.kind() == std::io::ErrorKind::AlreadyExists { SafeError::Replay } else { SafeError::ControlUnavailable })?;
    marker.write_all(request.issued_at.to_string().as_bytes()).and_then(|_| marker.sync_all())
        .map_err(|_| SafeError::ControlUnavailable)?;
    Ok(VerifiedRequest { request, key })
}

pub fn validate_request(request: &Request, now_ms: u64) -> Result<(), SafeError> {
    if request.version != 1 { return Err(SafeError::InvalidRequest); }
    if request.issued_at.abs_diff(now_ms) > MAX_CLOCK_SKEW_MS { return Err(SafeError::ExpiredRequest); }
    match request.account_code.as_deref() {
        Some(code) if !code.starts_with("ccs-") || !is_lower_hex(&code[4..], 12) => Err(SafeError::InvalidRequest),
        None if request.operation == Operation::Activate => Err(SafeError::InvalidRequest),
        _ => Ok(()),
    }
}

pub fn select_account<'a>(code: &str, accounts: &'a [AccountMetadata]) -> Result<&'a AccountMetadata, SafeError> {
    let mut matching = accounts.iter().filter(|account| account_code(&account.local_id) == code);
    let selected = matching.next().ok_or(SafeError::AccountNotFound)?;
    if matching.next().is_some() { return Err(SafeError::AccountAmbiguous); }
    Ok(selected)
}

pub fn select_provider<'a>(local_id: &str, providers: &'a [ProviderBinding]) -> Result<&'a str, SafeError> {
    let mut matching = providers.iter().filter(|provider| {
        provider.official && provider.local_account_id.as_deref() == Some(local_id)
    });
    let selected = matching.next().ok_or(SafeError::ProviderNotBound)?;
    if matching.next().is_some() { return Err(SafeError::ProviderAmbiguous); }
    Ok(&selected.provider_id)
}

pub fn response_for(verified: &VerifiedRequest, now_ms: u64, result: Result<Option<AccountSummary>, SafeError>) -> Response {
    let (ok, summary, error) = match result {
        Ok(summary) => (true, summary, None),
        Err(error) => (false, None, Some(error)),
    };
    Response {
        version: 1, nonce: verified.request.nonce.clone(), issued_at: now_ms, ok,
        account_code: summary.as_ref().map(|value| value.account_code.clone()),
        masked_email: summary.as_ref().map(|value| value.masked_email.clone()),
        email_hash: summary.map(|value| value.email_hash), error,
    }
}

/// Publish once, atomically. No tokens, account IDs, upstream errors, or raw email.
pub fn publish_response(control: &Path, verified: &VerifiedRequest, response: &Response) -> Result<(), SafeError> {
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(response).map_err(|_| SafeError::ControlUnavailable)?);
    let envelope = Envelope { signature: sign_payload(&verified.key, &payload), payload };
    let bytes = serde_json::to_vec(&envelope).map_err(|_| SafeError::ControlUnavailable)?;
    let responses = control.join("responses");
    fs::create_dir_all(&responses).map_err(|_| SafeError::ControlUnavailable)?;
    let mut temporary = tempfile::NamedTempFile::new_in(&responses).map_err(|_| SafeError::ControlUnavailable)?;
    temporary.write_all(&bytes).and_then(|_| temporary.as_file().sync_all()).map_err(|_| SafeError::ControlUnavailable)?;
    temporary.persist_noclobber(responses.join(format!("{}.json", verified.request.nonce)))
        .map_err(|_| SafeError::ControlUnavailable)?;
    Ok(())
}

#[cfg(feature = "cc-bridge-control")]
pub use app::try_handle;

#[cfg(feature = "cc-bridge-control")]
mod app {
    use super::*;
    use crate::app_config::AppType;
    use crate::commands::CodexOAuthState;
    use crate::services::provider::codex_direct;
    use crate::services::ProviderService;
    use crate::store::AppState;
    use tauri::Manager;

    static OPERATIONS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn now_ms() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64).unwrap_or(0)
    }

    pub fn try_handle(app: &tauri::AppHandle, value: &str) -> bool {
        if !is_bridge_url(value) { return false; }
        let app = app.clone();
        let value = value.to_owned();
        tauri::async_runtime::spawn(async move {
            let _serial = OPERATIONS.lock().await;
            let Some(home) = dirs::home_dir() else { return; };
            let control = home.join(".cc-switch").join("bridge-control");
            let Ok(verified) = prepare_request(&control, &value) else { return; };
            let result = match validate_request(&verified.request, now_ms()) {
                Ok(()) => perform(&app, &verified.request).await,
                Err(error) => Err(error),
            };
            let response = response_for(&verified, now_ms(), result);
            let _ = publish_response(&control, &verified, &response);
        });
        true
    }

    async fn perform(app: &tauri::AppHandle, request: &Request) -> Result<Option<AccountSummary>, SafeError> {
        let manager = app.try_state::<CodexOAuthState>().ok_or(SafeError::AppNotReady)?;
        let Some(code) = request.account_code.as_deref() else { return Ok(None); };
        let accounts: Vec<AccountMetadata> = manager.0.list_accounts().await.into_iter().map(|account| {
            AccountMetadata { local_id: account.id, email: account.login, reauth_required: account.reauth_required }
        }).collect();
        let selected = select_account(code, &accounts)?;
        let masked_email = mask_email(&selected.email);
        if masked_email == "未提供邮箱" { return Err(SafeError::AccountIdentityUnavailable); }
        let summary = AccountSummary { account_code: code.to_owned(), masked_email,
            email_hash: account_email_hash(&selected.email) };
        if request.operation == Operation::Status { return Ok(Some(summary)); }
        if selected.reauth_required { return Err(SafeError::ReauthRequired); }
        let provider_id = {
            let state = app.try_state::<AppState>().ok_or(SafeError::AppNotReady)?;
            let providers = ProviderService::list(state.inner(), AppType::Codex).map_err(|_| SafeError::ProviderReadFailed)?;
            let bindings: Vec<ProviderBinding> = providers.values().map(|provider| ProviderBinding {
                provider_id: provider.id.clone(),
                local_account_id: ProviderService::managed_codex_oauth_account_id(provider),
                official: codex_direct::is_official(provider),
            }).collect();
            select_provider(&selected.local_id, &bindings)?.to_owned()
        };
        // The existing command owns the blocking service boundary and manager refresh/adoption chain.
        crate::commands::switch_provider(app.clone(), "codex".to_owned(), provider_id)
            .await.map_err(|_| SafeError::ActivationFailed)?;
        Ok(Some(summary))
    }
}
