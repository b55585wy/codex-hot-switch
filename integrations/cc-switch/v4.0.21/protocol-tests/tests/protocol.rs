use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use cc_bridge_control_protocol_tests::*;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Barrier};

const NOW: u64 = 1_730_000_000_000;
const NONCE: &str = "00112233445566778899aabbccddeeff";
const KEY: [u8; 32] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31];

fn control() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    fs::write(directory.path().join("key"), KEY).unwrap();
    directory
}

fn request() -> Value {
    json!({"version": 1, "operation": "status", "nonce": NONCE, "issuedAt": NOW})
}

fn signed_bytes(bytes: &[u8]) -> String {
    let payload = URL_SAFE_NO_PAD.encode(bytes);
    format!("ccswitch://v1/bridge?payload={}&signature={}", payload, sign_payload(&KEY, &payload))
}

fn signed(value: &Value) -> String {
    signed_bytes(&serde_json::to_vec(value).unwrap())
}

fn prepare(directory: &Path, value: &Value) -> VerifiedRequest {
    prepare_request(directory, &signed(value)).ok().unwrap()
}

fn response(directory: &Path) -> Value {
    let bytes = fs::read(directory.join("responses").join(format!("{NONCE}.json"))).unwrap();
    let envelope: Envelope = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(envelope.signature, sign_payload(&KEY, &envelope.payload));
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(envelope.payload).unwrap()).unwrap()
}

fn account(id: &str) -> AccountMetadata {
    AccountMetadata { local_id: id.to_owned(), email: "alice@example.test".to_owned(), reauth_required: false }
}

fn provider(id: &str, account: Option<&str>, official: bool) -> ProviderBinding {
    ProviderBinding { provider_id: id.to_owned(), local_account_id: account.map(str::to_owned), official }
}

#[test]
fn node_generated_golden_request_and_signature_match() {
    let json = r#"{"version":1,"operation":"status","nonce":"00112233445566778899aabbccddeeff","issuedAt":1730000000000}"#;
    let payload = "eyJ2ZXJzaW9uIjoxLCJvcGVyYXRpb24iOiJzdGF0dXMiLCJub25jZSI6IjAwMTEyMjMzNDQ1NTY2Nzc4ODk5YWFiYmNjZGRlZWZmIiwiaXNzdWVkQXQiOjE3MzAwMDAwMDAwMDB9";
    let signature = "5666c8ebd8c2cc03e338b91b7b4f09cb3849662d66a0d142ac4b64af757b54f5";
    assert_eq!(URL_SAFE_NO_PAD.encode(json.as_bytes()), payload);
    assert_eq!(sign_payload(&KEY, payload), signature);
    let directory = control();
    let verified = prepare_request(directory.path(), &format!("ccswitch://v1/bridge?payload={payload}&signature={signature}")).ok().unwrap();
    assert!(validate_request(&verified.request, NOW).is_ok());
}

#[test]
fn account_codes_match_node_including_unicode() {
    assert_eq!(ACCOUNT_ID_DOMAIN, b"cc-switch/codex-account/v1\0");
    for (id, code) in [("fixture-account-a", "ccs-aeda2df6ebc6"), ("fixture-account-b", "ccs-1e35a621a11a"),
        ("test", "ccs-a2ca5fa7ff36"), ("账号-甲", "ccs-dd7521347109")] {
        assert_eq!(account_code(id), code);
    }
}

#[test]
fn only_bridge_route_is_intercepted() {
    assert!(is_bridge_url("ccswitch://v1/bridge?payload=x&signature=y"));
    for uri in ["ccswitch://v1/import?resource=provider", "ccswitch://v2/bridge", "https://v1/bridge", "ccswitch://v1/bridge/", "invalid"] {
        assert!(!is_bridge_url(uri));
    }
}

#[test]
fn status_without_target_validates_and_publishes_metadata_only_ready() {
    let directory = control();
    let verified = prepare(directory.path(), &request());
    validate_request(&verified.request, NOW).unwrap();
    let result = response_for(&verified, NOW, Ok(None));
    publish_response(directory.path(), &verified, &result).unwrap();
    let result = response(directory.path());
    assert_eq!(result, json!({"version":1,"nonce":NONCE,"issuedAt":NOW,"ok":true}));
}

