"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const express_1 = __importDefault(require("express"));
const ws_1 = require("ws");
const whatsapp_1 = require("./whatsapp");
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ server });
app.use(express_1.default.static(path_1.default.join(__dirname, '..', 'public')));
app.use(express_1.default.json());
wss.on('connection', (ws) => {
    console.log('Client connected');
    ws.on('message', async (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        }
        catch {
            return;
        }
        if (msg.type === 'start_setup') {
            await (0, whatsapp_1.startWhatsAppSetup)(ws, msg.phoneNumber);
        }
        if (msg.type === 'disconnect') {
            (0, whatsapp_1.disconnectSession)(ws);
        }
    });
    ws.on('close', () => {
        (0, whatsapp_1.disconnectSession)(ws);
        console.log('Client disconnected');
    });
});
const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
    console.log(`\n🚀 WhatsApp Lex server running at http://localhost:${PORT}\n`);
});
