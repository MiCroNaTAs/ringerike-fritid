import { defineConfig } from 'astro/config';

// Deployed as a GitHub Pages project site: https://<org>.github.io/ringerike-fritid/
// Override via env if you deploy elsewhere (custom domain, Vercel, Netlify, etc.).
const site = process.env.SITE_URL ?? 'https://micronatas.github.io/ringerike-fritid';
const base = process.env.SITE_BASE ?? '/ringerike-fritid';

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
});
