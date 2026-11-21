# 应用镜像同时负责两件事：next start 提供页面和接口，npm run index-knowledge 灌库。
# 所以这里保留完整源码和 devDependencies 里的 tsx，不用 standalone 裁剪后的 server.js。

FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-noto-cjk ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

ENV NODE_ENV=production
ENV PDF_FONT_PATH=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc
ENV PDF_FONT_FAMILY=NotoSansCJK-Regular

EXPOSE 3000

CMD ["npm", "start", "--", "-H", "0.0.0.0", "-p", "3000"]
