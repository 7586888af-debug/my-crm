// ==========================================================================
// CRM Mini App — основная логика
// ==========================================================================

let sb = null;
let tg = window.Telegram ? window.Telegram.WebApp : null;
let tgUser = null;
let state = {
  view: 'contacts',
  contacts: [],
  deals: [],
  tasks: [],
  events: [],
  touches: [],
  tasksFilter: 'all',
  contactsFilterProject: '',
  contactsFilterStage: '',
  dealsFilterProject: '',
  calendarConnected: false,
  calendarEmail: '',
};

const PROJECTS = ['MWR', 'Мафия', 'Нейросети', 'Переговоры'];

const STAGES = [
  'новый клиент',
  'первичное касание',
  'первичная встреча',
  'изучает материалы',
  'мероприятие',
  'повторная встреча',
  'первичная трёшка',
  'повторная трёшка',
  'ищет деньги',
  'на паузе',
  'регистрация',
];

const TOUCH_TYPES = [
  'звонок/переписка первичная',
  'звонок/переписка повторная',
  'первичная встреча',
  'повторная встреча',
  'мероприятие',
  'первичная трёшка',
  'повторная трёшка',
  'регистрация',
  'другое',
];

// Из вашего листа "Правила CRM": что делать дальше по последнему касанию.
const NEXT_ACTION_MAP = {
  'звонок/переписка первичная': 'Назначить встречу',
  'звонок/переписка повторная': 'Назначить встречу',
  'первичная встреча': 'Пригласить на трёшку',
  'повторная встреча': 'Пригласить на трёшку',
  'мероприятие': 'Пригласить на трёшку',
  'первичная трёшка': 'Дожать регистрацию',
  'повторная трёшка': 'Дожать регистрацию',
  'регистрация': 'Сопровождение',
};

const DIRECTIONS = ['предприниматель', 'фрилансер', 'клиент+партнер', 'не знаю'];

// -------------------------- ИНИЦИАЛИЗАЦИЯ --------------------------

async function init() {
  if (tg) {
    tg.ready();
    tg.expand();
    tgUser = (tg.initDataUnsafe && tg.initDataUnsafe.user) ? tg.initDataUnsafe.user : null;
  }

  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) {
    document.getElementById('config-missing').style.display = 'block';
    document.getElementById('screen-loading').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    return;
  }

  sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

  // Запоминаем chat_id владельца CRM (вас) — он нужен Edge Function
  // task-reminders, чтобы знать, кому в Telegram слать напоминания о задачах.
  if (tgUser && tgUser.id) {
    sb.from('settings').upsert({ id: 1, owner_chat_id: String(tgUser.id) }).then(() => {}, () => {});
  }

  bindUI();
  setupContactPicker();

  // Обработка возврата из OAuth Google (см. SETUP.md): если пришли с ?gcal=connected
  const params = new URLSearchParams(window.location.search);
  if (params.get('gcal') === 'connected' && tg && tg.showPopup) {
    tg.showPopup({ title: 'Google Calendar', message: 'Календарь подключен', buttons: [{ type: 'close' }] });
  }

  // Проверяем deep-link на регистрацию: startapp=event_<id>
  const startParam = tg && tg.initDataUnsafe ? tg.initDataUnsafe.start_param : null;
  if (startParam && startParam.indexOf('event_') === 0) {
    const eventId = startParam.replace('event_', '');
    await openRegisterView(eventId);
  } else {
    await refreshAll();
    switchView('contacts');
  }

  refreshCalendarStatus();

  document.getElementById('screen-loading').style.display = 'none';
  document.getElementById('app').style.display = 'block';
}

async function refreshAll() {
  const [c, d, t, ev, tc] = await Promise.all([
    sb.from('contacts').select('*').order('created_at', { ascending: false }),
    sb.from('deals').select('*').order('created_at', { ascending: false }),
    sb.from('tasks').select('*').order('due_date', { ascending: true }),
    sb.from('events').select('*').order('event_date', { ascending: true }),
    sb.from('touches').select('*').order('created_at', { ascending: false }),
  ]);
  state.contacts = c.data || [];
  state.deals = d.data || [];
  state.tasks = t.data || [];
  state.events = ev.data || [];
  state.touches = tc.data || [];
  renderCurrentView();
}

// -------------------------- НАВИГАЦИЯ --------------------------

function bindUI() {
  document.querySelectorAll('nav.bottom button').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  document.getElementById('fab-add').addEventListener('click', onFabClick);
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'modal-overlay') closeModal();
  });
  document.getElementById('btn-import-csv').addEventListener('click', () => {
    document.getElementById('csv-file').click();
  });
  document.getElementById('csv-file').addEventListener('change', handleCsvImport);
  document.getElementById('btn-import-touches').addEventListener('click', () => {
    document.getElementById('touches-csv-file').click();
  });
  document.getElementById('touches-csv-file').addEventListener('change', handleTouchesCsvImport);
  document.getElementById('btn-pick-telegram').addEventListener('click', pickContactFromTelegram);
  document.getElementById('global-search').addEventListener('input', (e) => {
    renderContacts(e.target.value);
  });
  document.querySelectorAll('#tasks-filter button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tasks-filter button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.tasksFilter = btn.dataset.f;
      renderTasks();
    });
  });
  document.getElementById('btn-calendar').addEventListener('click', onCalendarButtonClick);

  const fp = document.getElementById('filter-project');
  const fs = document.getElementById('filter-stage');
  PROJECTS.forEach(p => { const o = document.createElement('option'); o.value = p; o.textContent = p; fp.appendChild(o); });
  STAGES.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; fs.appendChild(o); });
  fp.addEventListener('change', () => { state.contactsFilterProject = fp.value; renderContacts(document.getElementById('global-search').value); });
  fs.addEventListener('change', () => { state.contactsFilterStage = fs.value; renderContacts(document.getElementById('global-search').value); });
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll('nav.bottom button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  document.getElementById('search-row').style.display = (view === 'contacts') ? 'flex' : 'none';
  document.getElementById('fab-add').style.display = (view === 'register') ? 'none' : 'flex';
  const titles = { contacts: 'Контакты', deals: 'Воронка', tasks: 'Задачи', events: 'Мероприятия', stats: 'Статистика', register: 'Регистрация' };
  document.getElementById('header-title').textContent = titles[view] || 'CRM';
  renderCurrentView();
}

