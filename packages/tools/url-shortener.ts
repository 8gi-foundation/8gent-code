/**
 * URL Shortener - stores mappings in ~/.8gent/urls.json with base62-encoded IDs.
 * Can serve redirects via Bun.serve.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// --- Base62 encoding ---

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function toBase62(n: number): string {
  if (n === 0) return BASE62[0];
  let result = '';
  while (n > 0) {
    result = BASE62[n % 62] + result;
    n = Math.floor(n / 62);
  }
  return result;
}

// --- Storage ---

interface UrlMapping {
  id: string;
  url: string;
  createdAt: string;
  hits: number;
}

interface UrlStore {
  counter: number;
  mappings: Record<string, UrlMapping>;
}

const STORE_DIR = join(homedir(), '.8gent');
const STORE_PATH = join(STORE_DIR, 'urls.json');

function loadStore(): UrlStore {
  if (!existsSync(STORE_PATH)) {
    return { counter: 0, mappings: {} };
  }
  return JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
}

function saveStore(store: UrlStore): void {
  if (!existsSync(STORE_DIR)) {
    mkdirSync(STORE_DIR, { recursive: true });
  }
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

// --- Public API ---

export function shorten(url: string): UrlMapping {
  const store = loadStore();
  // Check if URL already shortened
  for (const mapping of Object.values(store.mappings)) {
    if (mapping.url === url) return mapping;
  }
  store.counter++;
  const id = toBase62(store.counter);
  const mapping: UrlMapping = { id, url, createdAt: new Date().toISOString(), hits: 0 };
  store.mappings[id] = mapping;
  saveStore(store);
  return mapping;
}

export function resolve(id: string): string | null {
  const store = loadStore();
  const mapping = store.mappings[id];
  if (!mapping) return null;
  mapping.hits++;
  saveStore(store);
  return mapping.url;
}

export function list(): UrlMapping[] {
  return Object.values(loadStore().mappings);
}

export function remove(id: string): boolean {
  const store = loadStore();
  if (!store.mappings[id]) return false;
  delete store.mappings[id];
  saveStore(store);
  return true;
}

// --- Redirect server ---

export function serve(port = 3456) {
  return Bun.serve({
    port,
    fetch(req) {
      const id = new URL(req.url).pathname.slice(1);
      if (!id) {
        return new Response(JSON.stringify(list()), {
          headers: { 'content-type': 'application/json' },
        });
      }
      const target = resolve(id);
      if (!target) return new Response('Not found', { status: 404 });
      return Response.redirect(target, 302);
    },
  });
}
