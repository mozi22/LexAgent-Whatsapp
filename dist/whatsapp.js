"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startWhatsAppSetup = startWhatsAppSetup;
exports.disconnectSession = disconnectSession;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const ws_1 = __importDefault(require("ws"));
const qrcode_1 = __importDefault(require("qrcode"));
const pino_1 = __importDefault(require("pino"));
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const boom_1 = require("@hapi/boom");
const index_1 = require("./lexoffice/index");
// ── Session registry ──────────────────────────────────────────────────────────
/** One entry per connected browser tab. */
const sessions = new Map();
// ── WebSocket helpers ─────────────────────────────────────────────────────────
/** Send a typed message to the browser, dropping it silently if the socket is closed. */
function send(ws, message) {
    if (ws.readyState === ws_1.default.OPEN) {
        ws.send(JSON.stringify(message));
    }
}
// ── Public API ────────────────────────────────────────────────────────────────
/** Begin (or restart) the WhatsApp setup flow for the given phone number. */
async function startWhatsAppSetup(ws, phoneNumber) {
    const cleanNumber = phoneNumber.replace(/\D/g, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;
    const authDir = path_1.default.join(__dirname, '..', 'sessions', cleanNumber);
    fs_1.default.mkdirSync(authDir, { recursive: true });
    send(ws, { type: 'status', step: 'connecting', message: 'Initialising WhatsApp connection...' });
    try {
        const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)(authDir);
        const { version } = await (0, baileys_1.fetchLatestBaileysVersion)();
        const sock = (0, baileys_1.default)({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: (0, pino_1.default)({ level: 'silent' }),
            // Required: lets Baileys retry decryption of any message it missed
            getMessage: async () => ({ conversation: '' }),
        });
        sessions.set(ws, { sock, jid });
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                try {
                    const qrDataUrl = await qrcode_1.default.toDataURL(qr, { width: 300, margin: 2 });
                    send(ws, { type: 'qr', qrDataUrl });
                    send(ws, { type: 'status', step: 'qr', message: 'Scan the QR code with your WhatsApp app.' });
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    send(ws, { type: 'error', message: `Failed to generate QR code: ${message}` });
                }
            }
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error instanceof boom_1.Boom
                    ? lastDisconnect.error.output.statusCode
                    : null;
                const shouldReconnect = statusCode !== baileys_1.DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    send(ws, { type: 'status', step: 'reconnecting', message: 'Connection dropped, reconnecting...' });
                    await startWhatsAppSetup(ws, phoneNumber);
                }
                else {
                    send(ws, { type: 'status', step: 'logged_out', message: 'Logged out. Please restart setup.' });
                    sessions.delete(ws);
                }
            }
            if (connection === 'open') {
                send(ws, { type: 'status', step: 'connected', message: 'Connected! Sending confirmation message...' });
                try {
                    await sock.sendMessage(jid, {
                        text: '🎉 Your WhatsApp integration is working successfully! Your agent is now live and ready to receive messages.',
                    });
                    send(ws, { type: 'confirmed', message: 'Confirmation message sent! Check your WhatsApp.' });
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    send(ws, { type: 'error', message: `Connected but failed to send confirmation: ${message}` });
                }
                setupMessageHandler(ws, sock, jid);
            }
        });
        sock.ev.on('creds.update', saveCreds);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(ws, { type: 'error', message: `Setup failed: ${message}` });
    }
}
/** Tear down the session associated with a browser WebSocket. */
function disconnectSession(ws) {
    const session = sessions.get(ws);
    if (session) {
        try {
            session.sock.end(undefined);
        }
        catch {
            // already closed — ignore
        }
        sessions.delete(ws);
    }
}
// ── Message handling ──────────────────────────────────────────────────────────
function setupMessageHandler(ws, sock, jid) {
    // Track IDs of messages the bot sent so we never reply to ourselves.
    const botSentIds = new Set();
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log('[messages.upsert] type:', type, '| count:', messages.length);
        // Only handle live incoming messages — skip history sync.
        if (type !== 'notify')
            return;
        const msg = messages[0];
        if (!msg || !msg.message) {
            console.log('[skip] no msg or no msg.message');
            return;
        }
        const from = msg.key.remoteJid;
        console.log('[msg] fromMe:', msg.key.fromMe, '| remoteJid:', from, '| messageType:', Object.keys(msg.message)[0]);
        // ── STRICT GUARDRAIL: only respond in the personal self-chat ─────────────
        // Self-chat JID is always <digits>@s.whatsapp.net.
        // Reject groups (@g.us), broadcasts, channels, and all other contacts.
        if (from !== jid) {
            console.log('[skip] not self-chat — jid:', from, '(allowed:', jid + ')');
            return;
        }
        const msgId = msg.key.id;
        // Skip bot replies to prevent reply loops.
        if (msgId && botSentIds.has(msgId)) {
            botSentIds.delete(msgId);
            console.log('[skip] bot reply, ignoring to avoid loop');
            return;
        }
        const text = msg.message.conversation ??
            msg.message.extendedTextMessage?.text ??
            msg.message.imageMessage?.caption ??
            '';
        console.log('[msg] text extracted:', JSON.stringify(text));
        if (!text) {
            console.log('[skip] empty text');
            return;
        }
        // Sends an intermediate progress update and registers its ID so the
        // bot-loop guard does not re-process it.
        const sendProgress = async (progressText) => {
            try {
                const sent = await sock.sendMessage(from, { text: progressText });
                if (sent?.key?.id)
                    botSentIds.add(sent.key.id);
            }
            catch (e) {
                console.error('[progress send error]', e instanceof Error ? e.message : e);
            }
        };
        let reply;
        try {
            reply = await processMessage(text, from, sendProgress);
        }
        catch (err) {
            console.error('[processMessage error]', err instanceof Error ? err.message : err);
            reply = '⚠️ An unexpected error occurred. Please try again.';
        }
        try {
            const sent = await sock.sendMessage(from, { text: reply });
            if (sent?.key?.id)
                botSentIds.add(sent.key.id);
            send(ws, { type: 'message_received', from, text, reply });
            console.log('[reply sent] to:', from);
        }
        catch (err) {
            console.error('[send error]', err instanceof Error ? err.message : err);
        }
    });
}
/**
 * Route an incoming message to the Lexoffice module first.
 * Falls back to simple keyword replies when the message is not a Lexoffice query.
 */
async function processMessage(text, from, sendProgress) {
    const lexReply = await (0, index_1.handleMessage)(text, from, sendProgress);
    if (lexReply !== null)
        return lexReply;
    // ── Keyword fallbacks ─────────────────────────────────────────────────────
    const lower = text.toLowerCase().trim();
    if (/^(hi|hello|hey|howdy|hola)\b/.test(lower)) {
        return "👋 Hello! I'm your WhatsApp agent connected to Lexoffice.\n\nType *help* to see what I can do.";
    }
    if (/\bhelp\b/.test(lower)) {
        return ('📋 *What I can do:*\n\n' +
            '*Contacts*\n' +
            '• _"Give me details of Müller GmbH"_\n' +
            '• _"Is Campai in my contacts?"_\n' +
            '• _"Add a new contact"_\n\n' +
            '*Invoices*\n' +
            '• _"Which invoices are currently open?"_\n' +
            '• _"Show open invoices of Campai"_\n' +
            '• _"Create an invoice"_\n\n' +
            'Type *cancel* at any time to stop a multi-step operation.');
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
    return "I didn't understand that. Type *help* to see what I can do.";
}
