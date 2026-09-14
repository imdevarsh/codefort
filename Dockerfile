# Pinned base (same Bun 1.x as happyjudge). Update intentionally.
FROM oven/bun:1@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- Production runtime ----
FROM oven/bun:1-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS runner

# Runtime deps for the language packs: bubblewrap (sandbox), bash, python3,
# g++ (cpp-gcc). NOTE: setup.bash's Landrun download/build is intentionally
# NOT run here — the executor uses bubblewrap (see src/execute.ts), so the Go
# toolchain and Landrun sources would only bloat the image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap bash python3 g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json bun.lock ./
# Production dependencies only (no prettier/@types at runtime).
RUN bun install --production --frozen-lockfile && rm -rf /root/.bun/install/cache /tmp/*

COPY src ./src
COPY languages ./languages

# Drop root: the server runs as nobody, and every job gets a private user
# namespace mapping that uid to jail-nobody. Unprivileged user namespaces
# are sufficient for the whole sandbox (verified), so the container needs no
# capabilities at all — see docker-compose.yml (cap_drop: ALL).
# Keep application files root-owned and non-writable by the API user. Jobs use
# their dedicated /tmp directories instead of writing under /app.
RUN chmod -R a=rX /app
USER 65534:65534
ENV HOME=/tmp

EXPOSE 3000

CMD ["bun", "src/index.ts"]