function renderCurrentView() {
  if (state.view === 'contacts') renderContacts();
  if (state.view === 'deals') renderDeals();
  if (state.view === 'tasks') renderTasks();
  if (state.view === 'events') renderEvents();
  if (state.view === 'stats') renderStats();
}

function onFabClick() {
  if (state.view === 'contacts') openContactForm();
  else if (state.view === 'deals') openDealForm();
  else if (state.view === 'tasks') openTaskForm();
  else if (state.view === 'events') openEventForm();
}

// -------------------------- УТИЛИТЫ --------------------------

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function fmtDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' +
         dt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
function touchesForContact(contactId) {
  return state.touches.filter(t => t.contact_id === contactId);
}
function dealsForContact(contactId) {
  return state.deals.filter(d => d.contact_id === contactId);
}
function tasksForContact(contactId) {
  return state.tasks.filter(t => t.contact_id === contactId);
}
function contactName(id) {
  const c = state.contacts.find(c => c.id === id);
  return c ? c.name : '—';
}
function lastTouchForContact(contactId) {
  const list = touchesForContact(contactId);
  if (!list.length) return null;
  return list.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
}
function isContactOverdue(contactId) {
  const now = new Date();
  return state.tasks.some(t => t.contact_id === contactId && !t.completed && t.due_date && new Date(t.due_date) < now);
}
function contactMatchesFilters(contact) {
  const deals = dealsForContact(contact.id);
  if (state.contactsFilterProject && !deals.some(d => d.project === state.contactsFilterProject)) return false;
  if (state.contactsFilterStage && !deals.some(d => d.stage === state.contactsFilterStage)) return false;
  return true;
}

function openModal(html) {
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  document.getElementById('modal-body').innerHTML = '';
}

