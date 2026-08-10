/**
 * Edge RAM Saver — service worker (Manifest V3).
 *
 * Идея: неактивные вкладки выгружаются из памяти через chrome.tabs.discard().
 * Вкладка остаётся в таб-баре (фавиконка + заголовок), но её renderer-процесс
 * убивается операционной системой; при клике страница перезагружается сама.
 *
 * Главное ограничение MV3: service worker живёт ~30 секунд простоя и умирает.
 * Поэтому НИКАКОГО состояния в переменных модуля (кроме кэша настроек, который
 * инвалидируется по storage.onChanged) и никаких setTimeout/setInterval —
 * только chrome.alarms и chrome.storage.
 */

'use strict';

/* ------------------------------------------------------------------ *
 *  Константы и настройки по умолчанию
 * ------------------------------------------------------------------ */

/** Имя единственного будильника. Повторное создание с тем же именем заменяет старый. */
const ALARM_NAME = 'ram-saver-sweep';

/** Префикс ключей активности в chrome.storage.session: "t<tabId>" -> timestamp. */
const ACTIVITY_PREFIX = 't';

/** Префикс указателя «активная вкладка окна»: "w<windowId>" -> tabId. */
const ACTIVE_PREFIX = 'w';

/** Ключ настроек в chrome.storage.local. */
const SETTINGS_KEY = 'settings';

/** Минимальная задержка будильника в MV3 — 1 минута (для распакованных расширений). */
const MIN_ALARM_DELAY_MIN = 1;

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,          // мастер-выключатель авто-выгрузки
  idleMinutes: 15,        // сколько вкладка должна простоять неактивной
  skipPinned: true,       // не трогать закреплённые вкладки
  deepMediaCheck: true,   // разовая инъекция: ищем играющее (в т.ч. беззвучное) видео
  skipFormInput: true,    // разовая инъекция: беречь незакоммиченный ввод в формах
  skipOffline: true,      // в оффлайне не выгружать — вкладка не сможет восстановиться
  whitelist: []           // домены, которые никогда не усыпляются
});

/* ------------------------------------------------------------------ *
 *  Настройки: кэш в памяти SW + инвалидация
 * ------------------------------------------------------------------ */

/**
 * Кэш живёт ровно столько же, сколько сам service worker. Это не утечка:
 * объект один, фиксированного размера, и обнуляется при любом изменении настроек.
 */
let cachedSettings = null;

async function getSettings() {
  if (cachedSettings) return cachedSettings;
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  cachedSettings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
  return cachedSettings;
}

// Настройки поменяли из popup — сбрасываем кэш и перевзводим будильник
// (например, таймер уменьшили с 60 до 5 минут — ждать час нельзя).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  cachedSettings = null;
  scheduleNextSweep();
});

/* ------------------------------------------------------------------ *
 *  Учёт активности вкладок (chrome.storage.session — только в RAM)
 * ------------------------------------------------------------------ */

const activityKey = (tabId) => ACTIVITY_PREFIX + tabId;
const activeKey = (windowId) => ACTIVE_PREFIX + windowId;

/** Отметить вкладку как «только что использованную» — сбрасывает её таймер. */
function touch(tabId) {
  if (typeof tabId !== 'number' || tabId < 0) return Promise.resolve();
  return chrome.storage.session.set({ [activityKey(tabId)]: Date.now() });
}

/** Забыть вкладку. Без этого множество timestamp'ов росло бы бесконечно. */
function forget(tabId) {
  return chrome.storage.session.remove(activityKey(tabId));
}

/* ------------------------------------------------------------------ *
 *  Вспомогательные функции
 * ------------------------------------------------------------------ */

/**
 * Хост без "www." для http/https-страниц. Для edge://, chrome://, file://,
 * страниц расширений и пустых URL возвращает null — такие вкладки мы не трогаем:
 * их выгрузка либо бесполезна, либо ломает состояние страницы.
 */
