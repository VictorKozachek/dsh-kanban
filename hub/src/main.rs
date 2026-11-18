//! kanban-hub — общий хаб карточек для распределённой доски.
//!
//! MVP (M0): один проект, SQLite, lease/claim, CAS по `rev`, синхронизация
//! снимков карточек. Роли и сессии остаются локальными у клиентов; хаб
//! координирует только карточки.
//!
//! API (все, кроме `/healthz`, требуют `Authorization: Bearer <token>`):
//! - `GET  /healthz`
//! - `POST /v1/projects/{project}/instances/{instance}/heartbeat`
//! - `GET  /v1/projects/{project}/cards?since=<updated_at>`
//! - `POST /v1/projects/{project}/cards/{card}/claim`
//! - `POST /v1/projects/{project}/cards/{card}/release`
//! - `POST /v1/projects/{project}/cards/{card}/handoff`
//! - `PUT  /v1/projects/{project}/cards/{card}` — upsert снимка с baseRev.
//!
//! Запуск:
//!   KANBAN_HUB_TOKEN=secret KANBAN_HUB_DB=hub.sqlite cargo run
//!   KANBAN_HUB_ADDR=127.0.0.1:8787 (по умолчанию)
use std::collections::HashMap;
use std::env;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const DEFAULT_ADDR: &str = "127.0.0.1:8787";
const DEFAULT_DB: &str = "hub.sqlite";
const DEFAULT_TTL_MS: i64 = 30 * 60 * 1000;

#[derive(Clone)]
struct AppState {
    db: Arc<Mutex<Connection>>,
    token: String,
    lease_ttl_ms: i64,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

fn db_error(error: rusqlite::Error) -> ApiError {
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, format!("db: {error}"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Serialize)]
struct LeaseDto {
    instance: String,
    user: String,
    until: i64,
}

#[derive(Serialize)]
struct CardDto {
    id: String,
    rev: i64,
    payload: Value,
    assignee: Option<String>,
    lease: Option<LeaseDto>,
    updated_at: i64,
}

struct CardRow {
    id: String,
    rev: i64,
    payload: String,
    assignee: Option<String>,
    lease_instance: Option<String>,
    lease_user: Option<String>,
    lease_until: Option<i64>,
    updated_at: i64,
}

fn card_dto(row: CardRow) -> CardDto {
    let lease = match (row.lease_instance, row.lease_user, row.lease_until) {
        (Some(instance), Some(user), Some(until)) => Some(LeaseDto {
            instance,
            user,
            until,
        }),
        _ => None,
    };
    CardDto {
        id: row.id,
        rev: row.rev,
        payload: serde_json::from_str(&row.payload).unwrap_or(Value::Null),
        assignee: row.assignee,
        lease,
        updated_at: row.updated_at,
    }
}

fn load_card(conn: &Connection, project: &str, card: &str) -> Result<Option<CardRow>, ApiError> {
    conn.query_row(
        "SELECT id, rev, payload, assignee, lease_instance, lease_user, lease_until, updated_at
           FROM cards WHERE project = ?1 AND id = ?2",
        params![project, card],
        |row| {
            Ok(CardRow {
                id: row.get(0)?,
                rev: row.get(1)?,
                payload: row.get(2)?,
                assignee: row.get(3)?,
                lease_instance: row.get(4)?,
                lease_user: row.get(5)?,
                lease_until: row.get(6)?,
                updated_at: row.get(7)?,
            })
        },
    )
    .optional()
    .map_err(db_error)
}

fn authorize(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let value = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let expected = format!("Bearer {}", state.token);
    if value == expected {
        Ok(())
    } else {
        Err(ApiError::new(StatusCode::UNAUTHORIZED, "unauthorized"))
    }
}

async fn healthz() -> &'static str {
    "ok"
}

#[derive(Deserialize)]
struct Heartbeat {
    user: String,
}

async fn heartbeat(
    State(state): State<AppState>,
    Path((project, instance)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<Heartbeat>,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers)?;
    if body.user.trim().is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "user is required"));
    }
    let conn = state.db.lock().unwrap();
    conn.execute(
        "INSERT INTO instances (project, instance, user, last_seen)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(project, instance) DO UPDATE SET user = excluded.user, last_seen = excluded.last_seen",
        params![project, instance, body.user, now_ms()],
    )
    .map_err(db_error)?;
    Ok(Json(json!({ "ok": true })))
}

