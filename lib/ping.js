export async function ping(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal,
    });
    const rttMs = performance.now() - started;
    try {
      await response.arrayBuffer();
    } catch {
      // Body consume failures still count as a completed round-trip.
    }
    return {
      lost: false,
      rttMs,
      status: response.status,
    };
  } catch {
    return {
      lost: true,
      rttMs: null,
      status: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}
