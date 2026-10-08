/**
 * Tiny hash router (#/portals/HR_PORTAL). Hash routing needs no server
 * rewrite rules, so the built app works from any static host.
 */
import { useSyncExternalStore } from 'react';

const subscribe = (cb) => {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
};
const getHash = () => window.location.hash.replace(/^#/, '') || '/';

/** @returns {{ path: string, segments: string[] }} */
export function useRoute() {
  const path = useSyncExternalStore(subscribe, getHash, () => '/');
  return { path, segments: path.split('/').filter(Boolean).map(decodeURIComponent) };
}

export function navigate(to) {
  window.location.hash = to;
}

export const href = (to) => `#${to}`;