async fn list_cards(
    State(state): State<AppState>,
    Path(project): Path<String>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers)?;
    let since: i64 = query
        .get("since")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let conn = state.db.lock().unwrap();
    let mut statement = conn
        .prepare(
            "SELECT id, rev, payload, assignee, lease_instance, lease_user, lease_until, updated_at
               FROM cards WHERE project = ?1 AND updated_at > ?2 ORDER BY updated_at ASC",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![project, since], |row| {
            Ok(CardRow {
                id: row.get(0)?,
                rev: row.get(1)?,
                payload: row.get(2)?,
                assignee: row.get(3)?,
                lease_instance: row.get(4)?,
                lease_user: row.get(5)?,
                lease_until: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(db_error)?;
    let mut cards = Vec::new();
    for row in rows {
        cards.push(card_dto(row.map_err(db_error)?));
    }
    Ok(Json(json!({ "cards": cards })))
}

#[derive(Deserialize)]
struct ClaimCard {
    instance: String,
    user: String,
    ttl_seconds: Option<i64>,
}

async fn claim_card(
    State(state): State<AppState>,
    Path((project, card)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<ClaimCard>,
) -> Result<Json<CardDto>, ApiError> {
    authorize(&state, &headers)?;
    let conn = state.db.lock().unwrap();
    let current = load_card(&conn, &project, &card)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "card not found"))?;
    let now = now_ms();
    let held = current
        .lease_until
        .map(|until| until > now)
        .unwrap_or(false);
    if held && current.lease_instance.as_deref() != Some(body.instance.as_str()) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            format!(
                "card is held by {} until {}",
                current.lease_instance.unwrap_or_default(),
                current.lease_until.unwrap_or(0)
            ),
        ));
    }
    let ttl = body
        .ttl_seconds
        .map(|seconds| (seconds.clamp(1, 86_400)) * 1000)
        .unwrap_or(state.lease_ttl_ms);
    conn.execute(
        "UPDATE cards SET lease_instance = ?3, lease_user = ?4, lease_until = ?5, updated_at = ?6
           WHERE project = ?1 AND id = ?2",
        params![project, card, body.instance, body.user, now + ttl, now],
    )
    .map_err(db_error)?;
    let row = load_card(&conn, &project, &card)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "card not found"))?;
    Ok(Json(card_dto(row)))
}

#[derive(Deserialize)]
struct ReleaseCard {
    instance: String,
}

fn require_holder(
    conn: &Connection,
    project: &str,
    card: &str,
    instance: &str,
) -> Result<CardRow, ApiError> {
    let current = load_card(conn, project, card)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "card not found"))?;
    let now = now_ms();
    let held = current
        .lease_until
        .map(|until| until > now)
        .unwrap_or(false);
    if !held || current.lease_instance.as_deref() != Some(instance) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "card is not leased by this instance",
        ));
    }
    Ok(current)
}

async fn release_card(
    State(state): State<AppState>,
    Path((project, card)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<ReleaseCard>,
) -> Result<Json<CardDto>, ApiError> {
    authorize(&state, &headers)?;
    let conn = state.db.lock().unwrap();
    require_holder(&conn, &project, &card, &body.instance)?;
    let now = now_ms();
    conn.execute(
        "UPDATE cards SET lease_instance = NULL, lease_user = NULL, lease_until = NULL, updated_at = ?3
           WHERE project = ?1 AND id = ?2",
        params![project, card, now],
    )
    .map_err(db_error)?;
    let row = load_card(&conn, &project, &card)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "card not found"))?;
    Ok(Json(card_dto(row)))
}

#[derive(Deserialize)]
struct HandoffCard {
    instance: String,
    assignee: String,
}

async fn handoff_card(
    State(state): State<AppState>,
    Path((project, card)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<HandoffCard>,
) -> Result<Json<CardDto>, ApiError> {
    authorize(&state, &headers)?;
    let conn = state.db.lock().unwrap();
    require_holder(&conn, &project, &card, &body.instance)?;
    let now = now_ms();
    conn.execute(
        "UPDATE cards SET assignee = ?3, lease_instance = NULL, lease_user = NULL,
                          lease_until = NULL, updated_at = ?4
           WHERE project = ?1 AND id = ?2",
        params![project, card, body.assignee, now],
    )
    .map_err(db_error)?;
    let row = load_card(&conn, &project, &card)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "card not found"))?;
    Ok(Json(card_dto(row)))
}

