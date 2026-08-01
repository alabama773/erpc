# Unified gateway ("receptionist") - pure Node, no dependencies.
FROM node:20-alpine
WORKDIR /app
COPY proxy.mjs ./
EXPOSE 8080
CMD ["node", "proxy.mjs"]
