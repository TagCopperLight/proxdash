FROM oven/bun:1.4.4
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src src
COPY public public
ENV PROXDASH_HOST=0.0.0.0
EXPOSE 8318
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["bun", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.PROXDASH_PORT ?? 8318}/`); process.exit(r.ok ? 0 : 1)"]
CMD ["bun", "run", "src/server.ts"]
