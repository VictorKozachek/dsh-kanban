FROM rust:1.98-slim AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/kanban-hub /usr/local/bin/kanban-hub
ENV KANBAN_HUB_ADDR=0.0.0.0:8787 \
    KANBAN_HUB_DB=/data/hub.sqlite
VOLUME ["/data"]
EXPOSE 8787
ENTRYPOINT ["kanban-hub"]
