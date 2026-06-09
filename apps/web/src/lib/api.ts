import axios from 'axios';
import type { ApiResponse } from '@saas/types';
import { TOKEN_KEYS } from '@saas/config';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export const apiClient = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

apiClient.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem(TOKEN_KEYS.ACCESS);
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

// Do NOT auto-redirect on 401 here — let the caller handle it
apiClient.interceptors.response.use(
  (response) => response,
  (error) => Promise.reject(error),
);

export async function apiRequest<T>(
  method: 'get' | 'post' | 'put' | 'delete' | 'patch',
  url: string,
  data?: unknown,
): Promise<T> {
  try {
    const response = await apiClient.request<ApiResponse<T>>({ method, url, data });
    if (!response.data.success || response.data.data === undefined) {
      throw new Error(response.data.error?.message ?? 'Request failed');
    }
    return response.data.data;
  } catch (err) {
    // Extract the server's error message from axios error responses
    if (axios.isAxiosError(err) && err.response?.data) {
      const serverMsg = (err.response.data as ApiResponse).error?.message;
      if (serverMsg) throw new Error(serverMsg);
    }
    throw err;
  }
}
