FROM node:22-bookworm-slim AS client-build
WORKDIR /app
COPY client/package*.json ./client/
RUN npm ci --prefix client --include=dev
COPY client ./client
# Same-origin by default when this container serves both API and dashboard.
ARG VITE_API_URL=
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build --prefix client

# Debian/glibc is required by the Matrix SDK native encryption binding.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
COPY server/package*.json ./server/
RUN npm ci --prefix server --omit=dev
COPY package.json ./
COPY server ./server
COPY --from=client-build /app/client/dist ./client/dist
RUN mkdir -p server/data && chown -R node:node server/data
USER node
ENV PORT=5001
EXPOSE 5001
HEALTHCHECK --interval=30s --start-period=30s --timeout=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
