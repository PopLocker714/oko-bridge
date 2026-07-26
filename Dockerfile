FROM oven/bun:1.3-alpine
WORKDIR /app

# ffmpeg — форвардинг RTSP; tini — reaper для дочерних ffmpeg; ca-certificates — доверенный
# CA-стор для верификации сертификата при rtsps-ингесте (-tls_verify 1); su-exec — сброс до bun.
RUN apk add --no-cache ffmpeg tini ca-certificates su-exec && update-ca-certificates

COPY package.json ./
COPY src ./src
COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /data

# Состояние (bridge-токен) — в volume /data. Владельца /data чинит entrypoint под root на
# КАЖДОМ старте, затем процесс роняется до непривилегированного bun — устойчиво к тому,
# созданному под root (иначе EACCES при записи state.json на non-root).
VOLUME /data
ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
CMD ["bun", "src/index.ts"]
