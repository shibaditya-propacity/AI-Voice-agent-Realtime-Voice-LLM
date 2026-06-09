function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const Env = {
  port: parseInt(optionalEnv('DASHBOARD_API_PORT', '3001')),
  nodeEnv: optionalEnv('NODE_ENV', 'development'),
  jwt: {
    secret: optionalEnv('JWT_SECRET', 'dev-secret-change-in-prod'),
    expiresIn: optionalEnv('JWT_EXPIRES_IN', '15m'),
    refreshExpiresIn: optionalEnv('JWT_REFRESH_EXPIRES_IN', '7d'),
  },
  cors: {
    origin: optionalEnv('CORS_ORIGIN', 'http://localhost:3000'),
  },
  voiceServer: {
    url: optionalEnv('VOICE_SERVER_URL', 'http://localhost:8080'),
    internalSecret: optionalEnv('INTERNAL_API_SECRET', ''),
  },
} as const;
