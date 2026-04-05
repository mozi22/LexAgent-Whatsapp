require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const QRCode = require('qrcode');
const fs = require('fs');
const pino = require('pino');
const lexoffice = require('./lib/lexoffice');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Track active WhatsApp sessions per WebSocket client
const sessions = new Map();

function send(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'start_setup') {
      const phoneNumber = msg.phoneNumber;
      await startWhatsAppSetup(ws, phoneNumber);
    }

    if (msg.type === 'disconnect') {
      const session = sessions.get(ws);
      if (session) {
        try { session.sock.end(); } catch {}
        sessions.delete(ws);
      }
    }
  });

  ws.on('close', () => {
    const session = sessions.get(ws);
    if (session) {
      try { session.sock.end(); } catch {}
      sessions.delete(ws);
    }
    console.log('Client disconnected');
  });
});

async function startWhatsAppSetup(ws, phoneNumber) {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
  const { Boom } = require('@hapi/boom');

  // Clean phone number: strip + and non-digits
  const cleanNumber = phoneNumber.replace(/\D/g, '');
  const jid = `${cleanNumber}@s.whatsapp.net`;

  // Use a session directory scoped to the phone number so sessions persist
  const authDir = path.join(__dirname, 'sessions', cleanNumber);
  fs.mkdirSync(authDir, { recursive: true });

  send(ws, 'status', { step: 'connecting', message: 'Initialising WhatsApp connection...' });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      // Required for Baileys to retry decryption of messages it couldn't decrypt on first receipt
      getMessage: async () => ({ conversation: '' }),
    });

    sessions.set(ws, { sock, jid });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
          send(ws, 'qr', { qrDataUrl });
          send(ws, 'status', { step: 'qr', message: 'Scan the QR code with your WhatsApp app.' });
        } catch (err) {
          send(ws, 'error', { message: 'Failed to generate QR code: ' + err.message });
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output.statusCode
          : null;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          send(ws, 'status', { step: 'reconnecting', message: 'Connection dropped, reconnecting...' });
          await startWhatsAppSetup(ws, phoneNumber);
        } else {
          send(ws, 'status', { step: 'logged_out', message: 'Logged out. Please restart setup.' });
          sessions.delete(ws);
        }
      }

      if (connection === 'open') {
        send(ws, 'status', { step: 'connected', message: 'Connected! Sending confirmation message...' });
        try {
          await sock.sendMessage(jid, {
            text: '🎉 Your WhatsApp integration is working successfully! Your agent is now live and ready to receive messages.',
          });
          send(ws, 'confirmed', {
            message: 'Confirmation message sent! Check your WhatsApp.',
          });
        } catch (err) {
          send(ws, 'error', { message: 'Connected but failed to send confirmation: ' + err.message });
        }

        // Track message IDs sent by the bot so we never process our own replies
        const botSentIds = new Set();

        // Set up auto-reply handler
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
          console.log('[messages.upsert] type:', type, '| count:', messages.length);

          // Only process newly received messages, not history sync
          if (type !== 'notify') return;

          const msg = messages[0];
          if (!msg || !msg.message) {
            console.log('[skip] no msg or no msg.message');
            return;
          }

          const from = msg.key.remoteJid;

          console.log('[msg] fromMe:', msg.key.fromMe, '| remoteJid:', from, '| messageType:', Object.keys(msg.message)[0]);

          // ── STRICT GUARDRAIL: only respond in the personal self-chat ──────────
          // Self-chat JID is always exactly <digits>@s.whatsapp.net — the user's own number.
          // Reject groups (@g.us), broadcast lists (@broadcast), LID addresses (@lid),
          // newsletter channels (@newsletter), and any other contact chat.
          const isSelfChat = from === jid;
          if (!isSelfChat) {
            console.log('[skip] not self-chat — jid:', from, '(allowed:', jid + ')');
            return;
          }

          const msgId = msg.key.id;

          // Skip messages the bot itself sent as replies to avoid loops.
          if (botSentIds.has(msgId)) {
            botSentIds.delete(msgId);
            console.log('[skip] bot reply, ignoring to avoid loop');
            return;
          }
          const text = msg.message.conversation
            || msg.message.extendedTextMessage?.text
            || msg.message.imageMessage?.caption
            || '';

          console.log('[msg] text extracted:', JSON.stringify(text));

          if (!text) {
            console.log('[skip] empty text');
            return;
          }

          // Sends an intermediate progress update and registers its ID
          // so the bot-loop guard doesn't re-process it.
          const sendProgress = async (msg) => {
            try {
              const sent = await sock.sendMessage(from, { text: msg });
              if (sent?.key?.id) botSentIds.add(sent.key.id);
            } catch (e) {
              console.error('[progress send error]', e.message);
            }
          };

          let reply;
          try {
            reply = await processMessage(text, from, sendProgress);
          } catch (err) {
            console.error('[processMessage error]', err.message);
            reply = '⚠️ An unexpected error occurred. Please try again.';
          }

          try {
            const sent = await sock.sendMessage(from, { text: reply });
            if (sent?.key?.id) botSentIds.add(sent.key.id);
            send(ws, 'message_received', { from, text, reply });
            console.log('[reply sent] to:', from);
          } catch (err) {
            console.error('[send error]', err.message);
          }
        });
      }
    });

    sock.ev.on('creds.update', saveCreds);

  } catch (err) {
    send(ws, 'error', { message: 'Setup failed: ' + err.message });
  }
}

/**
 * Process an incoming WhatsApp message.
 * Delegates to lexoffice module first; falls back to keyword replies.
 */
async function processMessage(text, from, sendProgress) {
  // Lexoffice module handles all multi-step state and intents.
  // Returns null when the message is not a lexoffice query.
  const lexReply = await lexoffice.handleMessage(text, from, sendProgress);
  if (lexReply !== null) return lexReply;

  // ── Keyword fallbacks ────────────────────────────────────────────────────
  const lower = text.toLowerCase().trim();

  if (/^(hi|hello|hey|howdy|hola)\b/.test(lower)) {
    return '👋 Hello! I\'m your WhatsApp agent connected to Lexoffice.\n\nType *help* to see what I can do.';
  }
  if (/\bhelp\b/.test(lower)) {
    return '📋 *What I can do:*\n\n*Contacts*\n• _"Give me details of Müller GmbH"_\n• _"Is Campai in my contacts?"_\n• _"Add a new contact"_\n\n*Invoices*\n• _"Which invoices are currently open?"_\n• _"Show open invoices of Campai"_\n• _"Create an invoice"_\n\nType *cancel* at any time to stop a multi-step operation.';
  }
  if (/\b(about|who are you|what are you)\b/.test(lower)) {
    return '🤖 I\'m an automated WhatsApp agent connected to Lexoffice. Ask me about contacts or invoices in natural language.';
  }
  if (/\b(bye|goodbye|see you|cya)\b/.test(lower)) {
    return '👋 Goodbye! Feel free to message again anytime.';
  }
  if (/\bthank(s| you)\b/.test(lower)) {
    return '😊 You\'re welcome! Is there anything else I can help with?';
  }

  return `I didn't understand that. Type *help* to see what I can do.`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 WhatsApp Lex server running at http://localhost:${PORT}\n`);
});