function selectOptions(values, selected) {
  return values.map(v => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(v)}</option>`).join('');
}

// ============================================================
// КОНТАКТЫ
// ============================================================

function renderContacts(filter) {
  const list = document.getElementById('contacts-list');
  filter = (filter || '').toLowerCase().trim();
  let items = state.contacts.filter(contactMatchesFilters);
  if (filter) {
    items = items.filter(c =>
      (c.name || '').toLowerCase().includes(filter) ||
      (c.phone || '').toLowerCase().includes(filter) ||
      (c.telegram_username || '').toLowerCase().includes(filter)
    );
  }
  if (!items.length) {
    list.innerHTML = '<div class="empty">Ничего не найдено.<br>Измените фильтры или добавьте контакт (+).</div>';
    return;
  }
  list.innerHTML = items.map(c => {
    const touchCount = touchesForContact(c.id).length;
    const deals = dealsForContact(c.id);
    const stagesLabel = deals.map(d => `${esc(d.project)}: ${esc(d.stage)}`).join(' · ');
    const overdue = isContactOverdue(c.id);
    return `
    <div class="card" onclick="openContactDetail('${c.id}')">
      <div class="row">
        <h3>${esc(c.name)}</h3>
        <span class="pill">${esc(c.status || 'новый')}</span>
      </div>
      <div class="meta">${esc(c.phone || '')} ${c.telegram_username ? '· @' + esc(c.telegram_username) : ''} ${c.city ? '· ' + esc(c.city) : ''}</div>
      <div class="meta">Касаний: ${touchCount} · Источник: ${esc(c.source || '—')}</div>
      ${stagesLabel ? '<div class="meta">' + esc(stagesLabel) + '</div>' : ''}
      ${overdue ? '<span class="pill" style="background:var(--danger); color:#fff; border-color:var(--danger);">🔴 Просрочено</span>' : ''}
    </div>`;
  }).join('');
}

function openContactForm(existing) {
  const c = existing || {};
  openModal(`
    <h2>${existing ? 'Редактировать контакт' : 'Новый контакт'}</h2>
    <div class="field"><label>Имя *</label><input id="f-name" value="${esc(c.name || '')}"></div>
    <div class="field"><label>Телефон</label><input id="f-phone" value="${esc(c.phone || '')}"></div>
    <div class="field"><label>Telegram username</label><input id="f-tg" value="${esc(c.telegram_username || '')}"></div>
    <div class="field"><label>Email</label><input id="f-email" value="${esc(c.email || '')}"></div>
    <div class="field"><label>Город</label><input id="f-city" value="${esc(c.city || '')}"></div>
    <div class="field"><label>Направление</label>
      <select id="f-direction"><option value="">— не указано —</option>${selectOptions(DIRECTIONS, c.direction)}</select>
    </div>
    <div class="field"><label>Статус</label>
      <select id="f-status">${selectOptions(['новый', 'в работе', 'клиент', 'отказ'], c.status)}</select>
    </div>
    <div class="field"><label>Заметки</label><textarea id="f-notes">${esc(c.notes || '')}</textarea></div>
    <div class="modal-actions">
      <button class="btn secondary" onclick="closeModal()">Отмена</button>
      <button class="btn" onclick="saveContact(${existing ? "'" + c.id + "'" : 'null'})">Сохранить</button>
    </div>
  `);
}

async function saveContact(id) {
  const payload = {
    name: document.getElementById('f-name').value.trim(),
    phone: document.getElementById('f-phone').value.trim(),
    telegram_username: document.getElementById('f-tg').value.trim(),
    email: document.getElementById('f-email').value.trim(),
    city: document.getElementById('f-city').value.trim(),
    direction: document.getElementById('f-direction').value,
    status: document.getElementById('f-status').value,
    notes: document.getElementById('f-notes').value.trim(),
    updated_at: new Date().toISOString(),
  };
  if (!payload.name) { alert('Укажите имя'); return; }
  if (id) {
    await sb.from('contacts').update(payload).eq('id', id);
  } else {
    payload.source = 'вручную';
    await sb.from('contacts').insert(payload);
  }
  closeModal();
  await refreshAll();
}

async function deleteContact(id) {
  if (!confirm('Удалить контакт? Связанные сделки/задачи/касания тоже будут удалены.')) return;
  await sb.from('touches').delete().eq('contact_id', id);
  await sb.from('deals').delete().eq('contact_id', id);
  await sb.from('tasks').delete().eq('contact_id', id);
  await sb.from('contacts').delete().eq('id', id);
  closeModal();
  await refreshAll();
}

function openContactDetail(id) {
  const c = state.contacts.find(x => x.id === id);
  if (!c) return;
  const touches = touchesForContact(id);
  const deals = dealsForContact(id);
  const tasks = tasksForContact(id);
  const meetings = tasks.filter(t => t.kind === 'встреча');
  const plainTasks = tasks.filter(t => t.kind !== 'встреча');
  const lastTouch = lastTouchForContact(id);
  const nextAction = lastTouch ? NEXT_ACTION_MAP[lastTouch.type] : 'Первое касание';
  const overdue = isContactOverdue(id);
  openModal(`
    <div class="row">
      <h2 style="margin:0;">${esc(c.name)}</h2>
      <span class="pill">Касаний: ${touches.length}</span>
    </div>
    <div class="meta">${esc(c.phone || 'телефон не указан')} ${c.telegram_username ? '· @' + esc(c.telegram_username) : ''} ${c.city ? '· ' + esc(c.city) : ''}</div>
    <div class="meta">${esc(c.email || '')} ${c.direction ? '· ' + esc(c.direction) : ''}</div>
    <p style="font-size:14px;">${esc(c.notes || '')}</p>

    <div class="card" style="margin:10px 0; ${overdue ? 'border-color:var(--danger);' : ''}">
      <div class="meta">Последнее касание: ${lastTouch ? esc(lastTouch.type) + ' · ' + fmtDateTime(lastTouch.created_at) : 'ещё не было'}</div>
      <div class="row" style="margin-top:2px;">
        <strong style="font-size:14px;">${nextAction ? '👉 ' + esc(nextAction) : ''}</strong>
        ${overdue ? '<span class="pill" style="background:var(--danger); color:#fff; border-color:var(--danger);">Просрочено</span>' : ''}
      </div>
    </div>

    <div class="row" style="margin:10px 0 4px;">
      <strong style="font-size:14px;">Воронка (${deals.length})</strong>
      <button class="btn small" onclick="openDealForm(null, '${id}')">+ Сделка</button>
    </div>
    <div>${deals.length ? deals.map(d => `<div class="meta">• ${esc(d.project)} — ${esc(d.stage)}</div>`).join('') : '<div class="meta">Нет сделок</div>'}</div>

    <div class="row" style="margin:14px 0 4px;">
      <strong style="font-size:14px;">Касания (${touches.length})</strong>
      <button class="btn small" onclick="openTouchForm('${id}')">+ Касание</button>
    </div>
    <div>${touches.length ? touches.map(t => `
      <div class="touch-item">
        <div>${esc(t.type)}${t.note ? ': ' + esc(t.note) : ''}</div>
        <div class="meta">${fmtDateTime(t.created_at)}</div>
      </div>`).join('') : '<div class="meta">Пока нет истории касаний</div>'}
    </div>

    <div class="row" style="margin:14px 0 4px;">
      <strong style="font-size:14px;">Встречи (${meetings.length})</strong>
      <button class="btn small" onclick="openTaskForm('${id}', 'встреча')">+ Встреча</button>
    </div>
    <div>${meetings.length ? meetings.map(t => `
      <div class="meta">${t.completed ? '✅' : '🤝'} ${esc(t.title)} ${t.due_date ? '— ' + fmtDateTime(t.due_date) : ''} ${t.location ? '· ' + esc(t.location) : ''} ${t.google_event_id ? '· 📅 в календаре' : (t.due_date ? '· 📅 не синхронизировано' : '')}</div>
    `).join('') : '<div class="meta">Встреч не запланировано</div>'}</div>

    <div class="row" style="margin:14px 0 4px;">
      <strong style="font-size:14px;">Задачи (${plainTasks.length})</strong>
      <button class="btn small" onclick="openTaskForm('${id}', 'задача')">+ Задача</button>
    </div>
    <div>${plainTasks.length ? plainTasks.map(t => `
      <div class="meta">${t.completed ? '✅' : '⏳'} ${esc(t.title)} ${t.due_date ? '— ' + fmtDateTime(t.due_date) : ''} ${(!t.completed && t.due_date) ? (t.reminder_sent ? '· 🔔 напоминание отправлено' : '· 🔔 напомним в боте') : ''}</div>
    `).join('') : '<div class="meta">Нет задач</div>'}</div>

    <div class="modal-actions">
      <button class="btn secondary" onclick="openContactForm(${JSON.stringify(c).replace(/"/g, '&quot;')})">Изменить</button>
      <button class="btn danger" onclick="deleteContact('${id}')">Удалить</button>
    </div>
    <button class="btn block" onclick="closeModal()">Закрыть</button>
  `);
}

function openTouchForm(contactId) {
  openModal(`
    <h2>Новое касание</h2>
    <div class="field"><label>Тип</label>
      <select id="t-type">${selectOptions(TOUCH_TYPES)}</select>
    </div>
    <div class="field"><label>Комментарий</label><textarea id="t-note"></textarea></div>
    <div class="modal-actions">
      <button class="btn secondary" onclick="openContactDetail('${contactId}')">Назад</button>
      <button class="btn" onclick="saveTouch('${contactId}')">Сохранить</button>
    </div>
  `);
}

async function saveTouch(contactId) {
  const type = document.getElementById('t-type').value;
  const note = document.getElementById('t-note').value.trim();
  await sb.from('touches').insert({ contact_id: contactId, type, note });
  await refreshAll();
  openContactDetail(contactId);
}

// -------- Быстрое добавление из телефонной книги --------
// Работает только там, где браузер поддерживает Contact Picker API —
// на практике это Chrome/WebView на Android. На iOS и десктопе Telegram
// такого API нет (сама платформа Telegram не даёт мини-приложениям
// доступа к чужим контактам — это ограничение из соображений приватности),
// поэтому там кнопка скрыта и добавление делается вручную через форму.
function setupContactPicker() {
  const btn = document.getElementById('btn-pick-contact');
  if (navigator.contacts && navigator.contacts.select && navigator.ContactsManager) {
    btn.style.display = 'inline-block';
    btn.addEventListener('click', pickContactFromPhone);
  }
}

async function pickContactFromPhone() {
  try {
    const props = ['name', 'tel'];
    const picked = await navigator.contacts.select(props, { multiple: false });
    if (!picked || !picked.length) return;
    const p = picked[0];
    openContactForm({
      name: (p.name && p.name[0]) || '',
      phone: (p.tel && p.tel[0]) || '',
    });
  } catch (e) {
    alert('Не удалось открыть контакты телефона: ' + e.message);
  }
}

// -------- Быстрое добавление из Telegram --------
// Полноценного API "выбрать любой чужой контакт в Telegram" у мини-приложений
// нет (это сознательное ограничение приватности площадки). Поэтому кнопка
// делает то, что реально доступно:
//  1) если мини-апп открыт из чата/группы через меню вложений — Telegram
//     передаёт данные этого чата в initDataUnsafe.chat, подставляем их;
//  2) иначе предлагаем вставить username из буфера обмена (скопировали
//     из профиля контакта в Telegram — вставили сюда одной кнопкой);
//  3) если и это недоступно — просто открываем пустую форму, username/телефон
//     вводятся вручную.
async function pickContactFromTelegram() {
  const chat = tg && tg.initDataUnsafe ? tg.initDataUnsafe.chat : null;
  if (chat && (chat.type === 'private' || chat.username || chat.first_name)) {
    openContactForm({
      name: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.title || '',
      telegram_username: chat.username || '',
    });
    return;
  }
  if (navigator.clipboard && navigator.clipboard.readText) {
    try {
      let text = (await navigator.clipboard.readText() || '').trim();
      if (text) {
        text = text.replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
        openContactForm({ telegram_username: text });
        return;
      }
    } catch (e) {
      // доступ к буферу не дали — просто откроем пустую форму ниже
    }
  }
  alert('Скопируйте username или телефон контакта в Telegram, затем нажмите эту кнопку ещё раз — поле подставится автоматически. Либо просто заполните форму вручную.');
  openContactForm({});
}

// -------- CSV импорт контактов --------

function handleCsvImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: async (results) => {
      const rows = results.data;
      if (!rows.length) { alert('Файл пуст или не распознан'); return; }
      openCsvMapping(rows, Object.keys(rows[0]));
    },
    error: (err) => alert('Ошибка чтения CSV: ' + err.message),
  });
  e.target.value = '';
}

function openCsvMapping(rows, columns) {
  const fields = [
    { key: 'name', label: 'Имя *' },
    { key: 'phone', label: 'Телефон' },
    { key: 'telegram_username', label: 'Telegram username' },
    { key: 'email', label: 'Email' },
    { key: 'city', label: 'Город' },
    { key: 'direction', label: 'Направление' },
    { key: 'notes', label: 'Заметки' },
  ];
  window.__csvRows = rows;
  openModal(`
    <h2>Импорт CSV (${rows.length} строк)</h2>
    <p class="meta">Сопоставьте колонки вашего файла с полями CRM.</p>
    ${fields.map(f => `
      <div class="field">
        <label>${f.label}</label>
        <select id="map-${f.key}">
          <option value="">— не использовать —</option>
          ${columns.map(c => `<option value="${esc(c)}" ${c.toLowerCase()===f.key ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
      </div>
    `).join('')}
    <div class="modal-actions">
      <button class="btn secondary" onclick="closeModal()">Отмена</button>
      <button class="btn" onclick="runCsvImport()">Импортировать</button>
    </div>
  `);
}

async function runCsvImport() {
  const fields = ['name', 'phone', 'telegram_username', 'email', 'city', 'direction', 'notes'];
  const map = {};
  fields.forEach(f => { map[f] = document.getElementById('map-' + f).value; });
  if (!map.name) { alert('Нужно указать хотя бы колонку с именем'); return; }
  const rows = window.__csvRows || [];
  const payload = rows.map(r => {
    const obj = { source: 'импорт' };
    fields.forEach(f => { if (map[f]) obj[f] = (r[map[f]] || '').toString().trim(); });
    return obj;
  }).filter(o => o.name);
  closeModal();
  const CHUNK = 200;
  for (let i = 0; i < payload.length; i += CHUNK) {
    await sb.from('contacts').insert(payload.slice(i, i + CHUNK));
  }
  alert('Импортировано контактов: ' + payload.length);
  await refreshAll();
}

// -------- Импорт истории касаний из CSV --------
// Отдельный флоу для листа вроде "Касания" в вашей таблице: там одна строка =
// одно касание клиента, а не карточка контакта. Сопоставляем строки с уже
// существующими контактами по телефону (точнее) или по имени, и пишем
// в touches — с реальной датой касания из файла, если она есть.

function handleTouchesCsvImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: (results) => {
      const rows = results.data;
      if (!rows.length) { alert('Файл пуст или не распознан'); return; }
      openTouchesCsvMapping(rows, Object.keys(rows[0]));
    },
    error: (err) => alert('Ошибка чтения CSV: ' + err.message),
  });
  e.target.value = '';
}

