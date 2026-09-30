document.getElementById('allow').addEventListener('click', async () => {
  const msg = document.getElementById('msg');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    msg.textContent = '✅ Microphone allowed. You can close this tab and use the mic button in DeepPilot.';
    setTimeout(() => window.close(), 2500);
  } catch (e) {
    msg.textContent = '❌ Microphone was blocked. Click the icon in the address bar to allow it, then try again.';
  }
});
