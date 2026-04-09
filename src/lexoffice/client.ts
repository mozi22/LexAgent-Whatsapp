import axios, { type AxiosInstance } from 'axios';

const BASE_URL = 'https://api.lexoffice.io/v1';

/** Create an authenticated Axios instance for the Lexoffice REST API. */
export function createClient(apiKey: string): AxiosInstance {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });
}
