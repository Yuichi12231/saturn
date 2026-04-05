FROM node:20-alpine

WORKDIR /app

COPY ai-agent/package*.json ./
RUN npm install

COPY ai-agent/ ./

EXPOSE 3001

CMD ["npm", "start"]