FROM node:24-alpine

ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --chown=node:node server.mjs ./
USER node
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
