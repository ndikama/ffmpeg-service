FROM node:20-bullseye-slim

# Installer FFmpeg + polices
RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-dejavu-core \
    fonts-dejavu-extra \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY server.js ./

# Dossier temp
RUN mkdir -p /tmp/wf10

EXPOSE 3000

CMD ["node", "server.js"]