#[test]
fn selected_status_and_activation_can_return_only_hashed_and_masked_metadata() {
    let directory = control();
    let mut value = request();
    value["accountCode"] = json!(account_code("fixture-account-a"));
    value["operation"] = json!("activate");
    let verified = prepare(directory.path(), &value);
    validate_request(&verified.request, NOW).unwrap();
    let summary = AccountSummary { account_code: account_code("fixture-account-a"), masked_email: mask_email("alice@example.test"),
        email_hash: account_email_hash("alice@example.test") };
    publish_response(directory.path(), &verified, &response_for(&verified, NOW, Ok(Some(summary)))).unwrap();
    let result = response(directory.path());
    assert_eq!(result["accountCode"], "ccs-aeda2df6ebc6");
    assert_eq!(result["maskedEmail"], "a***@example.test");
    let mut fields: Vec<_> = result.as_object().unwrap().keys().map(String::as_str).collect();
    fields.sort();
    assert_eq!(fields, vec!["accountCode", "emailHash", "issuedAt", "maskedEmail", "nonce", "ok", "version"]);
    assert_eq!(result["emailHash"], account_email_hash(" ALICE@example.test "));
    let encoded = result.to_string();
    for private in ["fixture-account-a", "alice@example.test", "access_token", "refresh_token", "id_token"] { assert!(!encoded.contains(private)); }
}

#[test]
fn payload_and_signature_tampering_are_rejected_before_nonce_write() {
    for uri in [signed(&request()).replace("signature=", "signature=f"), signed(&request()).replace("payload=", "payload=e")] {
        let directory = control();
        assert_eq!(prepare_request(directory.path(), &uri).err(), Some(SafeError::InvalidRequest));
        assert!(!directory.path().join("nonces").exists());
        assert!(!directory.path().join("responses").exists());
    }
}

#[test]
fn another_key_cannot_authorize_request() {
    let directory = control();
    fs::write(directory.path().join("key"), [99u8; 32]).unwrap();
    assert_eq!(prepare_request(directory.path(), &signed(&request())).err(), Some(SafeError::InvalidRequest));
    assert!(!directory.path().join("nonces").exists());
}

#[test]
fn missing_or_non_32_byte_key_fails_closed_and_never_generates_key() {
    for length in [0, 31, 33] {
        let directory = control();
        fs::write(directory.path().join("key"), vec![0; length]).unwrap();
        assert_eq!(prepare_request(directory.path(), &signed(&request())).err(), Some(SafeError::ControlUnavailable));
        assert_eq!(fs::read(directory.path().join("key")).unwrap().len(), length);
    }
    let directory = tempfile::tempdir().unwrap();
    assert_eq!(prepare_request(directory.path(), &signed(&request())).err(), Some(SafeError::ControlUnavailable));
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
}

#[test]
fn key_path_must_be_regular_file() {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir(directory.path().join("key")).unwrap();
    assert_eq!(prepare_request(directory.path(), &signed(&request())).err(), Some(SafeError::ControlUnavailable));
}

#[test]
fn duplicate_extra_query_credentials_port_and_fragment_are_rejected() {
    let original = signed(&request());
    for uri in [format!("{original}&payload=x"), format!("{original}&extra=x"), format!("{original}&signature=x"),
        format!("{original}#fragment"), original.replace("v1/", "user@v1/"), original.replace("v1/", "v1:42/")] {
        let directory = control();
        assert_eq!(prepare_request(directory.path(), &uri).err(), Some(SafeError::InvalidRequest));
        assert!(!directory.path().join("nonces").exists());
    }
}

#[test]
fn over_limit_uri_is_rejected_without_io() {
    let directory = tempfile::tempdir().unwrap();
    let uri = format!("ccswitch://v1/bridge?payload={}&signature={}", "x".repeat(8_192), "a".repeat(64));
    assert_eq!(prepare_request(directory.path(), &uri).err(), Some(SafeError::InvalidRequest));
}

#[test]
fn invalid_json_and_unknown_fields_or_operations_never_reserve_nonce() {
    for bytes in [b"{".as_slice(), b"null".as_slice(),
        br#"{"version":1,"operation":"export","nonce":"00112233445566778899aabbccddeeff","issuedAt":1730000000000}"#.as_slice(),
        br#"{"version":1,"operation":"status","nonce":"00112233445566778899aabbccddeeff","issuedAt":1730000000000,"token":"fixture-private"}"#.as_slice(),
        br#"{"version":1,"operation":"status","nonce":"00112233445566778899aabbccddeeff","issuedAt":-1}"#.as_slice()] {
        let directory = control();
        assert_eq!(prepare_request(directory.path(), &signed_bytes(bytes)).err(), Some(SafeError::InvalidRequest));
        assert!(!directory.path().join("nonces").exists());
    }
}

