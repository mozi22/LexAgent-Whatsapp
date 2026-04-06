# WhatsApp Lex

A self-hosted WhatsApp bot that connects your personal WhatsApp account to [Lexoffice](https://www.lexoffice.de/) via a guided web setup wizard. Send natural-language messages on WhatsApp and get live data from your Lexoffice account back as replies.

---

## What it does

- **Setup wizard** — a web page walks you through linking your WhatsApp account by scanning a QR code. No technical knowledge required.
- **Natural language understanding** — incoming WhatsApp messages are interpreted by Claude AI (Haiku), so you can ask things like *"bring me all the contacts saved in lexoffice"* instead of typing fixed commands.
- **Lexoffice integration** — the bot calls the Lexoffice REST API on your behalf and returns the results as a formatted WhatsApp message.
- **Auto-reply loop protection** — bot replies are tracked by message ID so they are never re-processed, preventing infinite loops.

### Currently supported queries

| What you can ask | Example messages |
|---|---|
| List all Lexoffice contacts | "show me all contacts", "bring me the contact list", "Kunden anzeigen" |

More query types (invoices, vouchers, etc.) can be added by extending `lib/lexoffice.js`.

---

## Architecture

```
Browser (setup wizard)
    │  WebSocket
    ▼
server.js  (Express + ws)
    │
    ├── Baileys  ──────────────────────► WhatsApp
    │     QR auth, send/receive messages
    │
    ├── lib/lexoffice.js
    │     detectIntent()  ─────────────► Anthropic API (Claude Haiku)
    │     getContacts()   ─────────────► Lexoffice REST API
    │
    └── public/index.html  (served statically)
```

**Key files:**

| File | Purpose |
|---|---|
| `server.js` | Express server, WebSocket hub, Baileys WhatsApp connection, message routing |
| `lib/lexoffice.js` | Lexoffice API client, contact fetching, Claude-powered intent detection |
| `public/index.html` | Step-by-step setup wizard UI |
| `.env.example` | Template for required environment variables |

---

## Prerequisites

- **Node.js >= 20** — Baileys requires it. Use [nvm](https://github.com/nvm-sh/nvm) if needed: `nvm use 20`
- **A WhatsApp account** — the bot runs as a linked device on your personal number
- **Lexoffice account** with API access — [generate a key here](https://app.lexoffice.de/addons/public-api)
- **Anthropic API key** — [get one here](https://console.anthropic.com/)

---

## Setup

### 1. Clone and install

```bash
git clone <repo-url>
cd whatsapp_lex
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in both keys:

```env
LEXOFFICE_API_KEY=your_lexoffice_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
```

> `.env` is gitignored and will never be committed.

### 3. Start the server

```bash
node server.js
```

You should see:

```
🚀 WhatsApp Lex server running at http://localhost:3000
```

### 4. Connect WhatsApp

1. Open **http://localhost:3000** in your browser.
2. Click **"Setup my WhatsApp agent"**.
3. Enter your WhatsApp phone number (international format, e.g. `+49 176 12345678`).
4. A QR code will appear — scan it with WhatsApp on your phone:
   - Open WhatsApp → tap ⋮ Menu → **Linked Devices** → **Link a Device**
5. Once connected, you'll receive a confirmation message on your WhatsApp.

### 5. Test it

Send any of these to your own WhatsApp number (or have someone message you):

```
show me all contacts
bring me the contact list from lexoffice
list all my clients
```

---

## Keeping the server running

For always-on operation, run the server as a background process using a process manager:

```bash
# With pm2
npm install -g pm2
pm2 start server.js --name whatsapp-lex
pm2 save
```

Or use any other method you prefer (`screen`, `systemd`, etc.).

---

## Adding new Lexoffice queries

All Lexoffice logic lives in `lib/lexoffice.js`. To add a new query type:

1. **Add an API function** — follow the pattern of `getContacts()`.
2. **Add a format function** — follow the pattern of `formatContactsMessage()`.
3. **Add a new intent label** to the `INTENT_SYSTEM_PROMPT` constant.
4. **Handle the new intent** in `processMessage()` inside `server.js`.

---

## Security notes

- This bot runs as a **linked device** on your WhatsApp account. All messages you send and receive are visible to it.
- Your Lexoffice and Anthropic API keys are stored only in `.env` on your server — never committed to version control.
- WhatsApp session files are stored locally in `sessions/` (also gitignored). Delete this folder to force a re-authentication.
- Using Baileys involves connecting to WhatsApp via a reverse-engineered protocol. Review [WhatsApp's Terms of Service](https://www.whatsapp.com/legal/terms-of-service) before using this in a commercial context.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `npm install` fails with "requires Node.js 20+" | Run `nvm use 20` first |
| QR code not appearing | Refresh the page and click setup again; QR codes expire after ~20s |
| Bot connects but never replies | Check the server terminal — look for `[intent]` log lines to confirm messages are reaching the handler |
| `Bad MAC` / decrypt errors in terminal | Delete the `sessions/` folder and re-scan the QR code |
| "Lexoffice API key not configured" reply | Make sure `.env` exists with a valid `LEXOFFICE_API_KEY` |
| 401 from Lexoffice | Your API key is invalid or expired — regenerate it in Lexoffice settings |
| Intent not recognised | The Claude classifier returned `unknown` — try rephrasing; check `ANTHROPIC_API_KEY` is set |

---

## License

MIT
