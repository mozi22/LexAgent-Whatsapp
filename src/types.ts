import type { WASocket } from '@whiskeysockets/baileys';

// ── WebSocket protocol ────────────────────────────────────────────────────────

/** Messages the browser sends to the server. */
export type ClientMessage =
  | { type: 'start_setup'; phoneNumber: string }
  | { type: 'disconnect' };

/** Steps of the WhatsApp connection lifecycle sent to the browser. */
export type ConnectionStep =
  | 'connecting'
  | 'qr'
  | 'reconnecting'
  | 'connected'
  | 'logged_out';

/** Messages the server sends to the browser. */
export type ServerMessage =
  | { type: 'qr'; qrDataUrl: string }
  | { type: 'status'; step: ConnectionStep; message: string }
  | { type: 'confirmed'; message: string }
  | { type: 'message_received'; from: string; text: string; reply: string }
  | { type: 'error'; message: string };

// ── Server-side state ─────────────────────────────────────────────────────────

/** Active WhatsApp session bound to a browser WebSocket connection. */
export interface WhatsAppSession {
  sock: WASocket;
  jid: string;
}

/** Function the message handler calls to send intermediate progress updates. */
export type SendProgress = (message: string) => Promise<void>;
