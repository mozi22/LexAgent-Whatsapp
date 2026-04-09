import path from "path";
import fs from "fs";
import WebSocket from "ws";
import QRCode from "qrcode";
import pino from "pino";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";

import type { WhatsAppSession, ServerMessage, SendProgress } from "./types";
import { handleMessage } from "./lexoffice/index";

// ── Whitelist ─────────────────────────────────────────────────────────────────

/**
 * Only these JIDs may trigger the bot. Messages from any other sender —
 * including groups, broadcasts, and unknown contacts — are silently dropped.
 *
 * Format: country-code digits (no "+") + "@s.whatsapp.net"
 */
const ALLOWED_JIDS = new Set<string>([
  '4917630135775@s.whatsapp.net',
  '491605566060@s.whatsapp.net',
]);

// ── Per-user active state ─────────────────────────────────────────────────────

/**
 * Tracks whether the Lex agent is active for each sender JID.
 * Defaults to true (active) when a JID is not present in the map.
 * "lex up" → true, "lex down" / "lex sleep" → false.
 */
const lexActive = new Map<string, boolean>();

function isLexActive(jid: string): boolean {
  return lexActive.get(jid) !== false;
}

// ── Session registry ──────────────────────────────────────────────────────────

/** One entry per connected browser tab. */
const sessions = new Map<WebSocket, WhatsAppSession>();

// ── WebSocket helpers ─────────────────────────────────────────────────────────

/** Send a typed message to the browser, dropping it silently if the socket is closed. */
function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Begin (or restart) the WhatsApp setup flow for the given phone number. */
export async function startWhatsAppSetup(
  ws: WebSocket,
  phoneNumber: string,
): Promise<void> {
  const cleanNumber = phoneNumber.replace(/\D/g, "");
  const jid = `${cleanNumber}@s.whatsapp.net`;

  // ── Authorisation check (shown on the setup page, not in WhatsApp) ────────
  if (!ALLOWED_JIDS.has(jid)) {
    send(ws, {
      type: 'error',
      message: '⛔ You are not authorized to use this system.',
    });
    return;
  }

  const authDir = path.join(__dirname, "..", "sessions", cleanNumber);
  fs.mkdirSync(authDir, { recursive: true });

  send(ws, {
    type: "status",
    step: "connecting",
    message: "Initialising WhatsApp connection...",
  });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      // Required: lets Baileys retry decryption of any message it missed
      getMessage: async () => ({ conversation: "" }),
    });

    sessions.set(ws, { sock, jid });

    // Guard against multiple simultaneous reconnect attempts from the same socket.
    let reconnecting = false;

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, {
            width: 300,
            margin: 2,
          });
          send(ws, { type: "qr", qrDataUrl });
          send(ws, {
            type: "status",
            step: "qr",
            message: "Scan the QR code with your WhatsApp app.",
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          send(ws, {
            type: "error",
            message: `Failed to generate QR code: ${message}`,
          });
        }
      }

      if (connection === "close") {
        const statusCode =
          lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output.statusCode
            : null;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (!shouldReconnect) {
          send(ws, {
            type: "status",
            step: "logged_out",
            message: "Logged out. Please restart setup.",
          });
          sessions.delete(ws);
          return;
        }

        // Prevent cascading reconnects from the same socket instance.
        if (reconnecting) {
          console.log("[reconnect] already in progress — skipping duplicate");
          return;
        }
        reconnecting = true;

        send(ws, {
          type: "status",
          step: "reconnecting",
          message: "Connection dropped, reconnecting in 3s...",
        });
        console.log("[reconnect] scheduling for:", phoneNumber);

        // End the current socket cleanly before creating a new one.
        try { sock.end(undefined); } catch { /* already closed */ }

        await new Promise<void>((resolve) => setTimeout(resolve, 3000));
        await startWhatsAppSetup(ws, phoneNumber);
      }

      if (connection === "open") {
        send(ws, {
          type: "status",
          step: "connected",
          message: "Connected! Sending confirmation message...",
        });

        try {
          await sock.sendMessage(jid, {
            text: "🎉 Your WhatsApp integration is working successfully! Your agent is now live and ready to receive messages.",
          });
          send(ws, {
            type: "confirmed",
            message: "Confirmation message sent! Check your WhatsApp.",
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          send(ws, {
            type: "error",
            message: `Connected but failed to send confirmation: ${message}`,
          });
        }

        setupMessageHandler(ws, sock, jid);
      }
    });

    sock.ev.on("creds.update", saveCreds);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send(ws, { type: "error", message: `Setup failed: ${message}` });
  }
}

/** Tear down the session associated with a browser WebSocket. */
export function disconnectSession(ws: WebSocket): void {
  const session = sessions.get(ws);
  if (session) {
    try {
      session.sock.end(undefined);
    } catch {
      // already closed — ignore
    }
    sessions.delete(ws);
  }
}

// ── Message handling ──────────────────────────────────────────────────────────