function openTouchesCsvMapping(rows, columns) {
  window.__touchRows = rows;
  const guess = (needle) => columns.find(c => c.toLowerCase().includes(needle)) || '';
  const colOptions = (preselect) => '<option value="">— не использовать —</option>' +
    columns.map(c => `<option value="${esc(c)}" ${c === preselect ? 'selected' : ''}>${esc(c)}</option>`).join('');
  openModal(`
    <h2>Импорт истории касаний (${rows.length} строк)</h2>
    <p class="meta">Каждая строка файла — одно касание. Сопоставьте колонки вашего листа с полями CRM. Контакт ищется по телефону, а если не найден — по имени среди уже существующих контактов (сначала импортируйте контакты).</p>
    <div class="field"><label>Имя контакта</label><select id="tmap-name">${colOptions(guess('имя') || guess('фио') || guess('клиент'))}</select></div>
    <div class="field"><label>Телефон контакта</label><select id="tmap-phone">${colOptions(guess('телеф'))}</select></div>
    <div class="field"><label>Дата касания</label><select id="tmap-date">${colOptions(guess('дат'))}</select></div>
    <div class="field"><label>Тип касания</label><select id="tmap-type">${colOptions(guess('тип'))}</select></div>
    <div class="field"><label>Комментарий</label><select id="tmap-note">${colOptions(guess('коммент') || guess('примеч'))}</select></div>
    <div class="modal-actions">
      <button class="btn secondary" onclick="closeModal()">Отмена</button>
      <button class="btn" onclick="runTouchesCsvImport()">Импортировать</button>
    </div>
  `);
}

