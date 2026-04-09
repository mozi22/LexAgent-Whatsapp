import 'dotenv/config';
import http from 'http';
import path from 'path';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';

import type { ClientMessage } from './types';
import { startWhatsAppSetup, disconnectSession } from './whatsapp';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());

wss.on('connection', (ws: WebSocket) => {
  console.log('Client connected');

  ws.on('message', async (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }

    if (msg.type === 'start_setup') {
      await startWhatsAppSetup(ws, msg.phoneNumber);
    }

    if (msg.type === 'disconnect') {
      disconnectSession(ws);
    }
  });

  ws.on('close', () => {
    disconnectSession(ws);
    console.log('Client disconnected');
  });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 WhatsApp Lex server running at http://localhost:${PORT}\n`);
});
