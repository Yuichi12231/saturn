FROM node:20-alpine

WORKDIR /app

# Build frontend
COPY app/package*.json ./app/
RUN cd app && npm install && npm run build

# Setup backend
COPY ai-agent/package*.json ./ai-agent/
RUN cd ai-agent && npm install

COPY ai-agent/ ./ai-agent/

# Copy built frontend to backend's public folder for serving
RUN mkdir -p ./ai-agent/public && cp -r ./app/dist/* ./ai-agent/public/

EXPOSE 3001

WORKDIR /app/ai-agent
CMD ["npm", "start"]