import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  transpilePackages: ['@saas/ui', '@saas/shared', '@saas/types', '@saas/config'],
  outputFileTracingRoot: path.join(__dirname, '../../'),
};

export default nextConfig;
