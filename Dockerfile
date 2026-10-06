FROM oven/bun:1.4.2-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
RUN addgroup -S lanesh && adduser -S lanesh -G lanesh
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=lanesh:lanesh package.json ./
COPY --chown=lanesh:lanesh src ./src
COPY --chown=lanesh:lanesh public ./public
USER lanesh
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD bun -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["bun", "src/index.ts"]
