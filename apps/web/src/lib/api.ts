import axios from 'axios';
import type { ApiResponse } from '@saas/types';
import { TOKEN_KEYS, API_ROUTES } from '@saas/config';

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

let refreshing: Promise<string> | null = null;

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    if (error.response?.status !== 401 || original._retry) {
      return Promise.reject(error);
    }
    original._retry = true;

    try {
      if (!refreshing) {
        refreshing = (async () => {
          const refreshToken = localStorage.getItem(TOKEN_KEYS.REFRESH);
          if (!refreshToken) throw new Error('No refresh token');

          const res = await axios.post<ApiResponse<{ accessToken: string; refreshToken: string }>>(
            `${API_URL}${API_ROUTES.AUTH.REFRESH}`,
            { refreshToken },
          );
          if (!res.data.success || !res.data.data) throw new Error('Refresh failed');

          const { accessToken, refreshToken: newRefresh } = res.data.data;
          localStorage.setItem(TOKEN_KEYS.ACCESS, accessToken);
          if (newRefresh) localStorage.setItem(TOKEN_KEYS.REFRESH, newRefresh);
          document.cookie = `${TOKEN_KEYS.ACCESS}=${accessToken}; path=/; max-age=604800; SameSite=Lax`;
          return accessToken;
        })().finally(() => { refreshing = null; });
      }

      const newToken = await refreshing;
      original.headers.Authorization = `Bearer ${newToken}`;
      return apiClient(original);
    } catch {
      // Refresh failed — clear session and redirect to login
      localStorage.removeItem(TOKEN_KEYS.ACCESS);
      localStorage.removeItem(TOKEN_KEYS.REFRESH);
      document.cookie = `${TOKEN_KEYS.ACCESS}=; path=/; max-age=0; SameSite=Lax`;
      window.location.href = '/login';
      return Promise.reject(error);
    }
  },
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
    if (axios.isAxiosError(err) && err.response?.data) {
      const serverMsg = (err.response.data as ApiResponse).error?.message;
      if (serverMsg) throw new Error(serverMsg);
    }
    throw err;
  }
}
