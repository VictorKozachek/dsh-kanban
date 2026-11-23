# kanban-hub (M0)

Общий хаб карточек для распределённой доски: один проект, SQLite, lease/claim,
CAS по `rev`. Роли и сессии остаются локальными у клиентов; через хаб ходят
только карточки.

## Запуск

```bash
cd hub
KANBAN_HUB_TOKEN=secret KANBAN_HUB_DB=./hub.sqlite cargo run
# http://127.0.0.1:8787
```

Переменные:

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `KANBAN_HUB_ADDR` | `127.0.0.1:8787` | адрес |
| `KANBAN_HUB_DB` | `hub.sqlite` | файл SQLite |
| `KANBAN_HUB_TOKEN` | `dev-token` | Bearer-токен (в проде задайте свой) |
| `KANBAN_HUB_LEASE_TTL_SECONDS` | `1800` | TTL lease (30 мин) |
| `KANBAN_HUB_BACKUP_DIR` | `backups` | каталог snapshot-бэкапов |

Docker:

```bash
docker compose up --build
```

## API

Все запросы, кроме `/healthz`, требуют `Authorization: Bearer <token>`.

```bash
curl localhost:8787/healthz

# создать карточку (base_rev=0) — создатель сразу держит lease
curl -X PUT localhost:8787/v1/projects/demo/cards/001 \
  -H 'Authorization: Bearer secret' -H 'content-type: application/json' \
  -d '{"instance":"alice-mbp","user":"alice","base_rev":0,"payload":{"status":"todo","title":"QR"}}'

# забрать lease после release/expiry
curl -X POST localhost:8787/v1/projects/demo/cards/001/claim \
  -H 'Authorization: Bearer secret' -H 'content-type: application/json' \
  -d '{"instance":"bob-mbp","user":"bob","ttl_seconds":1800}'

# обновить снимок (только держатель lease, base_rev = текущий rev)
curl -X PUT localhost:8787/v1/projects/demo/cards/001 \
  -H 'Authorization: Bearer secret' -H 'content-type: application/json' \
  -d '{"instance":"bob-mbp","user":"bob","base_rev":1,"payload":{"status":"in-progress"}}'

# отпустить lease / передать другому
curl -X POST localhost:8787/v1/projects/demo/cards/001/release \
  -H 'Authorization: Bearer secret' -H 'content-type: application/json' \
  -d '{"instance":"bob-mbp"}'
curl -X POST localhost:8787/v1/projects/demo/cards/001/handoff \
  -H 'Authorization: Bearer secret' -H 'content-type: application/json' \
  -d '{"instance":"bob-mbp","assignee":"carol"}'

# snapshot базы (SQLite VACUUM INTO)
curl -X POST localhost:8787/admin/backup -H 'Authorization: Bearer secret'

# всё, что изменилось после updated_at
curl 'localhost:8787/v1/projects/demo/cards?since=0' -H 'Authorization: Bearer secret'
```

- `claim` — 409, если lease жив у другого инстанса;
- `upsert` — 409 при устаревшем `base_rev` или чужом lease; клиент перечитывает карточку;
- `release`/`handoff` — только держатель lease;
- истёкший lease можно забрать (TTL, `KANBAN_HUB_LEASE_TTL_SECONDS`).

## Тесты

```bash
cd hub && cargo test
```

5 тестов: auth/health, create/update/claim/release/handoff, CAS-конфликт,
истечение lease, список `since`.

## Что дальше

M1 — клиент синка в плагине (outbox, курсор, remote-карточки read-only).
M2 — UI «Взять», handoff, `conflicted`. M3 — Postgres/HA и Docker-деплой.