function setupMessageHandler(
  ws: WebSocket,
  sock: ReturnType<typeof makeWASocket>,
  jid: string,
): void {
  // Track IDs of messages the bot sent so we never reply to ourselves.
  const botSentIds = new Set<string>();

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    console.log("[messages.upsert] type:", type, "| count:", messages.length);

    // Only handle live incoming messages — skip history sync.
    if (type !== "notify") return;

    const msg = messages[0];
    if (!msg || !msg.message) {
      console.log("[skip] null message — likely a decryption failure (stale session). Run: rm -rf sessions/ and re-scan QR.");
      return;
    }

    const from = msg.key.remoteJid;

    console.log(
      "[msg] fromMe:",
      msg.key.fromMe,
      "| remoteJid:",
      from,
      "| messageType:",
      Object.keys(msg.message)[0],
    );

    // ── GUARDRAIL ─────────────────────────────────────────────────────────────
    if (!from) return;

    // Groups, broadcasts, channels — drop silently.
    if (from.endsWith('@g.us') || from.endsWith('@broadcast') || from.endsWith('@newsletter')) {
      console.log("[skip] group/broadcast/channel — jid:", from);
      return;
    }

    // Messages with fromMe:true come from the account owner's own devices
    // (phone, linked devices, LID addresses). They are inherently authorised.
    // Messages from other contacts must be in the whitelist.
    const normalizedFrom = jidNormalizedUser(from);
    const isOwner = msg.key.fromMe === true;
    const isWhitelisted = ALLOWED_JIDS.has(normalizedFrom);

    if (!isOwner && !isWhitelisted) {
      console.log("[skip] not authorised — jid:", normalizedFrom);
      return;
    }


    const msgId = msg.key.id;

    // Skip bot replies to prevent reply loops.
    if (msgId && botSentIds.has(msgId)) {
      botSentIds.delete(msgId);
      console.log("[skip] bot reply, ignoring to avoid loop");
      return;
    }

    const text =
      msg.message.conversation ??
      msg.message.extendedTextMessage?.text ??
      msg.message.imageMessage?.caption ??
      "";

    console.log("[msg] text extracted:", JSON.stringify(text));

    if (!text) {
      console.log("[skip] empty text");
      return;
    }

    // Always reply to the canonical JID (@s.whatsapp.net), not `from`.
    // `from` may be a LID address or device-suffixed JID which Baileys
    // cannot route — only the plain number JID is a valid send destination.
    const replyTo = jid;

    // Sends an intermediate progress update and registers its ID so the
    // bot-loop guard does not re-process it.
    const sendProgress: SendProgress = async (progressText) => {
      try {
        const sent = await sock.sendMessage(replyTo, { text: progressText });
        if (sent?.key?.id) botSentIds.add(sent.key.id);
      } catch (e) {
        console.error(
          "[progress send error]",
          e instanceof Error ? e.message : e,
        );
      }
    };

    let reply: string | null;
    try {
      reply = await processMessage(text, jid, sendProgress);
    } catch (err) {
      console.error("[processMessage error]", err);
      reply = `⚠️ Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    // null means the agent is sleeping — send nothing
    if (reply === null) return;

    try {
      const sent = await sock.sendMessage(replyTo, { text: reply });
      if (sent?.key?.id) botSentIds.add(sent.key.id);
      send(ws, { type: "message_received", from: replyTo, text, reply });
      console.log("[reply sent] to:", replyTo);
    } catch (err) {
      console.error("[send error]", err instanceof Error ? err.message : err);
    }
  });
}

/**
 * Route an incoming message.
 * Returns a reply string, or null when the agent is sleeping (send nothing).
 */
async function processMessage(
  text: string,
  from: string,
  sendProgress: SendProgress,
): Promise<string | null> {
  const lower = text.toLowerCase().trim();

  // ── Lex on/off switch — always checked, even when sleeping ───────────────
  if (/^lex\s+up\b/i.test(lower)) {
    lexActive.set(from, true);
    console.log('[lex] active for:', from);
    return '✅ Your Lex Agent is now Active.';
  }
  if (/^lex\s+(down|sleep)\b/i.test(lower)) {
    lexActive.set(from, false);
    console.log('[lex] sleeping for:', from);
    return '💤 Your Lex Agent is now asleep.';
  }

  // ── Drop all other messages while sleeping ────────────────────────────────
  if (!isLexActive(from)) {
    console.log('[lex] agent sleeping — dropping message from:', from);
    return null;
  }

  // ── Active: route to Lexoffice module, then keyword fallbacks ────────────
  const lexReply = await handleMessage(text, from, sendProgress);
  if (lexReply !== null) return lexReply;

  // ── Keyword fallbacks ─────────────────────────────────────────────────────

  if (/^(hi|hello|hey|howdy|hola)\b/.test(lower)) {
    return "👋 Hello! I'm your WhatsApp agent connected to Lexoffice.\n\nType *help* to see what I can do.";
  }
  if (/\bhelp\b/.test(lower)) {
    return (
      "📋 *What I can do:*\n\n" +
      "*Contacts*\n" +
      '• _"Give me details of Müller GmbH"_\n' +
      '• _"Is Campai in my contacts?"_\n' +
      '• _"Add a new contact"_\n\n' +
      "*Invoices*\n" +
      '• _"Which invoices are currently open?"_\n' +
      '• _"Show open invoices of Campai"_\n' +
      '• _"Create an invoice"_\n\n' +
      "Type *cancel* at any time to stop a multi-step operation."
    );
  }
  if (/\b(about|who are you|what are you)\b/.test(lower)) {
    return "🤖 I'm an automated WhatsApp agent connected to Lexoffice. Ask me about contacts or invoices in natural language.";
  }
  if (/\b(bye|goodbye|see you|cya)\b/.test(lower)) {
    return "👋 Goodbye! Feel free to message again anytime.";
  }
  if (/\bthank(s| you)\b/.test(lower)) {
    return "😊 You're welcome! Is there anything else I can help with?";
  }

  return "I didn't understand that. Type *help* to see what I can do.";
}
