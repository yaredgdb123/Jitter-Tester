export function originPattern(url) {
  const parsed = new URL(url);
  return `${parsed.origin}/*`;
}

export function originsForTargets(targets) {
  const origins = new Set();
  for (const target of targets) {
    if (!target.enabled) continue;
    try {
      origins.add(originPattern(target.url));
    } catch {
      // skip invalid URLs
    }
  }
  return [...origins];
}

export async function hasOrigins(origins) {
  if (!origins.length) return true;
  return chrome.permissions.contains({ origins });
}

export async function requestOrigins(origins) {
  if (!origins.length) return true;
  if (await hasOrigins(origins)) return true;
  return chrome.permissions.request({ origins });
}

export async function requestTargets(targets) {
  return requestOrigins(originsForTargets(targets));
}
