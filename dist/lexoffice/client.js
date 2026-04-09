"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createClient = createClient;
const axios_1 = __importDefault(require("axios"));
const BASE_URL = 'https://api.lexoffice.io/v1';
/** Create an authenticated Axios instance for the Lexoffice REST API. */
function createClient(apiKey) {
    return axios_1.default.create({
        baseURL: BASE_URL,
        headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
    });
}