#[test]
fn malformed_nonce_cannot_escape_directory() {
    for nonce in ["../outside", "", "a", "00112233445566778899AABBCCDDEEFF", "00112233445566778899aabbccddeeff00"] {
        let directory = control();
        let mut value = request(); value["nonce"] = json!(nonce);
        assert_eq!(prepare_request(directory.path(), &signed(&value)).err(), Some(SafeError::InvalidRequest));
        assert!(!directory.path().join("nonces").exists());
    }
}

#[test]
fn accepted_clock_window_includes_exact_60_seconds_both_directions() {
    for timestamp in [NOW - 60_000, NOW, NOW + 60_000] {
        let directory = control(); let mut value = request(); value["issuedAt"] = json!(timestamp);
        let verified = prepare(directory.path(), &value);
        assert!(validate_request(&verified.request, NOW).is_ok());
    }
}

#[test]
fn expired_and_far_future_requests_return_signed_safe_failure_without_operation() {
    for timestamp in [NOW - 60_001, NOW + 60_001, 0, u64::MAX] {
        let directory = control(); let mut value = request(); value["issuedAt"] = json!(timestamp);
        let verified = prepare(directory.path(), &value);
        assert_eq!(validate_request(&verified.request, NOW), Err(SafeError::ExpiredRequest));
        publish_response(directory.path(), &verified, &response_for(&verified, NOW, Err(SafeError::ExpiredRequest))).unwrap();
        assert_eq!(response(directory.path())["error"], "expired_request");
    }
}

#[test]
fn version_missing_target_and_malformed_codes_fail_validation() {
    for changes in [json!({"version":2}), json!({"operation":"activate"}), json!({"accountCode":"ccs-ABCDEF123456"}),
        json!({"accountCode":"ccs-abc"}), json!({"accountCode":"../outside"}), json!({"accountCode":"ççs-123456789abc"})] {
        let directory = control(); let mut value = request();
        for (name, value_to_set) in changes.as_object().unwrap() { value[name] = value_to_set.clone(); }
        let verified = prepare(directory.path(), &value);
        assert_eq!(validate_request(&verified.request, NOW), Err(SafeError::InvalidRequest));
    }
}

#[test]
fn nonce_is_durable_and_replay_does_not_replace_first_response() {
    let directory = control();
    let verified = prepare(directory.path(), &request());
    publish_response(directory.path(), &verified, &response_for(&verified, NOW, Ok(None))).unwrap();
    assert_eq!(prepare_request(directory.path(), &signed(&request())).err(), Some(SafeError::Replay));
    assert_eq!(publish_response(directory.path(), &verified, &response_for(&verified, NOW + 1, Err(SafeError::ActivationFailed))), Err(SafeError::ControlUnavailable));
    assert_eq!(response(directory.path())["ok"], true);
    assert_eq!(response(directory.path())["issuedAt"], NOW);
}

#[test]
fn concurrent_same_nonce_has_exactly_one_winner() {
    let directory = control(); let uri = signed(&request()); let barrier = Arc::new(Barrier::new(8));
    let threads: Vec<_> = (0..8).map(|_| {
        let path = directory.path().to_owned(); let uri = uri.clone(); let barrier = barrier.clone();
        std::thread::spawn(move || { barrier.wait(); prepare_request(&path, &uri).map(|_| ()).err() })
    }).collect();
    let results: Vec<_> = threads.into_iter().map(|thread| thread.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|result| result.is_none()).count(), 1);
    assert_eq!(results.iter().filter(|result| **result == Some(SafeError::Replay)).count(), 7);
}

#[test]
fn unavailable_nonce_storage_fails_before_operation() {
    let directory = control(); fs::write(directory.path().join("nonces"), "fixture").unwrap();
    assert_eq!(prepare_request(directory.path(), &signed(&request())).err(), Some(SafeError::ControlUnavailable));
}

