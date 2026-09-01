const KEY_PREFIX = 'nudge_reminder_';
const CAT_PREFIX = 'nudge_cat_';
const LEGACY_KEY = 'nudge_reminders';
const TOKEN_KEY = 'nudge_token';
const EMAIL_KEY = 'nudge_email';

const DEFAULT_CAT_ID = 'general';
const CATEGORY_COLORS = ['#9ca3af','#3b82f6','#22c55e','#f97316','#a855f7','#ef4444','#ec4899','#eab308'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// --- Notification poller ---
// Every 30 seconds, scan all reminders and show a browser notification for
// any whose scheduled time matches the current minute. Running twice per minute
// makes delivery resilient to up to ~29 seconds of timer drift. A per-minute
// dedup Set ensures the same reminder never fires twice in the same minute
// regardless of how many polls land within that minute.

const firedThisMinute = new Set();
let lastMinuteKey = '';

function isDueToday(reminder, now) {
  const r = reminder.recurrence;
  if (!r || r === 'daily') return true;

  if (r === 'weekly') {
    const days = (reminder.recurrence_config && reminder.recurrence_config.days) || [];
    return days.includes(now.getDay());
  }

  if (r === 'custom') {
    const interval = (reminder.recurrence_config && reminder.recurrence_config.interval) || 1;
    const anchor = new Date(reminder.created_at || +reminder.id);
    anchor.setHours(0, 0, 0, 0);
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // Math.round absorbs the ±1-hour shift introduced by DST transitions.
    return Math.round((todayMidnight - anchor) / 86400000) % interval === 0;
  }

  return false;
}

function pollReminders() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const currentTime = `${hh}:${mm}`;
  const minuteKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${currentTime}`;

  if (minuteKey !== lastMinuteKey) {
    lastMinuteKey = minuteKey;
    firedThisMinute.clear();
  }

  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  for (const reminder of loadReminders()) {
    if (reminder.time !== currentTime) continue;

    const dedupKey = `${reminder.id}:${minuteKey}`;
    if (firedThisMinute.has(dedupKey)) continue;

    if (!isDueToday(reminder, now)) continue;

    firedThisMinute.add(dedupKey);
    // tag: reminder.id means the browser replaces a stale notification for the
    // same reminder rather than stacking it — a second dedup layer for free.
    new Notification('Nudge', { body: reminder.message, tag: reminder.id });
  }
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') {
    await Notification.requestPermission();
  }
}

function formatRecurrence(reminder) {
  if (!reminder.recurrence) return '';
  if (reminder.recurrence === 'daily') return 'Daily';
  if (reminder.recurrence === 'weekly') {
    const days = ((reminder.recurrence_config && reminder.recurrence_config.days) || [])
      .slice().sort((a, b) => a - b).map((d) => DAY_NAMES[d]);
    return days.length ? `Weekly · ${days.join(', ')}` : 'Weekly';
  }
  if (reminder.recurrence === 'custom') {
    const n = (reminder.recurrence_config && reminder.recurrence_config.interval) || 1;
    return `Every ${n} day${n !== 1 ? 's' : ''}`;
  }
  return '';
}

// --- Helpers ---

function today() {
  return new Date().toISOString().slice(0, 10);
}

function reminderKey(id) { return KEY_PREFIX + id; }
function catKey(id) { return CAT_PREFIX + id; }

// --- Migrations ---

function migrate() {
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return;
  try {
    const reminders = JSON.parse(raw);
    if (Array.isArray(reminders)) {
      reminders.forEach((r) => {
        if (r && r.id && !localStorage.getItem(reminderKey(r.id))) {
          localStorage.setItem(reminderKey(r.id), JSON.stringify(r));
        }
      });
    }
  } catch {
    // legacy data unreadable — discard it
  }
  localStorage.removeItem(LEGACY_KEY);
}

// Assign default category to reminders that don't have one
function migrateCategories() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(KEY_PREFIX)) keys.push(key);
  }
  keys.forEach((key) => {
    try {
      const r = JSON.parse(localStorage.getItem(key));
      if (r && r.id && !r.category_id) {
        localStorage.setItem(key, JSON.stringify({ ...r, category_id: DEFAULT_CAT_ID }));
      }
    } catch {}
  });
}

// --- Local storage: reminders ---

function loadReminders() {
  const reminders = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(KEY_PREFIX)) continue;
    try {
      const r = JSON.parse(localStorage.getItem(key));
      if (r && r.id) reminders.push(r);
    } catch {}
  }
  return reminders;
}

function saveReminder(reminder) {
  localStorage.setItem(reminderKey(reminder.id), JSON.stringify(reminder));
}

function removeReminder(id) {
  localStorage.removeItem(reminderKey(id));
}

// --- Local storage: categories ---

function loadCategories() {
  const cats = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(CAT_PREFIX)) continue;
    try {
      const c = JSON.parse(localStorage.getItem(key));
      if (c && c.id) cats.push(c);
    } catch {}
  }
  // General always first
  cats.sort((a, b) => (a.id === DEFAULT_CAT_ID ? -1 : b.id === DEFAULT_CAT_ID ? 1 : a.name.localeCompare(b.name)));
  return cats;
}

function saveCategory(cat) {
  localStorage.setItem(catKey(cat.id), JSON.stringify(cat));
}

function removeCategoryLocal(id) {
  localStorage.removeItem(catKey(id));
}

function ensureDefaultCategory() {
  if (!localStorage.getItem(catKey(DEFAULT_CAT_ID))) {
    saveCategory({ id: DEFAULT_CAT_ID, name: 'General', color: '#9ca3af' });
  }
}

// --- Auth state ---

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function getEmail() { return localStorage.getItem(EMAIL_KEY); }

function setSession(token, email) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(EMAIL_KEY, email);
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EMAIL_KEY);
}

// --- API ---

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function syncDownCategories() {
  const cats = await api('GET', '/categories');
  cats.forEach(saveCategory);
  return new Set(cats.map((c) => c.id));
}

async function syncUpCategories(serverIds) {
  const local = loadCategories();
  const toUpload = serverIds ? local.filter((c) => !serverIds.has(c.id)) : local;
  await Promise.all(toUpload.map((c) => api('PUT', `/categories/${c.id}`, c).catch(() => {})));
}

async function syncDown() {
  const serverReminders = await api('GET', '/reminders');
  serverReminders.forEach(saveReminder);
  return new Set(serverReminders.map((r) => r.id));
}

async function syncUp(serverIds) {
  const local = loadReminders();
  const toUpload = serverIds ? local.filter((r) => !serverIds.has(r.id)) : local;
  await Promise.all(toUpload.map((r) => api('PUT', `/reminders/${r.id}`, r).catch(() => {})));
}

async function syncAll() {
  const [catServerIds, reminderServerIds] = await Promise.all([
    syncDownCategories(),
    syncDown(),
  ]);
  ensureDefaultCategory();
  await Promise.all([
    syncUpCategories(catServerIds),
    syncUp(reminderServerIds),
  ]);
}

// --- Rendering helpers ---

function formatTime(time24) {
  const [h, m] = time24.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

function computeStreak(completions) {
  if (!completions || completions.length === 0) return 0;
  const doneSet = new Set(completions);
  const todayStr = today();
  const cursor = new Date();
  if (!doneSet.has(todayStr)) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (true) {
    const dateStr = cursor.toISOString().slice(0, 10);
    if (!doneSet.has(dateStr)) break;
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- UI state ---

let activeFilter = 'all';
let newCatColor = CATEGORY_COLORS[1]; // default for new-category form

// --- Render: auth bar ---

function renderAuth() {
  const email = getEmail();
  const bar = document.getElementById('auth-bar');
  if (email) {
    bar.innerHTML = `
      <span class="auth-bar-email">${escapeHtml(email)}</span>
      <button id="sign-out-btn" class="auth-link">Sign out</button>
    `;
    document.getElementById('sign-out-btn').addEventListener('click', logout);
  } else {
    bar.innerHTML = `
      <span>Back up your reminders</span>
      <button id="show-auth-btn" class="auth-link">Sign in</button>
    `;
    document.getElementById('show-auth-btn').addEventListener('click', () => showAuthPanel('login'));
  }
}

function showAuthPanel(mode) {
  const panel = document.getElementById('auth-panel');
  const heading = document.getElementById('auth-heading');
  const submit = document.getElementById('auth-submit');
  const toggle = document.getElementById('auth-toggle');
  heading.textContent = mode === 'register' ? 'Create account' : 'Sign in';
  submit.textContent = mode === 'register' ? 'Create account' : 'Sign in';
  submit.dataset.mode = mode;
  toggle.textContent = mode === 'register' ? 'Sign in instead' : 'Create account';
  setAuthError('');
  panel.hidden = false;
  document.getElementById('auth-email').focus();
}

function hideAuthPanel() {
  document.getElementById('auth-panel').hidden = true;
}

function setAuthError(msg) {
  document.getElementById('auth-error').textContent = msg;
}

// --- Render: category filters ---

function renderCategoryFilters() {
  const cats = loadCategories();
  const bar = document.getElementById('category-filters');
  const all = [{ id: 'all', name: 'All', color: null }, ...cats];
  bar.innerHTML = all.map((c) => `
    <button class="cat-pill${activeFilter === c.id ? ' cat-pill--active' : ''}" data-cat="${escapeHtml(c.id)}">
      ${c.color ? `<span class="cat-dot" style="background:${c.color}"></span>` : ''}
      ${escapeHtml(c.name)}
    </button>
  `).join('');
}

// --- Render: category select in add-reminder form ---

function renderCategorySelect() {
  const cats = loadCategories();
  const select = document.getElementById('category');
  const prev = select.value;
  select.innerHTML = cats.map((c) =>
    `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`
  ).join('');
  if (cats.find((c) => c.id === prev)) select.value = prev;
}

// --- Render: manage panel ---

function renderManagePanel() {
  const cats = loadCategories();
  const list = document.getElementById('category-list-manage');
  list.innerHTML = cats.map((c) => `
    <div class="manage-cat-item">
      <span class="manage-cat-swatch" style="background:${c.color}"></span>
      <span class="manage-cat-name">${escapeHtml(c.name)}</span>
      ${c.id !== DEFAULT_CAT_ID
        ? `<button class="delete-cat-btn" data-cat-id="${escapeHtml(c.id)}" aria-label="Delete ${escapeHtml(c.name)}">&#x2715;</button>`
        : '<span class="manage-cat-default">default</span>'}
    </div>
  `).join('');

  const swatches = document.getElementById('color-swatches');
  swatches.innerHTML = CATEGORY_COLORS.map((color) => `
    <button type="button" class="color-swatch${newCatColor === color ? ' color-swatch--active' : ''}"
            data-color="${color}" style="background:${color}" aria-label="Color ${color}"></button>
  `).join('');
}

// --- Render: reminders ---

function renderReminders() {
  const allReminders = loadReminders();
  const cats = loadCategories();
  const catMap = Object.fromEntries(cats.map((c) => [c.id, c]));
  const defaultCat = catMap[DEFAULT_CAT_ID] || { name: 'General', color: '#9ca3af' };

  const reminders = activeFilter === 'all'
    ? allReminders
    : allReminders.filter((r) => (r.category_id || DEFAULT_CAT_ID) === activeFilter);

  const list = document.getElementById('reminder-list');
  const emptyState = document.getElementById('empty-state');
  list.innerHTML = '';

  if (reminders.length === 0) {
    emptyState.style.display = 'block';
    return;
  }
  emptyState.style.display = 'none';
  const todayStr = today();

  reminders
    .slice()
    .sort((a, b) => a.time.localeCompare(b.time))
    .forEach((reminder) => {
      const completions = reminder.completions || [];
      const doneToday = completions.includes(todayStr);
      const streak = computeStreak(completions);
      const cat = catMap[reminder.category_id || DEFAULT_CAT_ID] || defaultCat;

      const recurrenceLabel = formatRecurrence(reminder);
      const li = document.createElement('li');
      li.className = 'reminder-item' + (doneToday ? ' is-done' : '');
      li.style.setProperty('--cat-color', cat.color);
      li.innerHTML = `
        <button class="done-btn ${doneToday ? 'done-btn--checked' : ''}" data-id="${reminder.id}" aria-label="${doneToday ? 'Completed today' : 'Mark as done'}">
          ${doneToday ? '&#x2713;' : ''}
        </button>
        <div class="reminder-info">
          <span class="reminder-message">${escapeHtml(reminder.message)}</span>
          <span class="reminder-time">${formatTime(reminder.time)}</span>
        </div>
        <div class="reminder-meta">
          ${activeFilter === 'all' ? `<span class="cat-badge" style="--cat-color:${cat.color}">${escapeHtml(cat.name)}</span>` : ''}
          ${recurrenceLabel ? `<span class="recurrence-badge">${escapeHtml(recurrenceLabel)}</span>` : ''}
          ${streak > 0 ? `<span class="streak" title="${streak}-day streak">${streak} day streak</span>` : ''}
          <button class="delete-btn" data-id="${reminder.id}" aria-label="Delete reminder">&#x2715;</button>
        </div>
      `;
      list.appendChild(li);
    });
}

function renderAll() {
  renderCategoryFilters();
  renderCategorySelect();
  renderManagePanel();
  renderReminders();
}

// --- Actions ---

async function addReminder(message, time, categoryId, recurrence, recurrenceConfig) {
  const reminder = {
    id: Date.now().toString(),
    message,
    time,
    completions: [],
    category_id: categoryId || DEFAULT_CAT_ID,
    created_at: new Date().toISOString(),
    recurrence: recurrence || null,
    recurrence_config: recurrenceConfig || null,
  };
  saveReminder(reminder);
  renderReminders();
  if (getToken()) api('PUT', `/reminders/${reminder.id}`, reminder).catch(() => {});
}

async function deleteReminder(id) {
  const items = [...document.querySelectorAll('.reminder-item')];
  const idx = items.findIndex((li) => li.querySelector(`.delete-btn[data-id="${id}"]`));

  removeReminder(id);
  renderReminders();
  if (getToken()) api('DELETE', `/reminders/${id}`).catch(() => {});

  const newItems = [...document.querySelectorAll('.reminder-item')];
  const target = newItems[idx] ?? newItems[idx - 1];
  (target?.querySelector('.delete-btn') ?? document.getElementById('message')).focus();
}

async function markDoneToday(id) {
  const todayStr = today();
  try {
    const reminder = JSON.parse(localStorage.getItem(reminderKey(id)));
    if (!reminder) return;
    const completions = reminder.completions || [];
    if (completions.includes(todayStr)) return;
    const updated = { ...reminder, completions: [...completions, todayStr] };
    saveReminder(updated);
    renderReminders();
    if (getToken()) api('PUT', `/reminders/${id}`, updated).catch(() => {});
  } catch {
    // corrupted entry — nothing to update
  }
}

async function addCategory(name, color) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const cat = { id, name, color };
  saveCategory(cat);
  renderAll();
  if (getToken()) api('PUT', `/categories/${id}`, cat).catch(() => {});
}

async function deleteCategory(id) {
  removeCategoryLocal(id);
  // Reassign affected reminders to general
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(KEY_PREFIX)) keys.push(key);
  }
  keys.forEach((key) => {
    try {
      const r = JSON.parse(localStorage.getItem(key));
      if (r && r.id && (r.category_id || DEFAULT_CAT_ID) === id) {
        const updated = { ...r, category_id: DEFAULT_CAT_ID };
        saveReminder(updated);
        if (getToken()) api('PUT', `/reminders/${r.id}`, updated).catch(() => {});
      }
    } catch {}
  });
  if (activeFilter === id) activeFilter = 'all';
  renderAll();
  if (getToken()) api('DELETE', `/categories/${id}`).catch(() => {});
}

async function signIn(email, password, isRegister) {
  const data = await api('POST', isRegister ? '/auth/register' : '/auth/login', { email, password });
  setSession(data.token, data.email);
  hideAuthPanel();
  renderAuth();
  await syncAll();
  renderAll();
}

function logout() {
  clearSession();
  renderAuth();
}

// --- Event listeners ---

document.getElementById('recurrence').addEventListener('change', (e) => {
  const val = e.target.value;
  document.getElementById('weekly-options').hidden = val !== 'weekly';
  document.getElementById('custom-options').hidden = val !== 'custom';
  if (val === 'weekly') {
    // Default Mon–Fri checked
    document.querySelectorAll('input[name="dow"]').forEach((cb) => {
      cb.checked = ['1','2','3','4','5'].includes(cb.value);
    });
  }
  if (val) requestNotificationPermission();
});

document.getElementById('reminder-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const message = document.getElementById('message').value.trim();
  const time = document.getElementById('time').value;
  const categoryId = document.getElementById('category').value;
  const recurrence = document.getElementById('recurrence').value || null;

  let recurrenceConfig = null;
  if (recurrence === 'weekly') {
    const days = [...document.querySelectorAll('input[name="dow"]:checked')].map((cb) => +cb.value);
    if (!days.length) return;
    recurrenceConfig = { days };
  } else if (recurrence === 'custom') {
    const interval = Math.max(1, parseInt(document.getElementById('custom-interval').value, 10) || 1);
    recurrenceConfig = { interval };
  }

  if (!message || !time) return;
  addReminder(message, time, categoryId, recurrence, recurrenceConfig);
  e.target.reset();
  document.getElementById('category').value = categoryId;
  document.getElementById('weekly-options').hidden = true;
  document.getElementById('custom-options').hidden = true;
  document.getElementById('message').focus();
});

document.getElementById('reminder-list').addEventListener('click', (e) => {
  const deleteBtn = e.target.closest('.delete-btn');
  if (deleteBtn) { deleteReminder(deleteBtn.dataset.id); return; }
  const doneBtn = e.target.closest('.done-btn');
  if (doneBtn && !doneBtn.classList.contains('done-btn--checked')) {
    markDoneToday(doneBtn.dataset.id);
  }
});

document.getElementById('category-filters').addEventListener('click', (e) => {
  const pill = e.target.closest('.cat-pill');
  if (!pill) return;
  activeFilter = pill.dataset.cat;
  renderCategoryFilters();
  renderReminders();
});

document.getElementById('manage-btn').addEventListener('click', () => {
  document.getElementById('manage-panel').hidden = false;
  renderManagePanel();
});

document.getElementById('manage-close').addEventListener('click', () => {
  document.getElementById('manage-panel').hidden = true;
});

document.getElementById('manage-panel').addEventListener('click', (e) => {
  const swatch = e.target.closest('.color-swatch');
  if (swatch) {
    newCatColor = swatch.dataset.color;
    renderManagePanel();
    return;
  }
  const del = e.target.closest('.delete-cat-btn');
  if (del) {
    deleteCategory(del.dataset.catId);
  }
});

document.getElementById('add-category-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('new-cat-name').value.trim();
  if (!name) return;
  addCategory(name, newCatColor);
  document.getElementById('new-cat-name').value = '';
  newCatColor = CATEGORY_COLORS[1];
});

document.getElementById('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const submit = document.getElementById('auth-submit');
  const isRegister = submit.dataset.mode === 'register';
  setAuthError('');
  submit.disabled = true;
  try {
    await signIn(email, password, isRegister);
  } catch (err) {
    setAuthError(err.message);
  } finally {
    submit.disabled = false;
  }
});

document.getElementById('auth-toggle').addEventListener('click', () => {
  const submit = document.getElementById('auth-submit');
  const currentMode = submit.dataset.mode;
  showAuthPanel(currentMode === 'register' ? 'login' : 'register');
});

document.getElementById('auth-cancel').addEventListener('click', hideAuthPanel);

// --- Init ---

// Unregister any service worker left over from a previous version of the app.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));
}

migrate();
migrateCategories();
ensureDefaultCategory();
renderAuth();
renderAll();

// Run immediately so the poller catches reminders due at startup, then every 30 s.
pollReminders();
setInterval(pollReminders, 30_000);

if (getToken()) {
  syncAll().then(renderAll).catch(() => {});
}