#[derive(Deserialize)]
struct UpsertCard {
    instance: String,
    user: String,
    base_rev: i64,
    payload: Value,
    assignee: Option<String>,
}

async fn upsert_card(
    State(state): State<AppState>,
    Path((project, card)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<UpsertCard>,
) -> Result<Json<CardDto>, ApiError> {
    authorize(&state, &headers)?;
    if body.user.trim().is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "user is required"));
    }
    let payload = serde_json::to_string(&body.payload)
        .map_err(|error| ApiError::new(StatusCode::BAD_REQUEST, format!("payload: {error}")))?;
    let conn = state.db.lock().unwrap();
    let now = now_ms();
    let existing = load_card(&conn, &project, &card)?;
    match existing {
        None => {
            if body.base_rev != 0 {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "card does not exist; base_rev must be 0",
                ));
            }
            conn.execute(
                "INSERT INTO cards
                   (project, id, rev, payload, assignee, lease_instance, lease_user, lease_until, updated_at)
                 VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    project,
                    card,
                    payload,
                    body.assignee,
                    body.instance,
                    body.user,
                    now + state.lease_ttl_ms,
                    now
                ],
            )
            .map_err(db_error)?;
        }
        Some(current) => {
            let held = current
                .lease_until
                .map(|until| until > now)
                .unwrap_or(false);
            if !held || current.lease_instance.as_deref() != Some(body.instance.as_str()) {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "card is not leased by this instance",
                ));
            }
            if current.rev != body.base_rev {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    format!("stale base_rev: current {}", current.rev),
                ));
            }
            let assignee = body.assignee.or(current.assignee.clone());
            conn.execute(
                "UPDATE cards SET rev = rev + 1, payload = ?3, assignee = ?4,
                                  lease_until = ?5, updated_at = ?6
                   WHERE project = ?1 AND id = ?2",
                params![
                    project,
                    card,
                    payload,
                    assignee,
                    now + state.lease_ttl_ms,
                    now
                ],
            )
            .map_err(db_error)?;
        }
    }
    let row = load_card(&conn, &project, &card)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "card not found"))?;
    Ok(Json(card_dto(row)))
}

fn init_db(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS instances (
           project TEXT NOT NULL,
           instance TEXT NOT NULL,
           user TEXT NOT NULL,
           last_seen INTEGER NOT NULL,
           PRIMARY KEY (project, instance)
         );
         CREATE TABLE IF NOT EXISTS cards (
           project TEXT NOT NULL,
           id TEXT NOT NULL,
           rev INTEGER NOT NULL,
           payload TEXT NOT NULL,
           assignee TEXT,
           lease_instance TEXT,
           lease_user TEXT,
           lease_until INTEGER,
           updated_at INTEGER NOT NULL,
           PRIMARY KEY (project, id)
         );
         CREATE INDEX IF NOT EXISTS cards_updated ON cards(project, updated_at);",
    )
}

