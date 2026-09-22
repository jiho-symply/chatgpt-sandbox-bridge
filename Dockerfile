FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       bash ca-certificates curl git python3 python3-pip build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @openai/codex@latest

WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install

COPY src ./src
RUN npm run build

RUN useradd --create-home --uid 10001 sandbox \
    && mkdir -p /workspace \
    && chown -R sandbox:sandbox /workspace /app

USER sandbox
ENV CSB_HOST=0.0.0.0
ENV CSB_PORT=8787
ENV CSB_WORKSPACE_ROOT=/workspace
ENV CSB_SANDBOX_MODE=externalSandbox
ENV CSB_NETWORK=false

EXPOSE 8787
VOLUME ["/workspace"]

CMD ["node", "dist/cli.js"]
