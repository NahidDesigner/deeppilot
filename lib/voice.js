// Voice input using Chrome's built-in speech recognition.

export function voiceSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function createVoice({ lang = 'en-US', onText, onInterim, onState, onError }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let listening = false;

  function start() {
    if (!SR) { onError('Voice input is not supported in this browser.'); return; }
    rec = new SR();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = e => {
      let finalText = '', interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (finalText) onText(finalText.trim());
      onInterim(interim);
    };
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        onError('mic-permission');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        onError(`Voice error: ${e.error}`);
      }
    };
    rec.onend = () => { listening = false; onInterim(''); onState(false); };
    rec.start();
    listening = true;
    onState(true);
  }

  function stop() { if (rec) rec.stop(); }
  // Stop immediately and throw away anything not yet delivered (used when the message is sent).
  function abort() { if (rec && listening) { rec.onresult = null; rec.abort(); } }

  return {
    toggle() { listening ? stop() : start(); },
    stop,
    abort,
    get listening() { return listening; },
    setLang(l) { lang = l; },
  };
}