function normalizePhone(p) {
  let digits = (p || '').toString().replace(/[^\d]/g, '');
  if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);
  return digits;
}

function parseFlexibleDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    let [, d, mo, y, h, mi, se] = m;
    if (y.length === 2) y = '20' + y;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h || 0), Number(mi || 0), Number(se || 0));
    if (!isNaN(dt)) return dt;
  }
  const dt2 = new Date(s);
  if (!isNaN(dt2)) return dt2;
  return null;
}

async function runTouchesCsvImport() {
  const nameCol = document.getElementById('tmap-name').value;
  const phoneCol = document.getElementById('tmap-phone').value;
  const dateCol = document.getElementById('tmap-date').value;
  const typeCol = document.getElementById('tmap-type').value;
  const noteCol = document.getElementById('tmap-note').value;
  if (!nameCol && !phoneCol) { alert('Укажите хотя бы колонку с именем или телефоном — иначе не с кем сопоставить касания'); return; }

  const rows = window.__touchRows || [];
  const byPhone = {};
  const byName = {};
  state.contacts.forEach(c => {
    if (c.phone) { const n = normalizePhone(c.phone); if (n) byPhone[n] = c.id; }
    if (c.name) {
      const key = c.name.toString().toLowerCase().trim();
      (byName[key] = byName[key] || []).push(c.id);
    }
  });

  const toInsert = [];
  let notFound = 0, ambiguous = 0;
  rows.forEach(r => {
    let contactId = null;
    if (phoneCol && r[phoneCol]) {
      const norm = normalizePhone(r[phoneCol]);
      if (norm && byPhone[norm]) contactId = byPhone[norm];
    }
    if (!contactId && nameCol && r[nameCol]) {
      const key = r[nameCol].toString().toLowerCase().trim();
      const matches = byName[key];
      if (matches && matches.length === 1) contactId = matches[0];
      else if (matches && matches.length > 1) ambiguous++;
    }
    if (!contactId) { notFound++; return; }

    const rawType = typeCol ? (r[typeCol] || '').toString().trim().toLowerCase() : '';
    const type = TOUCH_TYPES.find(t => t === rawType) || TOUCH_TYPES.find(t => rawType && rawType.includes(t)) || 'другое';
    const dt = dateCol ? parseFlexibleDate(r[dateCol]) : null;
    const obj = { contact_id: contactId, type, note: noteCol ? (r[noteCol] || '').toString().trim() : '' };
    if (dt) obj.created_at = dt.toISOString();
    toInsert.push(obj);
  });

  closeModal();
  const CHUNK = 200;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    await sb.from('touches').insert(toInsert.slice(i, i + CHUNK));
  }
  alert('Импортировано касаний: ' + toInsert.length +
    '\nНе найден контакт: ' + notFound +
    (ambiguous ? '\nНеоднозначных совпадений по имени (пропущены): ' + ambiguous : ''));
  await refreshAll();
}

// ============================================================
// ВОРОНКА (СДЕЛКИ)
// ============================================================

function renderDeals() {
  const filterEl = document.getElementById('deals-project-filter');
  filterEl.innerHTML = ['Все'].concat(PROJECTS).map(p => {
    const val = p === 'Все' ? '' : p;
    const active = state.dealsFilterProject === val;
    return `<button class="${active ? 'active' : ''}" onclick="setDealsProjectFilter('${val}')">${esc(p)}</button>`;
  }).join('');

  const el = document.getElementById('kanban');
  let deals = state.deals;
  if (state.dealsFilterProject) deals = deals.filter(d => d.project === state.dealsFilterProject);

  el.innerHTML = STAGES.map(stage => {
    const items = deals.filter(d => d.stage === stage);
    return `
    <div class="kanban-col">
      <h4><span>${esc(stage)} (${items.length})</span></h4>
      ${items.length ? items.map(d => `
        <div class="deal-card">
          <div class="row">
            <strong onclick="openContactDetail('${d.contact_id}')" style="cursor:pointer;">${esc(contactName(d.contact_id))}</strong>
            <span class="pill">${esc(d.project)}</span>
          </div>
          <div class="deal-actions">
            <select onchange="moveDeal('${d.id}', this.value)" style="flex:1;">
              ${selectOptions(STAGES, d.stage)}
            </select>
            <button class="btn small secondary" onclick="openDealForm(${JSON.stringify(d).replace(/"/g,'&quot;')})">✎</button>
          </div>
        </div>
      `).join('') : '<div class="meta" style="padding:6px 0;">Пусто</div>'}
    </div>`;
  }).join('');
}

function setDealsProjectFilter(p) {
  state.dealsFilterProject = p;
  renderDeals();
}

async function moveDeal(id, stage) {
  await sb.from('deals').update({ stage, updated_at: new Date().toISOString() }).eq('id', id);
  await refreshAll();
}