function hostOf(url) {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Короткая подпись вкладки для лога в консоли service worker'а. */
const shortTitle = (tab) => (tab.title || tab.url || '').slice(0, 45);

/** Домен в белом списке? Совпадение по хосту и по любому его поддомену. */
function isWhitelisted(host, whitelist) {
  return whitelist.some((entry) => host === entry || host.endsWith('.' + entry));
}

/**
 * Дешёвая синхронная проверка «вкладку в принципе можно усыпить?».
 * Никаких инъекций и обращений к странице — только поля объекта Tab.
 *
 * @returns {string|null} причина пропуска (для лога) либо null, если можно выгружать
 */
function skipReason(tab, settings) {
  if (!tab || typeof tab.id !== 'number') return 'нет id';
  if (tab.discarded) return 'уже спит';
  if (tab.active) return 'активная вкладка окна';
  if (tab.audible) return 'звучит';
  if (tab.status && tab.status !== 'complete') return 'ещё грузится';
  if (settings.skipPinned && tab.pinned) return 'закреплена';

  const host = hostOf(tab.url);
  if (!host) return 'служебная страница';
  if (isWhitelisted(host, settings.whitelist)) return 'белый список';

  return null;
}

const isEligible = (tab, settings) => skipReason(tab, settings) === null;

/* ------------------------------------------------------------------ *
 *  Проба страницы: одна инъекция вместо постоянного content-скрипта
 * ------------------------------------------------------------------ */

/**
 * Выполняется В КОНТЕКСТЕ СТРАНИЦЫ. Обязана быть самодостаточной:
 * никаких замыканий и внешних переменных — тело функции сериализуется.
 *
 * Возвращает { media, dirty }:
 *   media — реально проигрывается видео/аудио (ловит и замьюченное видео,
 *           которое флаг tab.audible не показывает), либо активны PiP/фуллскрин;
 *   dirty — на странице есть незакоммиченный пользовательский ввод.
 */
function probePage() {
  // --- 1. Проигрывание медиа ---
  let media = false;
  for (const el of document.querySelectorAll('video, audio')) {
    // readyState > 2 (HAVE_CURRENT_DATA) отсекает пустые заготовки плееров,
    // которые висят на странице в состоянии paused/без данных.
    if (!el.paused && !el.ended && el.readyState > 2) {
      media = true;
      break;
    }
  }
  if (!media && (document.pictureInPictureElement || document.fullscreenElement)) {
    media = true;
  }

  // --- 2. Незакоммиченный ввод ---
  // Сравниваем текущее значение с исходным (defaultValue/defaultChecked):
  // так предзаполненные сервером поля не считаются «грязными».
  // <select> намеренно не проверяем — сайты сплошь и рядом выставляют опции
  // скриптом, и он давал бы ложные срабатывания почти на каждой странице.
  let dirty = false;
  const IGNORED_TYPES = ['hidden', 'submit', 'button', 'reset', 'image', 'file'];

  for (const el of document.querySelectorAll('input, textarea, [contenteditable]')) {
    if (el.tagName === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      if (IGNORED_TYPES.includes(type)) continue;
      if (type === 'checkbox' || type === 'radio') {
        if (el.checked !== el.defaultChecked) { dirty = true; break; }
        continue;
      }
      if (el.value && el.value !== el.defaultValue) { dirty = true; break; }
    } else if (el.tagName === 'TEXTAREA') {
      if (el.value && el.value !== el.defaultValue) { dirty = true; break; }
    } else if (el.isContentEditable && el.textContent.trim()) {
      dirty = true;
      break;
    }
  }

  return { media, dirty };
}

/** Сколько ждём ответ пробы, прежде чем считать вкладку неотвечающей. */
const PROBE_TIMEOUT_MS = 1500;

const PROBE_TIMED_OUT = Symbol('probe-timed-out');

/**
 * Одна инъекция во все фреймы (allFrames важен: плееры YouTube/Vimeo на
 * сторонних сайтах живут во вложенном iframe). Постоянного content-скрипта
 * нет — код исполняется разово и сразу исчезает.
 *
 * Таймаут обязателен: вкладка, замороженная встроенным «Режимом эффективности»
 * Edge, скрипты не исполняет, и без гонки с таймером этот await не завершился бы
 * никогда — проход вис бы на первой же такой вкладке.
 *
 * setTimeout здесь допустим в отличие от планирования: он живёт только внутри
 * активного прохода, а не пытается пережить сон service worker'а.
 */
function probeTab(tabId) {
  const injection = chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: probePage,
    injectImmediately: true
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, PROBE_TIMEOUT_MS, PROBE_TIMED_OUT));
  return Promise.race([injection, timeout]);
}

/**
 * @returns {Promise<string|null>} причина пропуска либо null, если можно выгружать
 */
async function busyReason(tabId, settings) {
  let frames;
  try {
    frames = await probeTab(tabId);
  } catch (error) {
    // Страница запрещает инъекцию (Web Store, PDF-viewer, политика сайта).
    // Здесь остаёмся консервативными: не знаем, что на странице, — не трогаем.
    return `проба отклонена: ${error.message}`;
  }

  // Вкладка не ответила за отведённое время — она заморожена браузером.
  // Замороженная страница гарантированно ничего не проигрывает, а Edge уже
  // признал её ненужной. Именно такие вкладки и держат основную память
  // (заморозка heap не освобождает), поэтому выгружаем.
  if (frames === PROBE_TIMED_OUT) return null;

  for (const { result } of frames) {
    if (!result) continue;
    if (settings.deepMediaCheck && result.media) return 'играет медиа';
    if (settings.skipFormInput && result.dirty) return 'несохранённый ввод';
  }
  return null;
}

