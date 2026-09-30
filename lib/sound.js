// Alert sounds synthesized with Web Audio (no audio files needed).

export const SOUNDS = {
  chime: 'Chime',
  bell: 'Bell',
  beep: 'Beep',
  digital: 'Digital',
  soft: 'Soft ping',
  alarm: 'Alarm clock',
  siren: 'Siren',
  none: 'No sound',
};

let ctx = null;
let loopTimer = null;
let stopTimer = null;
let onRingChange = () => {};

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, start, dur, { type = 'sine', vol = 0.3, attack = 0.01, endFreq = null } = {}) {
  const c = ac();
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, c.currentTime + start);
  if (endFreq) o.frequency.linearRampToValueAtTime(endFreq, c.currentTime + start + dur);
  g.gain.setValueAtTime(0.0001, c.currentTime + start);
  g.gain.exponentialRampToValueAtTime(vol, c.currentTime + start + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
  o.connect(g).connect(c.destination);
  o.start(c.currentTime + start);
  o.stop(c.currentTime + start + dur + 0.05);
}

// Plays one "ring" of a sound. Returns its length in seconds.
export function playOnce(name, volume = 0.7) {
  const v = Math.max(0, Math.min(1, volume)) * 0.5;
  if (!v || name === 'none') return 0;
  switch (name) {
    case 'chime': tone(880, 0, 0.5, { vol: v }); tone(1318.5, 0.18, 0.7, { vol: v }); return 0.9;
    case 'bell': tone(660, 0, 1.6, { vol: v }); tone(1320, 0, 1.2, { vol: v * 0.4 }); tone(1980, 0, 0.8, { vol: v * 0.2 }); return 1.6;
    case 'beep': tone(1000, 0, 0.15, { type: 'square', vol: v * 0.5 }); tone(1000, 0.25, 0.15, { type: 'square', vol: v * 0.5 }); return 0.45;
    case 'digital': [784, 988, 1175, 1568].forEach((f, i) => tone(f, i * 0.09, 0.12, { type: 'triangle', vol: v })); return 0.5;
    case 'soft': tone(520, 0, 0.6, { vol: v * 0.7, attack: 0.05 }); return 0.6;
    case 'alarm': for (let i = 0; i < 4; i++) { tone(1400, i * 0.22, 0.1, { type: 'square', vol: v * 0.45 }); } return 0.9;
    case 'siren': tone(600, 0, 0.6, { type: 'sawtooth', vol: v * 0.35, endFreq: 1100 }); tone(1100, 0.6, 0.6, { type: 'sawtooth', vol: v * 0.35, endFreq: 600 }); return 1.2;
    default: return 0;
  }
}

// Ring a sound; if repeat is on, keep ringing until stopAlarm() (max 2 minutes).
export function ring(name, { volume = 0.7, repeat = false } = {}) {
  stopAlarm();
  const len = playOnce(name, volume);
  if (!len || !repeat) return;
  loopTimer = setInterval(() => playOnce(name, volume), Math.max(1500, (len + 1) * 1000));
  stopTimer = setTimeout(stopAlarm, 120000);
  onRingChange(true);
}

export function stopAlarm() {
  const was = !!loopTimer;
  clearInterval(loopTimer);
  clearTimeout(stopTimer);
  loopTimer = null;
  stopTimer = null;
  if (was) onRingChange(false);
}

export function isRinging() { return !!loopTimer; }
export function onRinging(fn) { onRingChange = fn; }