fn app(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route(
            "/v1/projects/{project}/instances/{instance}/heartbeat",
            post(heartbeat),
        )
        .route("/v1/projects/{project}/cards", get(list_cards))
        .route("/v1/projects/{project}/cards/{card}", put(upsert_card))
        .route(
            "/v1/projects/{project}/cards/{card}/claim",
            post(claim_card),
        )
        .route(
            "/v1/projects/{project}/cards/{card}/release",
            post(release_card),
        )
        .route(
            "/v1/projects/{project}/cards/{card}/handoff",
            post(handoff_card),
        )
        .with_state(state)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr = env::var("KANBAN_HUB_ADDR").unwrap_or_else(|_| DEFAULT_ADDR.to_string());
    let db_path = env::var("KANBAN_HUB_DB").unwrap_or_else(|_| DEFAULT_DB.to_string());
    let token = env::var("KANBAN_HUB_TOKEN").unwrap_or_else(|_| "dev-token".to_string());
    let lease_ttl_ms = env::var("KANBAN_HUB_LEASE_TTL_SECONDS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .map(|seconds| seconds.clamp(1, 86_400) * 1000)
        .unwrap_or(DEFAULT_TTL_MS);

    let conn = Connection::open(&db_path)?;
    init_db(&conn)?;
    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        token,
        lease_ttl_ms,
    };
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("kanban-hub listening on http://{addr} (db: {db_path})");
    axum::serve(listener, app(state)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use axum::http::{Request, header};
    use tower::ServiceExt;

    fn state() -> AppState {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        AppState {
            db: Arc::new(Mutex::new(conn)),
            token: "test-token".to_string(),
            lease_ttl_ms: 60_000,
        }
    }

    fn request(method: &str, uri: &str, body: Value) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, "Bearer test-token")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    async fn json(response: Response) -> Value {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn send(app: Router, request: Request<Body>) -> (StatusCode, Value) {
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        (status, json(response).await)
    }

    #[tokio::test]
    async fn healthz_needs_no_auth() {
        let response = app(state())
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn auth_is_required() {
        let response = app(state())
            .oneshot(
                Request::builder()
                    .uri("/v1/projects/demo/cards")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn lease_claim_release_and_cas() {
        let app = app(state());
        let uri = "/v1/projects/demo/cards/001";

        let (status, created) = send(
            app.clone(),
            request(
                "PUT",
                uri,
                json!({"instance":"a","user":"alice","base_rev":0,"payload":{"status":"todo"}}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(created["rev"], 1);
        assert_eq!(created["lease"]["instance"], "a");

        let (status, updated) = send(
            app.clone(),
            request(
                "PUT",
                uri,
                json!({"instance":"a","user":"alice","base_rev":1,"payload":{"status":"in-progress"}}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(updated["rev"], 2);

        let (status, _) = send(
            app.clone(),
            request(
                "POST",
                "/v1/projects/demo/cards/001/claim",
                json!({"instance":"b","user":"bob"}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);

        let (status, _) = send(
            app.clone(),
            request(
                "POST",
                "/v1/projects/demo/cards/001/release",
                json!({"instance":"a"}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let (status, claimed) = send(
            app.clone(),
            request(
                "POST",
                "/v1/projects/demo/cards/001/claim",
                json!({"instance":"b","user":"bob"}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(claimed["lease"]["instance"], "b");

        let (status, _) = send(
            app.clone(),
            request(
                "PUT",
                uri,
                json!({"instance":"b","user":"bob","base_rev":1,"payload":{"status":"ready"}}),
            ),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::CONFLICT,
            "stale base_rev must be rejected"
        );

        let (status, handed) = send(
            app.clone(),
            request(
                "POST",
                "/v1/projects/demo/cards/001/handoff",
                json!({"instance":"b","assignee":"carol"}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(handed["assignee"], "carol");
        assert!(handed["lease"].is_null());
    }

    #[tokio::test]
    async fn expired_lease_can_be_claimed() {
        let app = app(state());
        let uri = "/v1/projects/demo/cards/002";
        let (status, _) = send(
            app.clone(),
            request(
                "PUT",
                uri,
                json!({"instance":"a","user":"alice","base_rev":0,"payload":{"status":"todo"}}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let (status, _) = send(
            app.clone(),
            request(
                "POST",
                "/v1/projects/demo/cards/002/release",
                json!({"instance":"a"}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let (status, claimed) = send(
            app.clone(),
            request(
                "POST",
                "/v1/projects/demo/cards/002/claim",
                json!({"instance":"b","user":"bob","ttl_seconds":1}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(claimed["lease"]["instance"], "b");

        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        let (status, claimed) = send(
            app.clone(),
            request(
                "POST",
                "/v1/projects/demo/cards/002/claim",
                json!({"instance":"a","user":"alice"}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(claimed["lease"]["instance"], "a");
    }

    #[tokio::test]
    async fn list_returns_cards_since() {
        let app = app(state());
        let (status, _) = send(
            app.clone(),
            request(
                "PUT",
                "/v1/projects/demo/cards/003",
                json!({"instance":"a","user":"alice","base_rev":0,"payload":{"status":"todo"}}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, cards) = send(
            app.clone(),
            Request::builder()
                .uri("/v1/projects/demo/cards?since=0")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(cards["cards"].as_array().unwrap().len(), 1);
        assert_eq!(cards["cards"][0]["id"], "003");
    }
}