/* ------------------------------------------------------------------ *
 *  Основной проход
 * ------------------------------------------------------------------ */

/**
 * Единая точка выгрузки — используется и будильником, и паник-кнопкой.
 * @param {boolean} force — режим паник-кнопки: игнорировать мастер-выключатель
 *                          и таймер простоя, усыпить всё неактивное прямо сейчас.
 * @returns {Promise<number>} сколько вкладок реально выгружено
 */
async function sweep(force = false) {
  const settings = await getSettings();
  if (!settings.enabled && !force) return 0;

  // В оффлайне выгруженная вкладка при возврате покажет ошибку сети вместо
  // страницы — весь смысл «незаметности» теряется.
  if (settings.skipOffline && !navigator.onLine) return 0;

  const [tabs, activity] = await Promise.all([
    chrome.tabs.query({}),
    chrome.storage.session.get(null)
  ]);

  const now = Date.now();
  const idleMs = Math.max(1, settings.idleMinutes) * 60_000;
  const liveKeys = new Set();
  const seed = {};
  const candidates = [];

  // Что произошло с каждой вкладкой — выводится таблицей в консоль SW.
  const report = [];

  for (const tab of tabs) {
    const key = activityKey(tab.id);
    liveKeys.add(key);

    const stamp = activity[key];
    // Вкладку видим впервые (расширение только поставили / SW проснулся после
    // перезапуска браузера) — засчитываем ей текущее время, а не выгружаем разом.
    if (typeof stamp !== 'number') seed[key] = now;

    const reason = skipReason(tab, settings);
    if (reason) {
      if (reason !== 'уже спит') report.push({ вкладка: shortTitle(tab), итог: reason });
      continue;
    }

    const last = typeof stamp === 'number' ? stamp : now;
    if (force || now - last >= idleMs) {
      candidates.push(tab);
    } else {
      const left = Math.ceil((idleMs - (now - last)) / 60_000);
      report.push({ вкладка: shortTitle(tab), итог: `ждёт ещё ~${left} мин` });
    }
  }

  // Чистим ключи закрытых вкладок: страховка на случай пропущенного onRemoved
  // (например, вкладки закрылись, пока service worker спал).
  const stale = Object.keys(activity)
    .filter((key) => key.startsWith(ACTIVITY_PREFIX) && !liveKeys.has(key));

  await Promise.all([
    Object.keys(seed).length ? chrome.storage.session.set(seed) : null,
    stale.length ? chrome.storage.session.remove(stale) : null
  ]);

  const needsProbe = settings.deepMediaCheck || settings.skipFormInput;

  // Пробы идут параллельно: одна неотвечающая вкладка больше не задерживает
  // остальные. Раньше цикл был последовательным, и замороженная вкладка
  // подвешивала весь проход целиком.
  const probed = await Promise.all(candidates.map(async (tab) => ({
    tab,
    reason: needsProbe ? await busyReason(tab.id, settings) : null
  })));

  let discarded = 0;

  for (const { tab, reason } of probed) {
    if (reason) {
      // Вкладка занята — сбрасываем её таймер, чтобы не дёргать пробу каждую
      // минуту, пока пользователь смотрит двухчасовой фильм.
      await touch(tab.id);
      report.push({ вкладка: shortTitle(tab), итог: reason });
      continue;
    }
    try {
      await chrome.tabs.discard(tab.id);
      discarded++;
      report.push({ вкладка: shortTitle(tab), итог: 'ВЫГРУЖЕНА' });
    } catch (error) {
      // Гонка: вкладку успели закрыть или сделать активной.
      report.push({ вкладка: shortTitle(tab), итог: `discard не удался: ${error.message}` });
    }
  }

  console.log(
    `[RAM Saver] ${force ? 'паник-кнопка' : 'проход по таймеру'}: ` +
    `вкладок ${tabs.length}, кандидатов ${candidates.length}, выгружено ${discarded}`
  );
  if (report.length) console.table(report);

  await refreshBadge();
  await scheduleNextSweep();
  return discarded;
}

/* ------------------------------------------------------------------ *
 *  Планировщик: адаптивный одноразовый будильник
 * ------------------------------------------------------------------ */

/**
 * Вместо «тикать раз в минуту вечно» считаем ближайший момент, когда хоть одна
 * вкладка сможет быть выгружена, и просыпаемся ровно к нему. Если подходящих
 * вкладок нет вообще — будильник не создаётся, и SW не будит систему; его
 * перевзводит любое событие вкладок.
 */
