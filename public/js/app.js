// School Unity client helpers (no inline scripts — CSP friendly)
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-toggle-nav]');
  if (t) { document.body.classList.toggle('nav-open'); return; }
  if (document.body.classList.contains('nav-open') && !e.target.closest('.sidebar')) document.body.classList.remove('nav-open');

  const all = e.target.closest('[data-mark-all]');
  if (all) {
    const v = all.getAttribute('data-mark-all');
    document.querySelectorAll(`input[type=radio][value="${v}"]`).forEach((r) => { r.checked = true; });
  }
  if (e.target.closest('[data-print]')) window.print();
  if (e.target.closest('[data-back]') && history.length > 1) { e.preventDefault(); history.back(); }
});

document.addEventListener('submit', (e) => {
  const msg = e.target.getAttribute('data-confirm');
  if (msg && !window.confirm(msg)) e.preventDefault();
});

// toggle visibility of dependent fields: <input data-reveal="#id">
function syncReveal(el) {
  const target = document.querySelector(el.getAttribute('data-reveal'));
  if (target) target.hidden = !el.checked;
}
document.querySelectorAll('[data-reveal]').forEach((el) => { syncReveal(el); el.addEventListener('change', () => syncReveal(el)); });

// auto-submit filter selects
document.querySelectorAll('[data-autosubmit]').forEach((el) => el.addEventListener('change', () => el.form.submit()));

// live grade preview on mark entry
document.querySelectorAll('input.score').forEach((inp) => {
  const out = document.getElementById('g_' + inp.dataset.sid);
  const max = Number(inp.dataset.max || 100);
  const upd = () => {
    if (!out) return;
    const v = inp.value === '' ? null : (Number(inp.value) / max) * 100;
    const g = v == null || isNaN(v) ? '-' : v >= 80 ? 'A' : v >= 70 ? 'B' : v >= 60 ? 'C' : v >= 50 ? 'D' : v >= 40 ? 'E' : 'F';
    out.textContent = g; out.className = 'badge b-' + g;
  };
  inp.addEventListener('input', upd); upd();
});
