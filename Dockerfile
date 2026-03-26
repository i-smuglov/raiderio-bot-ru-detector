FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY src ./src
# Railway sets PORT; default matches local .env.example
EXPOSE 8080
CMD ["node", "src/index.js"]
