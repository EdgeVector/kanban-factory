const label = document.querySelector('#pc-ci-status');
const pause = document.querySelector('#pc-ci-pause');
const resume = document.querySelector('#pc-ci-resume');
const refresh = document.querySelector('#pc-ci-refresh');
let token;
let busy = false;
async function update(action) {
  if (busy) return;
  busy = true;
  pause.disabled = resume.disabled = refresh.disabled = true;
  if (action) label.textContent = action === 'pause' ? 'Request the PC pause…' : 'Restore PC CI…';
  try {
    const response = await fetch('/api/pc-ci', action ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PC-CI-Token': token }, body: JSON.stringify({ action }) } : { cache: 'no-store' });
    const state = await response.json();
    if (!response.ok) throw new Error(state.error || 'PC control request failed.');
    token = state.token;
    label.textContent = state.message;
    label.dataset.phase = state.phase;
    pause.disabled = !state.canPause || state.busy;
    resume.disabled = !state.canResume || state.busy;
  } catch (error) {
    label.textContent = error.message + ' Select Refresh to check the PC.';
    label.dataset.phase = 'error';
  } finally { busy = false; refresh.disabled = false; }
}
pause.addEventListener('click', () => update('pause'));
resume.addEventListener('click', () => update('resume'));
refresh.addEventListener('click', () => update());
update();
setInterval(() => { if (!document.hidden) update(); }, 15000);
