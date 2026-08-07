// Leser base-stien fra samme miljøvariabel som astro.config.mjs, i stedet for
// import.meta.env.BASE_URL. Sistnevnte trigger en Vite-feil ("Cannot split a
// chunk that has already been edited") i enkelte miljøer når verdien brukes
// flere steder i samme .astro-fil.
const rawBase = process.env.SITE_BASE ?? '/ringerike-fritid';
export const BASE_URL = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
