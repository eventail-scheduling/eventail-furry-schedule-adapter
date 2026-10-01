FROM node:26-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Node 25+ images no longer bundle corepack.
RUN npm install -g corepack && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml /app/
WORKDIR /app

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store CI=true pnpm install --prod --frozen-lockfile

FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store CI=true pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

FROM base
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=build /app/dist /app
# An empty named volume takes its ownership from the directory it is mounted
# over, so that directory has to exist and belong to the runtime user first.
# Without this a fresh volume mounts root-owned and the cache probe fails.
RUN mkdir -p /var/cache/adapter && chown 1000:1000 /var/cache/adapter
ENV NODE_ENV="production"
USER 1000:1000

ENTRYPOINT [ "node", "--enable-source-maps", "--import=./register-crash-logger.js" ]
CMD [ "./index.js" ]