async function scheduleNextSweep() {
  const settings = await getSettings();

  if (!settings.enabled) {
    await chrome.alarms.clear(ALARM_NAME);
    await refreshBadge();
    return;
  }

  const [tabs, activity] = await Promise.all([
    chrome.tabs.query({}),
    chrome.storage.session.get(null)
  ]);

  const now = Date.now();
  const idleMs = Math.max(1, settings.idleMinutes) * 60_000;
  let earliest = Infinity;

  for (const tab of tabs) {
    if (!isEligible(tab, settings)) continue;
    const stamp = activity[activityKey(tab.id)];
    const last = typeof stamp === 'number' ? stamp : now;
    earliest = Math.min(earliest, last + idleMs);
  }

  if (earliest === Infinity) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }

  const delayInMinutes = Math.max(MIN_ALARM_DELAY_MIN, (earliest - now) / 60_000);
  chrome.alarms.create(ALARM_NAME, { delayInMinutes });
}

/* ------------------------------------------------------------------ *
 *  Бейдж на иконке — счётчик спящих вкладок
 * ------------------------------------------------------------------ */

async function refreshBadge() {
  const sleeping = await chrome.tabs.query({ discarded: true });
  await chrome.action.setBadgeText({ text: sleeping.length ? String(sleeping.length) : '' });
}

/* ------------------------------------------------------------------ *
 *  Инициализация
 * ------------------------------------------------------------------ */

/** Проставить всем открытым вкладкам текущее время (старт браузера / установка). */
async function seedAll() {
  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  const entries = {};
  for (const tab of tabs) {
    entries[activityKey(tab.id)] = now;
    if (tab.active) entries[activeKey(tab.windowId)] = tab.id;
  }
  if (Object.keys(entries).length) await chrome.storage.session.set(entries);
}

async function init() {
  await chrome.action.setBadgeBackgroundColor({ color: '#4c6ef5' });
  await seedAll();
  await refreshBadge();
  await scheduleNextSweep();
}

chrome.runtime.onInstalled.addListener(async () => {
  // Записываем дефолты явно, чтобы popup сразу увидел заполненные поля.
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  if (!stored[SETTINGS_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS } });
  }
  await init();
});

chrome.runtime.onStartup.addListener(init);

/* ------------------------------------------------------------------ *
 *  События вкладок и окон
 * ------------------------------------------------------------------ */

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  // Ключевой момент: таймер простоя вкладки должен отсчитываться с момента, когда
  // её ПОКИНУЛИ, а не когда открыли. Поэтому при переключении сначала штампуем
  // предыдущую активную вкладку окна — иначе вкладка, на которой пользователь
  // просидел час, стала бы кандидатом на выгрузку сразу после ухода с неё.
  const key = activeKey(windowId);
  const stored = await chrome.storage.session.get(key);
  const previous = stored[key];

  if (typeof previous === 'number' && previous !== tabId) await touch(previous);

  await chrome.storage.session.set({ [key]: tabId, [activityKey(tabId)]: Date.now() });
  scheduleNextSweep();
});

chrome.tabs.onCreated.addListener((tab) => {
  touch(tab.id).then(scheduleNextSweep);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  // Вкладку выгрузили или пользователь её разбудил — поправляем счётчик на иконке.
  if (changeInfo.discarded !== undefined) {
    await refreshBadge();
    if (changeInfo.discarded) return; // спящая вкладка таймер не набирает
  }

  // Реагируем только на значимые изменения, иначе onUpdated сыплется десятками
  // событий на каждую загрузку страницы.
  const finishedLoading = changeInfo.status === 'complete';
  const audioChanged = changeInfo.audible !== undefined;
  const wokeUp = changeInfo.discarded === false;
  if (!finishedLoading && !audioChanged && !wokeUp) return;

  // Вкладка перестала звучать — даём ей полный таймер простоя заново,
  // а не выгружаем в ту же секунду, когда трек закончился.
  await touch(tabId);
  scheduleNextSweep();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await forget(tabId);
  await refreshBadge();
  scheduleNextSweep();
});

// Вкладку подменили (например, префетч-страницей): переносим отметку на новый id.
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  await forget(removedTabId);
  await touch(addedTabId);
  scheduleNextSweep();
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab) return;
  await chrome.storage.session.set({
    [activeKey(windowId)]: tab.id,
    [activityKey(tab.id)]: Date.now()
  });
  scheduleNextSweep();
});

// Окно закрыли — убираем его указатель, чтобы ключи не копились.
chrome.windows.onRemoved.addListener((windowId) => {
  chrome.storage.session.remove(activeKey(windowId));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) sweep(false);
});

/* ------------------------------------------------------------------ *
 *  Сообщения из popup
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'panic') {
    sweep(true).then((discarded) => sendResponse({ discarded }));
    return true; // ответ придёт асинхронно
  }

  if (message?.type === 'stats') {
    chrome.tabs.query({}).then((tabs) => {
      sendResponse({
        total: tabs.length,
        discarded: tabs.filter((tab) => tab.discarded).length
      });
    });
    return true;
  }

  return false;
});
