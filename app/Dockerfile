FROM node:20-alpine AS deps
WORKDIR /repo
RUN corepack enable

# Monorepo manifests (needed for workspace:* resolution)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY sdk/package.json sdk/tsconfig.json ./sdk/
COPY app/package.json ./app/

RUN pnpm install --frozen-lockfile

FROM node:20-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/package.json ./package.json
COPY --from=deps /repo/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=deps /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=deps /repo/sdk ./sdk
COPY --from=deps /repo/app ./app

# Source
COPY sdk ./sdk
COPY app ./app

RUN pnpm --filter sdk build
RUN pnpm --filter app build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable

COPY --from=build /repo/app/.next ./.next
COPY --from=build /repo/app/public ./public
COPY --from=build /repo/app/package.json ./package.json
COPY --from=build /repo/app/next.config.* ./ 2>/dev/null || true
COPY --from=build /repo/node_modules /repo/node_modules

ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

CMD ["pnpm", "--dir", "/repo/app", "start"]

