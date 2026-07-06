# Single image for Unraid: Express serves the built client and Socket.io
# signaling from one process on one port. Put HTTPS in front of it
# (Pangolin) — getUserMedia requires a secure origin off-localhost.

FROM node:20-alpine AS client-build
WORKDIR /build/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:20-alpine AS server-build
WORKDIR /build/server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=server-build /build/server/dist server/dist
COPY --from=server-build /build/server/node_modules server/node_modules
COPY --from=server-build /build/server/package.json server/package.json
# The server looks for the client build at ../../client/dist relative to
# server/dist/index.js — keep this layout in sync with server/src/index.ts.
COPY --from=client-build /build/client/dist client/dist
EXPOSE 3001
USER node
CMD ["node", "server/dist/index.js"]
