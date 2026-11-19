# Family instance: the Virtue hash server (hash-server/) as a container for Dokploy.
# Build context is a release directory holding this file, compose.yaml and hash-server/.
FROM rust:1-bookworm@sha256:ade39a710ef85f3506cffcfec3e8a24ba090badef1dff2fb798f71d878833fea AS build
WORKDIR /src
COPY hash-server/ ./
RUN cargo build --release --locked

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin virtue \
  && mkdir -p /data && chown virtue:virtue /data
COPY --from=build /src/target/release/hash-server /usr/local/bin/hash-server
USER virtue
ENV HOST=0.0.0.0 PORT=8788 DATABASE_PATH=/data/hash-server.sqlite
VOLUME /data
EXPOSE 8788
# HASH-009: GET / answers {"status":"ok"} without auth.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8788/ | grep -q '"status":"ok"' || exit 1
CMD ["hash-server"]
