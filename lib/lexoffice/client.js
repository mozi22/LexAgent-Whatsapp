const axios = require('axios');

const BASE_URL = 'https://api.lexoffice.io/v1';

/**
 * Create an authenticated Axios instance for the Lexoffice API.
 * @param {string} apiKey
 */
function createClient(apiKey) {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });
}

module.exports = { createClient };
