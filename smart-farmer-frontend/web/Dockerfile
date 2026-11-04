FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
COPY scripts/validate-container-api.mjs ./scripts/validate-container-api.mjs
ARG VITE_API_URL
ARG APP_REVISION=unversioned
RUN node scripts/validate-container-api.mjs && npm run build && \
    node -e 'const fs = require("node:fs"); const revision = process.env.APP_REVISION; if (revision !== "unversioned" && !/^[a-f0-9]{40}$/.test(revision)) throw new Error("APP_REVISION must be a full Git commit"); fs.writeFileSync("dist/release.json", JSON.stringify({revision}) + "\n")'

FROM nginx/nginx-unprivileged:1.30.6-alpine3.24@sha256:44e74ca483234093081138b6d7b6f561d55557756a2deefc3a5056148defeb99
ARG APP_REVISION=unversioned
LABEL org.opencontainers.image.revision=$APP_REVISION
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
USER 101:101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
# The image entrypoint rewrites configuration; this static service needs no writes there.
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