function openDealForm(existing, presetContactId) {
  const d = existing || {};
  const contactOptions = state.contacts.map(c => `<option value="${c.id}" ${(d.contact_id || presetContactId) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  openModal(`
    <h2>${existing ? 'Редактировать сделку' : 'Новая сделка'}</h2>
    <div class="field"><label>Контакт *</label><select id="d-contact">${contactOptions}</select></div>
    <div class="field"><label>Проект</label><select id="d-project">${selectOptions(PROJECTS, d.project)}</select></div>
    <div class="field"><label>Этап</label><select id="d-stage">${selectOptions(STAGES, d.stage)}</select></div>
    <div class="modal-actions">
      <button class="btn secondary" onclick="closeModal()">Отмена</button>
      ${existing ? `<button class="btn danger" onclick="deleteDeal('${d.id}')">Удалить</button>` : ''}
      <button class="btn" onclick="saveDeal(${existing ? "'" + d.id + "'" : 'null'})">Сохранить</button>
    </div>
  `);
}

async function saveDeal(id) {
  const contact_id = document.getElementById('d-contact').value;
  if (!contact_id) { alert('Выберите контакт'); return; }
  const payload = {
    contact_id,
    project: document.getElementById('d-project').value,
    stage: document.getElementById('d-stage').value,
    updated_at: new Date().toISOString(),
  };
  if (id) await sb.from('deals').update(payload).eq('id', id);
  else await sb.from('deals').insert(payload);
  closeModal();
  await refreshAll();
}

async function deleteDeal(id) {
  if (!confirm('Удалить сделку?')) return;
  await sb.from('deals').delete().eq('id', id);
  closeModal();
  await refreshAll();
}

// ============================================================
// ЗАДАЧИ И ВСТРЕЧИ
// ============================================================

function renderTasks() {
  const el = document.getElementById('tasks-list');
  const now = new Date();
  let items = state.tasks;
  if (state.tasksFilter === 'today') {
    items = items.filter(t => t.due_date && new Date(t.due_date).toDateString() === now.toDateString());
  } else if (state.tasksFilter === 'overdue') {
    items = items.filter(t => t.due_date && new Date(t.due_date) < now && !t.completed);
  } else if (state.tasksFilter === 'done') {
    items = items.filter(t => t.completed);
  }
  if (!items.length) {
    el.innerHTML = '<div class="empty">Задач нет</div>';
    return;
  }
  el.innerHTML = items.map(t => `
    <div class="card">
      <div class="row">
        <h3 style="${t.completed ? 'text-decoration:line-through;color:var(--hint);' : ''}">${t.kind === 'встреча' ? '🤝 ' : ''}${esc(t.title)}</h3>
        <input type="checkbox" ${t.completed ? 'checked' : ''} onchange="toggleTask('${t.id}', this.checked)">
      </div>
      <div class="meta">${t.due_date ? 'Срок: ' + fmtDateTime(t.due_date) : 'Без срока'} ${t.contact_id ? '· ' + esc(contactName(t.contact_id)) : ''} ${t.location ? '· ' + esc(t.location) : ''}</div>
      <div class="meta">${t.kind === 'встреча'
        ? (t.google_event_id ? '📅 синхронизировано с Google Calendar' : (t.due_date ? '📅 не синхронизировано' : ''))
        : (t.due_date ? (t.completed ? '' : (t.reminder_sent ? '🔔 напоминание отправлено' : '🔔 напомним в боте')) : '')}</div>
      <div class="link-row" onclick="deleteTask('${t.id}')">Удалить</div>
    </div>
  `).join('');
}

async function toggleTask(id, completed) {
  await sb.from('tasks').update({ completed }).eq('id', id);
  await refreshAll();
}
async function deleteTask(id) {
  if (!confirm('Удалить задачу?')) return;
  const task = state.tasks.find(t => t.id === id);
  if (task && task.google_event_id) {
    await callCalendarSync({ action: 'delete', google_event_id: task.google_event_id });
  }
  await sb.from('tasks').delete().eq('id', id);
  await refreshAll();
}

function openTaskForm(presetContactId, presetKind) {
  const contactOptions = state.contacts.map(c => `<option value="${c.id}" ${presetContactId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const kind = presetKind || 'задача';
  openModal(`
    <h2>${kind === 'встреча' ? 'Новая встреча' : 'Новая задача'}</h2>
    <div class="field"><label>Тип</label>
      <select id="tk-kind" onchange="document.getElementById('tk-location-field').style.display = this.value==='встреча' ? 'block':'none';">
        <option value="задача" ${kind === 'задача' ? 'selected' : ''}>Задача</option>
        <option value="встреча" ${kind === 'встреча' ? 'selected' : ''}>Встреча</option>
      </select>
    </div>
    <div class="field"><label>Название *</label><input id="tk-title"></div>
    <div class="field"><label>Контакт</label><select id="tk-contact"><option value="">— без контакта —</option>${contactOptions}</select></div>
    <div class="field"><label>Срок</label><input id="tk-due" type="datetime-local"></div>
    <div class="field" id="tk-location-field" style="display:${kind === 'встреча' ? 'block' : 'none'};"><label>Место встречи</label><input id="tk-location"></div>
    <div class="field"><label>Длительность (мин)</label><input id="tk-duration" type="number" value="30"></div>
    <p class="meta">${kind === 'встреча' ? 'Встреча со сроком автоматически появится в вашем Google Calendar (после подключения календаря).' : 'Если указан срок — перед задачей придёт напоминание в этот бот в Telegram.'}</p>
    <div class="modal-actions">
      <button class="btn secondary" onclick="closeModal()">Отмена</button>
      <button class="btn" onclick="saveTask()">Сохранить</button>
    </div>
  `);
}

async function saveTask() {
  const title = document.getElementById('tk-title').value.trim();
  if (!title) { alert('Укажите название'); return; }
  const contact_id = document.getElementById('tk-contact').value || null;
  const kind = document.getElementById('tk-kind').value;
  const location = document.getElementById('tk-location').value.trim();
  const duration_minutes = Number(document.getElementById('tk-duration').value) || 30;
  const dueRaw = document.getElementById('tk-due').value;
  const due_date = dueRaw ? new Date(dueRaw).toISOString() : null;

  const { data: inserted } = await sb.from('tasks').insert({
    title, contact_id, kind, location, duration_minutes, due_date,
  }).select('*').single();

  closeModal();

  // В Google Calendar попадают только встречи — обычные задачи вместо этого
  // напоминаются в Telegram-бота (см. Edge Function task-reminders).
  if (inserted && due_date && kind === 'встреча' && state.calendarConnected) {
    const contact = state.contacts.find(c => c.id === contact_id);
    const res = await callCalendarSync({
      action: 'upsert',
      title: 'Встреча: ' + title + (contact ? ' — ' + contact.name : ''),
      description: location || '',
      start: due_date,
      duration_minutes,
    });
    if (res && res.google_event_id) {
      await sb.from('tasks').update({ google_event_id: res.google_event_id }).eq('id', inserted.id);
    }
  }

  await refreshAll();
}

// ============================================================
// GOOGLE CALENDAR
// ============================================================

function functionsUrl(name) {
  return CONFIG.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/' + name;
}

async function refreshCalendarStatus() {
  const btn = document.getElementById('btn-calendar');
  if (!CONFIG.SUPABASE_URL) return;
  try {
    const res = await fetch(functionsUrl('calendar-status'), {
      headers: { Authorization: 'Bearer ' + CONFIG.SUPABASE_ANON_KEY },
    });
    const data = await res.json();
    state.calendarConnected = !!data.connected;
    state.calendarEmail = data.email || '';
  } catch (e) {
    state.calendarConnected = false;
  }
  btn.textContent = state.calendarConnected ? '📅 ' + (state.calendarEmail || 'подключен') : '📅 подключить';
}

function onCalendarButtonClick() {
  if (state.calendarConnected) {
    if (confirm('Google Calendar подключен' + (state.calendarEmail ? ' (' + state.calendarEmail + ')' : '') + '. Открыть страницу переподключения?')) {
      startGoogleAuth();
    }
    return;
  }
  startGoogleAuth();
}

function startGoogleAuth() {
  if (!CONFIG.GOOGLE_CLIENT_ID) {
    alert('Сначала впишите GOOGLE_CLIENT_ID в index.html (см. SETUP.md)');
    return;
  }
  const redirectUri = functionsUrl('google-oauth-callback');
  const scope = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email';
  const url = 'https://accounts.google.com/o/oauth2/v2/auth'
    + '?client_id=' + encodeURIComponent(CONFIG.GOOGLE_CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(redirectUri)
    + '&response_type=code'
    + '&access_type=offline'
    + '&prompt=consent'
    + '&scope=' + encodeURIComponent(scope);
  // Google блокирует OAuth внутри встроенного браузера Telegram,
  // поэтому ссылку обязательно открываем во внешнем системном браузере.
  if (tg && tg.openLink) {
    tg.openLink(url, { try_instant_view: false });
  } else {
    window.open(url, '_blank');
  }
}

async function callCalendarSync(payload) {
  try {
    const res = await fetch(functionsUrl('calendar-sync'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + CONFIG.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (e) {
    console.error('calendar-sync error', e);
    return null;
  }
}

// ============================================================
// МЕРОПРИЯТИЯ
// ============================================================

function renderEvents() {
  const el = document.getElementById('events-list');
  if (!state.events.length) {
    el.innerHTML = '<div class="empty">Мероприятий пока нет</div>';
    return;
  }
  el.innerHTML = state.events.map(ev => `
    <div class="card">
      <h3>${esc(ev.title)}</h3>
      <div class="meta">${ev.event_date ? fmtDateTime(ev.event_date) : 'Дата не указана'} ${ev.location ? '· ' + esc(ev.location) : ''}</div>
      <p style="font-size:14px;">${esc(ev.description || '')}</p>
      <div class="row">
        <span class="meta">Регистраций: <span id="regcount-${ev.id}">…</span></span>
        <button class="btn small secondary" onclick="shareEventLink('${ev.id}')">Ссылка регистрации</button>
      </div>
    </div>`).join('');
  state.events.forEach(ev => loadRegCount(ev.id));
}

async function loadRegCount(eventId) {
  const { count } = await sb.from('event_registrations').select('*', { count: 'exact', head: true }).eq('event_id', eventId);
  const elx = document.getElementById('regcount-' + eventId);
  if (elx) elx.textContent = count ?? 0;
}

function openEventForm() {
  openModal(`
    <h2>Новое мероприятие</h2>
    <div class="field"><label>Название *</label><input id="ev-title"></div>
    <div class="field"><label>Дата и время</label><input id="ev-date" type="datetime-local"></div>
    <div class="field"><label>Место</label><input id="ev-location"></div>
    <div class="field"><label>Описание</label><textarea id="ev-desc"></textarea></div>
    <div class="modal-actions">
      <button class="btn secondary" onclick="closeModal()">Отмена</button>
      <button class="btn" onclick="saveEvent()">Сохранить</button>
    </div>
  `);
}

async function saveEvent() {
  const title = document.getElementById('ev-title').value.trim();
  if (!title) { alert('Укажите название'); return; }
  const dueRaw = document.getElementById('ev-date').value;
  await sb.from('events').insert({
    title,
    event_date: dueRaw ? new Date(dueRaw).toISOString() : null,
    location: document.getElementById('ev-location').value.trim(),
    description: document.getElementById('ev-desc').value.trim(),
  });
  closeModal();
  await refreshAll();
}

function shareEventLink(eventId) {
  let link;
  if (CONFIG.BOT_USERNAME && CONFIG.MINIAPP_SHORTNAME) {
    link = `https://t.me/${CONFIG.BOT_USERNAME}/${CONFIG.MINIAPP_SHORTNAME}?startapp=event_${eventId}`;
  } else {
    link = `(впишите BOT_USERNAME и MINIAPP_SHORTNAME в index.html) startapp=event_${eventId}`;
  }
  if (tg && tg.showPopup) {
    tg.showPopup({ title: 'Ссылка на регистрацию', message: link, buttons: [{ type: 'close' }] });
  } else {
    alert(link);
  }
  if (navigator.clipboard) navigator.clipboard.writeText(link).catch(() => {});
}

// -------- Форма регистрации на мероприятие (по deep-link) --------

async function openRegisterView(eventId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-register').classList.add('active');
  document.getElementById('header-title').textContent = 'Регистрация';
  document.getElementById('fab-add').style.display = 'none';

  const { data: ev } = await sb.from('events').select('*').eq('id', eventId).single();
  const card = document.getElementById('register-card');
  if (!ev) {
    card.innerHTML = '<div class="empty">Мероприятие не найдено</div>';
    return;
  }
  const prefillName = tgUser ? [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') : '';
  const prefillTg = tgUser ? (tgUser.username || '') : '';

  card.innerHTML = `
    <h2>${esc(ev.title)}</h2>
    <div class="meta">${ev.event_date ? fmtDateTime(ev.event_date) : ''} ${ev.location ? '· ' + esc(ev.location) : ''}</div>
    <p style="font-size:14px;">${esc(ev.description || '')}</p>
    <div class="field"><label>Ваше имя *</label><input id="reg-name" value="${esc(prefillName)}"></div>
    <div class="field"><label>Телефон</label><input id="reg-phone"></div>
    <div class="field"><label>Кто пригласил?</label><input id="reg-referrer" placeholder="Имя того, кто позвал"></div>
    <div class="field"><label>Точно сможешь прийти?</label>
      <select id="reg-will-come">
        <option value="Да, буду">Да, буду</option>
        <option value="Скорее всего да">Скорее всего да</option>
        <option value="Под вопросом">Под вопросом</option>
      </select>
    </div>
    <div class="field"><label>Придёшь один(одна)?</label>
      <select id="reg-guest">
        <option value="Да">Да</option>
        <option value="Уже пригласил(а)">Уже пригласил(а)</option>
        <option value="Подумаю кого позвать">Подумаю кого позвать</option>
        <option value="Нет">Нет</option>
      </select>
    </div>
    <button class="btn block" onclick="submitRegistration('${eventId}', '${esc(prefillTg)}')">Зарегистрироваться</button>
  `;
}

async function submitRegistration(eventId, tgUsername) {
  const name = document.getElementById('reg-name').value.trim();
  const phone = document.getElementById('reg-phone').value.trim();
  const referred_by = document.getElementById('reg-referrer').value.trim();
  const will_come = document.getElementById('reg-will-come').value;
  const bringing_guest = document.getElementById('reg-guest').value;
  if (!name) { alert('Укажите имя'); return; }

  let contactId = null;
  const tgId = tgUser ? String(tgUser.id) : null;
  if (tgId) {
    const { data: found } = await sb.from('contacts').select('id').eq('telegram_user_id', tgId).limit(1);
    if (found && found.length) contactId = found[0].id;
  }
  if (!contactId && phone) {
    const { data: found } = await sb.from('contacts').select('id').eq('phone', phone).limit(1);
    if (found && found.length) contactId = found[0].id;
  }
  if (!contactId) {
    const { data: inserted } = await sb.from('contacts').insert({
      name, phone, telegram_username: tgUsername || null,
      telegram_user_id: tgId, source: 'мероприятие',
    }).select('id').single();
    contactId = inserted ? inserted.id : null;
  }

  await sb.from('event_registrations').insert({
    event_id: eventId, contact_id: contactId, name, phone,
    telegram_username: tgUsername || null, telegram_user_id: tgId,
    referred_by, will_come, bringing_guest,
  });

  if (contactId) {
    await sb.from('touches').insert({ contact_id: contactId, type: 'регистрация', event_id: eventId });
  }

  document.getElementById('register-card').innerHTML = '<div class="empty">✅ Вы зарегистрированы! Можно закрыть окно.</div>';
  if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
}

// ============================================================
// СТАТИСТИКА
// ============================================================

function uniqueContactsByTouchTypes(types) {
  const set = new Set();
  state.touches.forEach(t => { if (types.includes(t.type)) set.add(t.contact_id); });
  return set.size;
}
function countTouchesByType(types) {
  return state.touches.filter(t => types.includes(t.type)).length;
}

function renderStats() {
  const totalContacts = state.contacts.length;
  const contactsWithTouch = new Set(state.touches.map(t => t.contact_id)).size;
  const reachedMeeting = uniqueContactsByTouchTypes(['первичная встреча', 'повторная встреча']);
  const attendedEvent = uniqueContactsByTouchTypes(['мероприятие']);
  const reached3 = uniqueContactsByTouchTypes(['первичная трёшка', 'повторная трёшка']);
  const registeredPeople = uniqueContactsByTouchTypes(['регистрация']);

  const totalTouches = state.touches.length;
  const meetingsPrimary = countTouchesByType(['первичная встреча']);
  const meetingsRepeat = countTouchesByType(['повторная встреча']);
  const meetingsEvent = countTouchesByType(['мероприятие']);
  const meetingsTotal = meetingsPrimary + meetingsRepeat + meetingsEvent;
  const threePrimary = countTouchesByType(['первичная трёшка']);
  const threeRepeat = countTouchesByType(['повторная трёшка']);
  const threeTotal = threePrimary + threeRepeat;
  const registrationsTotal = countTouchesByType(['регистрация']);

  document.getElementById('stat-grid').innerHTML = `
    <div class="card"><strong style="font-size:14px;">По клиентам</strong></div>
    <div class="stat-grid">
      <div class="stat-box"><div class="num">${totalContacts}</div><div class="label">Всего клиентов</div></div>
      <div class="stat-box"><div class="num">${contactsWithTouch}</div><div class="label">В работе</div></div>
      <div class="stat-box"><div class="num">${reachedMeeting}</div><div class="label">Дошли до встречи</div></div>
      <div class="stat-box"><div class="num">${attendedEvent}</div><div class="label">Были на мероприятии</div></div>
      <div class="stat-box"><div class="num">${reached3}</div><div class="label">Дошли до трёшки</div></div>
      <div class="stat-box"><div class="num">${registeredPeople}</div><div class="label">Регистраций (людей)</div></div>
    </div>
    <div class="card" style="margin-top:6px;"><strong style="font-size:14px;">По касаниям</strong></div>
    <div class="stat-grid">
      <div class="stat-box"><div class="num">${totalTouches}</div><div class="label">Всего касаний</div></div>
      <div class="stat-box"><div class="num">${meetingsTotal}</div><div class="label">Встреч всего</div></div>
      <div class="stat-box"><div class="num">${meetingsPrimary}</div><div class="label">— первичные</div></div>
      <div class="stat-box"><div class="num">${meetingsRepeat}</div><div class="label">— повторные</div></div>
      <div class="stat-box"><div class="num">${meetingsEvent}</div><div class="label">— на мероприятиях</div></div>
      <div class="stat-box"><div class="num">${threeTotal}</div><div class="label">Трёшек всего</div></div>
      <div class="stat-box"><div class="num">${threePrimary}</div><div class="label">— первичные</div></div>
      <div class="stat-box"><div class="num">${threeRepeat}</div><div class="label">— повторные</div></div>
      <div class="stat-box"><div class="num">${registrationsTotal}</div><div class="label">Регистраций (касаний)</div></div>
    </div>
  `;

  const byContact = {};
  state.touches.forEach(t => { byContact[t.contact_id] = (byContact[t.contact_id] || 0) + 1; });
  const top = Object.entries(byContact).sort((a, b) => b[1] - a[1]).slice(0, 5);
  document.getElementById('top-touches').innerHTML = top.length ? top.map(([cid, count]) =>
    `<div class="meta">${esc(contactName(cid))} — ${count}</div>`
  ).join('') : '<div class="meta">Пока нет данных</div>';

  const now = new Date();
  const upcoming = state.tasks.filter(t => !t.completed && t.due_date && new Date(t.due_date) >= now)
    .sort((a, b) => new Date(a.due_date) - new Date(b.due_date)).slice(0, 5);
  document.getElementById('upcoming-tasks').innerHTML = upcoming.length ? upcoming.map(t =>
    `<div class="meta">${fmtDateTime(t.due_date)} — ${esc(t.title)}</div>`
  ).join('') : '<div class="meta">Нет ближайших задач</div>';
}

// -------------------------- СТАРТ --------------------------
init();
