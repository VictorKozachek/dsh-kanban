FROM rust:1.98-slim AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/kanban-hub /usr/local/bin/kanban-hub
ENV KANBAN_HUB_ADDR=0.0.0.0:8787 \
    KANBAN_HUB_DB=/data/hub.sqlite
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD curl -fsS http://127.0.0.1:8787/readyz || exit 1
ENTRYPOINT ["kanban-hub"]
