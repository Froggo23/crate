import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  // This project sits inside a home directory that contains other lockfiles;
  // pinning the root stops Turbopack inferring the wrong workspace.
  turbopack: { root: path.resolve(process.cwd()) },
};

export default nextConfig;
