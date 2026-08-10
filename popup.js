/**
 * Edge RAM Saver — логика popup.
 *
 * Popup живёт только пока открыт, поэтому здесь нет ни опроса фона, ни таймеров:
 * состояние читается один раз при открытии, изменения сразу пишутся в storage.
 */

'use strict';

const SETTINGS_KEY = 'settings';

const DEFAULT_SETTINGS = {
  enabled: true,
  idleMinutes: 15,
  skipPinned: true,
  deepMediaCheck: true,
  skipFormInput: true,
  skipOffline: true,
  whitelist: []
};

/** Чекбоксы: id элемента совпадает с ключом настройки. */
const TOGGLES = ['enabled', 'skipPinned', 'deepMediaCheck', 'skipFormInput', 'skipOffline'];

const $ = (id) => document.getElementById(id);
const t = (key, subs) => chrome.i18n.getMessage(key, subs);

let settings = { ...DEFAULT_SETTINGS };
let currentHost = null;

/* ------------------------------------------------------------------ *
 *  Локализация: в HTML нельзя писать __MSG_*__, подставляем вручную
 * ------------------------------------------------------------------ */

function applyI18n() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
  }
}

/* ------------------------------------------------------------------ *
 *  Сохранение настроек
 * ------------------------------------------------------------------ */

let saveTimer = 0;

/** Пишем сразу; для поля ввода — с задержкой, чтобы не дёргать storage на каждый символ. */
function save({ debounce = false } = {}) {
  clearTimeout(saveTimer);
  if (!debounce) {
    chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    return;
  }
  saveTimer = setTimeout(() => chrome.storage.local.set({ [SETTINGS_KEY]: settings }), 250);
}

// Popup могут закрыть раньше, чем сработает debounce — дожимаем запись.
window.addEventListener('pagehide', () => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  }
});

/* ------------------------------------------------------------------ *
 *  Белый список
 * ------------------------------------------------------------------ */

/** "https://www.YouTube.com/watch?v=1" -> "youtube.com" */
function normalizeDomain(raw) {
  let value = raw.trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(value) ? value : null;
}

function renderWhitelist() {
  const list = $('whitelist');
  list.textContent = '';

  for (const domain of settings.whitelist) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = domain;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = t('whitelistRemove');
    remove.dataset.domain = domain; // читается делегированным обработчиком

    li.append(name, remove);
    list.append(li);
  }

  $('whitelistEmpty').hidden = settings.whitelist.length > 0;
  renderSiteButton();
}

function addDomain(domain) {
  if (!domain || settings.whitelist.includes(domain)) return;
  settings.whitelist = [...settings.whitelist, domain].sort();
  save();
  renderWhitelist();
}

function removeDomain(domain) {
  settings.whitelist = settings.whitelist.filter((item) => item !== domain);
  save();
  renderWhitelist();
}

/* ------------------------------------------------------------------ *
 *  Карточка текущего сайта
 * ------------------------------------------------------------------ */

function renderSiteButton() {
  const button = $('siteToggle');
  if (!currentHost) return;
  const listed = settings.whitelist.includes(currentHost);
  button.textContent = t(listed ? 'whitelistRemove' : 'whitelistAdd');
  button.hidden = false;
}

async function loadCurrentSite() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    $('host').textContent = t('noSite');
    return;
  }

  currentHost = new URL(url).hostname.replace(/^www\./, '');
  $('host').textContent = currentHost;

  if (tab.favIconUrl) {
    $('favicon').src = tab.favIconUrl;
    $('favicon').hidden = false;
  }
  renderSiteButton();
}

/* ------------------------------------------------------------------ *
 *  Статистика и паник-кнопка
 * ------------------------------------------------------------------ */

async function refreshStats() {
  const tabs = await chrome.tabs.query({});
  const sleeping = tabs.filter((tab) => tab.discarded).length;
  $('status').textContent = t('statsLine', [String(sleeping), String(tabs.length)]);
}

async function panic() {
  const button = $('panic');
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'panic' });
    $('status').textContent = t('panicDone', [String(response?.discarded ?? 0)]);
  } catch {
    // Popup закрыли раньше, чем фон ответил, — показывать уже нечего.
    await refreshStats();
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 *  Старт
 * ------------------------------------------------------------------ */

async function init() {
  applyI18n();

  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };

  // Чекбоксы
  for (const key of TOGGLES) {
    const input = $(key);
    input.checked = Boolean(settings[key]);
    input.addEventListener('change', () => {
      settings[key] = input.checked;
      save();
    });
  }

  // Таймер простоя
  const idle = $('idle');
  idle.value = settings.idleMinutes;
  idle.addEventListener('input', () => {
    const minutes = Math.min(1440, Math.max(1, Math.round(Number(idle.value) || 0)));
    if (!minutes) return;
    settings.idleMinutes = minutes;
    save({ debounce: true });
  });
  idle.addEventListener('blur', () => { idle.value = settings.idleMinutes; });

  // Белый список: один делегированный обработчик на весь список вместо N кнопок
  renderWhitelist();
  $('whitelist').addEventListener('click', (event) => {
    const domain = event.target.dataset?.domain;
    if (domain) removeDomain(domain);
  });

  $('addForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const field = $('domain');
    const domain = normalizeDomain(field.value);
    if (domain) {
      addDomain(domain);
      field.value = '';
    } else {
      field.select();
    }
  });

  $('siteToggle').addEventListener('click', () => {
    if (!currentHost) return;
    settings.whitelist.includes(currentHost) ? removeDomain(currentHost) : addDomain(currentHost);
  });

  $('panic').addEventListener('click', panic);

  await Promise.all([loadCurrentSite(), refreshStats()]);
}

init();