#[test]
fn unavailable_response_storage_does_not_claim_published_success() {
    let directory = control(); let verified = prepare(directory.path(), &request());
    fs::write(directory.path().join("responses"), "fixture").unwrap();
    assert_eq!(publish_response(directory.path(), &verified, &response_for(&verified, NOW, Ok(None))), Err(SafeError::ControlUnavailable));
    assert_eq!(prepare_request(directory.path(), &signed(&request())).err(), Some(SafeError::Replay));
}

#[test]
fn unique_account_is_selected_by_hashed_id_not_position_or_default() {
    let accounts = vec![account("fixture-account-b"), account("fixture-account-a")];
    let selected = select_account("ccs-aeda2df6ebc6", &accounts).unwrap_or_else(|_| panic!("known fixture"));
    assert_eq!(selected.local_id, "fixture-account-a");
}

#[test]
fn missing_and_ambiguous_accounts_fail_closed() {
    assert_eq!(select_account("ccs-aeda2df6ebc6", &[]).err(), Some(SafeError::AccountNotFound));
    let accounts = vec![account("fixture-account-a"), account("fixture-account-a")];
    assert_eq!(select_account("ccs-aeda2df6ebc6", &accounts).err(), Some(SafeError::AccountAmbiguous));
}

#[test]
fn unique_official_binding_is_selected_without_creating_or_editing_provider() {
    let providers = vec![provider("wrong", Some("b"), true), provider("third-party", Some("a"), false),
        provider("unbound", None, true), provider("official-a", Some("a"), true)];
    assert_eq!(select_provider("a", &providers), Ok("official-a"));
}

#[test]
fn missing_and_ambiguous_official_bindings_fail_closed() {
    assert_eq!(select_provider("a", &[provider("third-party", Some("a"), false)]), Err(SafeError::ProviderNotBound));
    assert_eq!(select_provider("a", &[provider("unbound", None, true)]), Err(SafeError::ProviderNotBound));
    assert_eq!(select_provider("a", &[provider("one", Some("a"), true), provider("two", Some("a"), true)]), Err(SafeError::ProviderAmbiguous));
}

#[test]
fn email_masks_match_metadata_adapter_and_invalid_values_are_hidden() {
    for (input, expected) in [("alice@EXAMPLE.TEST", "a***@example.test"), (" a@example.test ", "a***@example.test"),
        ("王一@example.test", "王***@example.test"), ("a+b@example.test", "a***@example.test"),
        ("", "未提供邮箱"), ("raw-account-id", "未提供邮箱"), ("a@x..test", "未提供邮箱"), ("<script>@example.test", "未提供邮箱")] {
        assert_eq!(mask_email(input), expected);
    }
}

#[test]
fn every_published_error_is_fixed_safe_code_without_exception_or_target_data() {
    for error in [SafeError::InvalidRequest, SafeError::ExpiredRequest, SafeError::Replay, SafeError::ControlUnavailable,
        SafeError::AppNotReady, SafeError::AccountNotFound, SafeError::AccountAmbiguous, SafeError::ReauthRequired,
        SafeError::ProviderNotBound, SafeError::ProviderAmbiguous, SafeError::ProviderReadFailed, SafeError::ActivationFailed] {
        let directory = control(); let verified = prepare(directory.path(), &request());
        publish_response(directory.path(), &verified, &response_for(&verified, NOW, Err(error))).unwrap();
        let result = response(directory.path());
        assert_eq!(result["ok"], false);
        assert_eq!(result.as_object().unwrap().len(), 5);
        assert!(result["error"].as_str().unwrap().chars().all(|character| character.is_ascii_lowercase() || character == '_'));
        assert!(result.get("accountCode").is_none()); assert!(result.get("maskedEmail").is_none());
    }
}

#[test]
fn independent_hmac_verifier_rejects_modified_response() {
    let directory = control(); let verified = prepare(directory.path(), &request());
    publish_response(directory.path(), &verified, &response_for(&verified, NOW, Ok(None))).unwrap();
    let envelope: Envelope = serde_json::from_slice(&fs::read(directory.path().join("responses").join(format!("{NONCE}.json"))).unwrap()).unwrap();
    let signature: Vec<u8> = (0..64).step_by(2).map(|index| u8::from_str_radix(&envelope.signature[index..index + 2], 16).unwrap()).collect();
    let mut verifier = Hmac::<Sha256>::new_from_slice(&KEY).unwrap();
    verifier.update(format!("{}x", envelope.payload).as_bytes());
    assert!(verifier.verify_slice(&signature).is_err());
}
