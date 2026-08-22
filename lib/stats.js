const RECENT_WINDOW = 30;
const MIN_BASELINE = 8;

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function nextJitter(prevJitter, prevRtt, rtt) {
  if (prevRtt == null || rtt == null) return prevJitter;
  const delta = Math.abs(rtt - prevRtt);
  return prevJitter + (delta - prevJitter) / 16;
}

export function isSampleBad(sample, medianRtt, settings) {
  if (sample.lost) return true;
  if (
    medianRtt != null &&
    sample.rttMs != null &&
    sample.rttMs > medianRtt * settings.rttSpikeFactor
  ) {
    return true;
  }
  if (sample.deltaMs != null && sample.deltaMs > settings.jitterThresholdMs) {
    return true;
  }
  return false;
}

export function createDetector() {
  return {
    recentRtts: [],
    prevRtt: null,
    jitter: 0,
    badStreak: 0,
    goodStreak: 0,
    open: null,
  };
}

function touchIncident(incident, sample) {
  incident.sampleCount += 1;
  incident.jitterSum += sample.jitterMs ?? 0;
  incident.jitterCount += 1;
  if (sample.lost) incident.lossCount += 1;
  if (sample.rttMs != null && sample.rttMs > incident.peakRtt) {
    incident.peakRtt = sample.rttMs;
  }
  if (sample.deltaMs != null && sample.deltaMs > incident.maxDelta) {
    incident.maxDelta = sample.deltaMs;
  }
}

function finalizeIncident(incident) {
  return {
    ...incident,
    avgJitter: incident.jitterCount ? incident.jitterSum / incident.jitterCount : 0,
  };
}

export function processSample(detector, input, settings, targetId) {
  const deltaMs =
    !input.lost && detector.prevRtt != null && input.rttMs != null
      ? Math.abs(input.rttMs - detector.prevRtt)
      : null;
  const jitterMs = input.lost
    ? detector.jitter
    : nextJitter(detector.jitter, detector.prevRtt, input.rttMs);

  if (!input.lost && input.rttMs != null) {
    detector.jitter = jitterMs;
    detector.prevRtt = input.rttMs;
    detector.recentRtts.push(input.rttMs);
    if (detector.recentRtts.length > RECENT_WINDOW) detector.recentRtts.shift();
  }

  const sample = {
    t: input.t,
    rttMs: input.lost ? null : input.rttMs,
    lost: Boolean(input.lost),
    jitterMs,
    deltaMs,
  };

  const baseline =
    detector.recentRtts.length >= MIN_BASELINE ? median(detector.recentRtts) : null;
  const bad = isSampleBad(sample, baseline, settings);

  let opened = null;
  let closed = null;

  if (bad) {
    detector.badStreak += 1;
    detector.goodStreak = 0;
    if (!detector.open && detector.badStreak >= settings.consecutiveBad) {
      detector.open = {
        id: `${targetId}-${sample.t}`,
        targetId,
        start: sample.t,
        end: null,
        peakRtt: sample.rttMs ?? 0,
        jitterSum: jitterMs,
        jitterCount: 1,
        lossCount: sample.lost ? 1 : 0,
        sampleCount: 1,
        maxDelta: deltaMs ?? 0,
      };
      opened = detector.open;
    } else if (detector.open) {
      touchIncident(detector.open, sample);
    }
  } else {
    detector.goodStreak += 1;
    detector.badStreak = 0;
    if (detector.open) {
      touchIncident(detector.open, sample);
      if (detector.goodStreak >= settings.consecutiveGood) {
        detector.open.end = sample.t;
        closed = finalizeIncident(detector.open);
        detector.open = null;
        detector.goodStreak = 0;
      }
    }
  }

  return {
    sample,
    opened,
    closed,
    liveJitter: detector.jitter,
  };
}

export function snapshotIncident(incident) {
  if (!incident) return null;
  return finalizeIncident(incident);
}

export function summarize(samples) {
  const rtts = [];
  let loss = 0;
  let jitterSum = 0;
  let jitterCount = 0;
  for (const sample of samples) {
    if (sample.lost || sample.rttMs == null) loss += 1;
    else rtts.push(sample.rttMs);
    if (sample.jitterMs != null) {
      jitterSum += sample.jitterMs;
      jitterCount += 1;
    }
  }
  let min = null;
  let max = null;
  for (const rtt of rtts) {
    if (min == null || rtt < min) min = rtt;
    if (max == null || rtt > max) max = rtt;
  }
  const avg = rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null;
  return {
    count: samples.length,
    loss,
    lossPct: samples.length ? (loss / samples.length) * 100 : 0,
    min,
    max,
    avg,
    median: median(rtts),
    jitter: jitterCount ? jitterSum / jitterCount : 0,
  };
}

export function pushRing(list, item, max) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
  return list;
}
