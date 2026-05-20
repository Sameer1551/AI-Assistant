# Multi-stage Dockerfile for May Platform Services
# Satisfies Requirement 15.1, 15.2

FROM node:20-alpine AS base
WORKDIR /app
RUN npm install -g npm@latest

# Install dependencies and turbo
FROM base AS pruner
RUN npm install -g turbo
COPY . .
RUN turbo prune --scope=@may/* --docker

FROM base AS dev-deps
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/package-lock.json ./package-lock.json
RUN npm ci

FROM base AS builder
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/package-lock.json ./package-lock.json
COPY --from=dev-deps /app/node_modules ./node_modules
COPY --from=pruner /app/out/full/ .
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/services ./services
COPY --from=builder /app/packages ./packages

EXPOSE 50051
CMD ["node", "services/identity/dist/index.js"]
