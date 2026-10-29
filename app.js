'use strict';

const DB_NAME = 'prawko-pwa-db';
const DB_VERSION = 2;
const MEDIA_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'mp4', 'm4v', 'mov', 'webm', 'wmv']);
const PUBLISHED_QUESTION_PATHS = ['./data/questions.json', './data/questions.xlsx'];
const PUBLISHED_MEDIA_DIR = './media/';
const PUBLISHED_MEDIA_MAP_PATH = './data/media-map.json';
let answering = false;
let tabSwitchSequence = 0;
let historyGeneration = 0;
let progressWriteQueue = Promise.resolve();


const DEFAULT_PROGRESS = () => ({
  correct: [],
  errors: [],
  all_time_errors: [],
  lastTab: 'podstawowe',
  lastQuestionByTab: {}
});

const DEFAULT_SETTINGS = () => ({
  playbackRate: 1.5
});

let db;
let questions = [];
let questionMap = new Map();
let progress = DEFAULT_PROGRESS();
let settings = DEFAULT_SETTINGS();
let decks = { podstawowe: [], specjalistyczne: [], bledy: [] };
let indices = { podstawowe: 0, specjalistyczne: 0, bledy: 0 };
let currentTab = 'podstawowe';
let waitingForContinue = false;
let mediaLoadToken = 0;
let currentMediaUrl = null;
let historyObserver = null;
let historyUrls = new Set();
let installPrompt = null;
let publishedMediaMapPromise = null;

// Per-tab, in-memory history. Going back is a read-only review and must
// never undo or re-count an answer already saved in IndexedDB.
let studyHistory = { podstawowe: [], specjalistyczne: [], bledy: [] };
let studyReview = null;

let examQuestions = [];
let examAnswers = [];
let examIndex = 0;

const $ = id => document.getElementById(id);

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transakcja IndexedDB została przerwana.'));
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('kv')) database.createObjectStore('kv', { keyPath: 'key' });
      if (!database.objectStoreNames.contains('media')) database.createObjectStore('media', { keyPath: 'name' });
      if (!database.objectStoreNames.contains('questions')) database.createObjectStore('questions', { keyPath: '_id' });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onblocked = () => reject(new Error('Aktualizacja bazy jest zablokowana przez inną otwartą kartę aplikacji. Zamknij pozostałe karty i odśwież.'));
    request.onerror = () => reject(request.error);
  });
}

async function kvGet(key) {
  const tx = db.transaction('kv', 'readonly');
  const result = await requestToPromise(tx.objectStore('kv').get(key));
  return result ? result.value : undefined;
}

async function kvSet(key, value) {
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').put({ key, value });
  await transactionDone(tx);
}

async function kvDelete(key) {
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').delete(key);
  await transactionDone(tx);
}

async function countStoredQuestions() {
  const tx = db.transaction('questions', 'readonly');
  return requestToPromise(tx.objectStore('questions').count());
}

async function getAllStoredQuestions() {
  const tx = db.transaction('questions', 'readonly');
  const store = tx.objectStore('questions');
  if (typeof store.getAll === 'function') return requestToPromise(store.getAll());
  return new Promise((resolve, reject) => {
    const items = [];
    const request = store.openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(items);
      items.push(cursor.value);
      cursor.continue();
    };
  });
}

async function replaceStoredQuestions(records, metadata = {}) {
  const tx = db.transaction('questions', 'readwrite');
  const store = tx.objectStore('questions');
  store.clear();
  records.forEach(record => store.put(record));
  await transactionDone(tx);

  const storedCount = await countStoredQuestions();
  if (storedCount !== records.length) {
    throw new Error(`Błąd zapisu bazy: zapisano ${storedCount} z ${records.length} pytań.`);
  }
  await kvSet('questions_meta', { count: storedCount, updatedAt: Date.now(), source: metadata.source || 'manual', version: metadata.version || null });
}

async function clearStoredQuestions() {
  const tx = db.transaction('questions', 'readwrite');
  tx.objectStore('questions').clear();
  await transactionDone(tx);
  await kvDelete('questions');
  await kvDelete('questions_meta');
}

async function countMedia() {
  const tx = db.transaction('media', 'readonly');
  return requestToPromise(tx.objectStore('media').count());
}

async function getMedia(name) {
  const tx = db.transaction('media', 'readonly');
  return requestToPromise(tx.objectStore('media').get(normalizeFileName(name)));
}

async function clearMedia() {
  const tx = db.transaction('media', 'readwrite');
  tx.objectStore('media').clear();
  await transactionDone(tx);
}

async function putMediaRecords(records) {
  const chunkSize = 80;
  for (let start = 0; start < records.length; start += chunkSize) {
    const chunk = records.slice(start, start + chunkSize);
    const tx = db.transaction('media', 'readwrite');
    const store = tx.objectStore('media');
    chunk.forEach(record => store.put(record));
    await transactionDone(tx);
  }
}

function normalizeFileName(name) {
  return String(name || '').split(/[\\/]/).pop().trim().normalize('NFC').toLowerCase();
}

function extensionOf(name) {
  const normalized = normalizeFileName(name);
  const dot = normalized.lastIndexOf('.');
  return dot >= 0 ? normalized.slice(dot + 1) : '';
}

function isMediaFileName(name) {
  return MEDIA_EXTENSIONS.has(extensionOf(name));
}

function questionCategories(value) {
  return String(value || '')
    .split(/[;,]/)
    .map(v => v.trim().toUpperCase())
    .filter(Boolean);
}

function normalizeQuestion(raw, fallbackIndex = 0) {
  if (!raw || typeof raw !== 'object') return null;

  const questionText = String(raw['Pytanie'] ?? raw.question ?? '').trim();
  if (!questionText) return null;

  const categories = questionCategories(raw['Kategorie'] ?? raw.categories ?? 'B');
  if (categories.length && !categories.includes('B')) return null;

  const answerA = String(raw['Odpowiedź A'] ?? raw.answerA ?? '').trim();
  const answerB = String(raw['Odpowiedź B'] ?? raw.answerB ?? '').trim();
  const answerC = String(raw['Odpowiedź C'] ?? raw.answerC ?? '').trim();
  const correct = String(raw['Poprawna odp'] ?? raw.correct ?? '').trim().toUpperCase();
  if (!['T', 'N', 'A', 'B', 'C'].includes(correct)) return null;

  const rawNumber = raw['Numer pytania'] ?? raw.number ?? raw.id ?? '';
  const questionNumber = String(rawNumber).trim();
  const baseId = String(raw._id ?? questionNumber ?? '').trim() || `auto-${fallbackIndex + 1}`;

  let points = Number.parseInt(raw['Liczba punktów'] ?? raw.points, 10);
  if (![1, 2, 3].includes(points)) points = 1;

  let category = String(raw['PrawdziwaKategoria'] ?? raw.category ?? '').trim().toUpperCase();
  if (!['PODSTAWOWY', 'SPECJALISTYCZNY'].includes(category)) {
    category = (!answerA || correct === 'T' || correct === 'N') ? 'PODSTAWOWY' : 'SPECJALISTYCZNY';
  }

  if (category === 'PODSTAWOWY' && !['T', 'N'].includes(correct)) return null;
  if (category === 'SPECJALISTYCZNY' && !({A: answerA, B: answerB, C: answerC})[correct]) return null;

  return {
    _id: baseId,
    'Numer pytania': questionNumber || baseId,
    'Pytanie': questionText,
    'Odpowiedź A': answerA,
    'Odpowiedź B': answerB,
    'Odpowiedź C': answerC,
    'Poprawna odp': correct,
    'Media': String(raw['Media'] ?? raw.media ?? '').trim(),
    'Liczba punktów': points,
    'Kategorie': categories.length ? categories.join(',') : 'B',
    'PrawdziwaKategoria': category
  };
}

function buildQuestionDatabase(rows) {
  if (!Array.isArray(rows)) throw new Error('Plik nie zawiera tablicy pytań.');

  const uniqueContent = new Set();
  const usedIds = new Set();
  const clean = [];

  rows.forEach((row, index) => {
    const q = normalizeQuestion(row, index);
    if (!q) return;

    const contentKey = [q['Pytanie'], q['Odpowiedź A'], q['Odpowiedź B'], q['Odpowiedź C'], q['Poprawna odp'], q['Media']].join('\u241f');
    if (uniqueContent.has(contentKey)) return;
    uniqueContent.add(contentKey);

    const baseId = q._id;
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) id = `${baseId}__${suffix++}`;
    q._id = id;
    usedIds.add(id);
    clean.push(q);
  });

  if (!clean.length) throw new Error('Nie znaleziono pytań kategorii B. Sprawdź nagłówki i zawartość pliku.');
  return clean;
}

function normalizeProgress(value) {
  const source = value && typeof value === 'object' ? value : {};
  const arr = key => Array.from(new Set((Array.isArray(source[key]) ? source[key] : []).map(v => String(v))));
  return {
    correct: arr('correct'),
    errors: arr('errors'),
    all_time_errors: arr('all_time_errors'),
    lastTab: ['podstawowe', 'specjalistyczne', 'bledy', 'lista_bledow'].includes(source.lastTab) ? source.lastTab : 'podstawowe',
    lastQuestionByTab: source.lastQuestionByTab && typeof source.lastQuestionByTab === 'object' && !Array.isArray(source.lastQuestionByTab) ? { ...source.lastQuestionByTab } : {}
  };
}

function normalizeSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const rate = Number(source.playbackRate);
  return { playbackRate: [1, 1.25, 1.5, 1.75, 2].includes(rate) ? rate : 1.5 };
}

function reconcileProgress() {
  const valid = new Set(questions.map(q => q._id));
  progress.correct = progress.correct.filter(id => valid.has(id));
  progress.errors = progress.errors.filter(id => valid.has(id));
  progress.all_time_errors = progress.all_time_errors.filter(id => valid.has(id));
  Object.keys(progress.lastQuestionByTab).forEach(tab => {
    if (!valid.has(String(progress.lastQuestionByTab[tab]))) delete progress.lastQuestionByTab[tab];
  });
}

async function migrateLegacyIfNeeded() {
  if (await countStoredQuestions()) return;

  try {
    const oldIndexedQuestions = await kvGet('questions');
    if (Array.isArray(oldIndexedQuestions) && oldIndexedQuestions.length) {
      const migrated = buildQuestionDatabase(oldIndexedQuestions);
      await replaceStoredQuestions(migrated);
      await kvDelete('questions');
      showToast(`Przeniesiono bazę do nowego magazynu: ${migrated.length} pytań.`);
      return;
    }

    const legacyQuestionsRaw = localStorage.getItem('prawko_baza_kat_B_v3');
    if (!legacyQuestionsRaw) return;
    const migratedQuestions = buildQuestionDatabase(JSON.parse(legacyQuestionsRaw));
    await replaceStoredQuestions(migratedQuestions);

    const legacyProgressRaw = localStorage.getItem('prawko_progress');
    if (legacyProgressRaw) await kvSet('progress', normalizeProgress(JSON.parse(legacyProgressRaw)));
    showToast(`Przeniesiono starą bazę: ${migratedQuestions.length} pytań.`);
  } catch (error) {
    console.warn('Migracja starej wersji nie powiodła się:', error);
  }
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function sample(array, count) {
  if (array.length < count) return [];
  return shuffle([...array]).slice(0, count);
}

function moveResumeQuestionToFront(deck, tab) {
  const id = String(progress.lastQuestionByTab[tab] || '');
  if (!id) return;
  const index = deck.findIndex(q => q._id === id);
  if (index > 0) deck.unshift(deck.splice(index, 1)[0]);
}

function prepareDecks() {
  questionMap = new Map(questions.map(q => [q._id, q]));
  const correct = new Set(progress.correct);
  const errors = new Set(progress.errors);

  decks.podstawowe = shuffle(questions.filter(q => q['PrawdziwaKategoria'] === 'PODSTAWOWY' && !correct.has(q._id)));
  decks.specjalistyczne = shuffle(questions.filter(q => q['PrawdziwaKategoria'] === 'SPECJALISTYCZNY' && !correct.has(q._id)));
  decks.bledy = shuffle(questions.filter(q => errors.has(q._id)));

  moveResumeQuestionToFront(decks.podstawowe, 'podstawowe');
  moveResumeQuestionToFront(decks.specjalistyczne, 'specjalistyczne');
  moveResumeQuestionToFront(decks.bledy, 'bledy');

  indices = { podstawowe: 0, specjalistyczne: 0, bledy: 0 };
}

async function saveProgress() {
  progress = normalizeProgress(progress);
  // Separate persisted snapshot from mutable in-memory state, including nested objects.
  const snapshot = normalizeProgress(progress);
  // Serialize writes: a slower earlier transaction must never restore stale progress.
  progressWriteQueue = progressWriteQueue.catch(error => {
    console.warn('Poprzedni zapis postępu nie powiódł się:', error);
  }).then(() => kvSet('progress', snapshot));
  await progressWriteQueue;
  updateProgressStatus();
}

async function saveSettings() {
  settings = normalizeSettings(settings);
  await kvSet('settings', settings);
}

function showToast(message, duration = 2800) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('hidden'), duration);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

async function updateStorageStatus() {
  const status = $('storage-status');
  if (!navigator.storage) {
    status.textContent = 'Przeglądarka nie udostępnia informacji o pamięci.';
    $('persist-storage-btn').classList.add('hidden');
    return;
  }

  try {
    const estimate = navigator.storage.estimate ? await navigator.storage.estimate() : null;
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    const parts = [];
    if (estimate) parts.push(`${formatBytes(estimate.usage || 0)} zajęte z ok. ${formatBytes(estimate.quota || 0)}`);
    parts.push(persisted ? 'pamięć trwała: tak' : 'pamięć trwała: niepotwierdzona');
    status.textContent = parts.join(' • ');
    $('persist-storage-btn').textContent = persisted ? 'Dane zabezpieczone' : 'Zabezpiecz dane offline';
    $('persist-storage-btn').disabled = persisted;
  } catch {
    status.textContent = 'Nie udało się odczytać informacji o pamięci.';
  }
}

async function requestPersistentStorage(showResult = true) {
  if (!navigator.storage?.persist) {
    if (showResult) showToast('Ta przeglądarka nie udostępnia ręcznego trybu trwałej pamięci.');
    return false;
  }
  try {
    const granted = await navigator.storage.persist();
    if (showResult) showToast(granted ? 'Przeglądarka oznaczyła dane jako trwałe.' : 'Przeglądarka nie przyznała trwałej pamięci. Dane nadal są zapisane lokalnie.');
    await updateStorageStatus();
    return granted;
  } catch {
    if (showResult) showToast('Nie udało się zmienić trybu pamięci.');
    return false;
  }
}

async function refreshSetupStatus() {
  const mediaCount = await countMedia();
  $('question-count').textContent = String(questions.length);
  $('question-status').textContent = questions.length ? 'baza gotowa' : 'brak bazy';
  $('media-count').textContent = String(mediaCount);
  $('media-status').textContent = mediaCount ? 'zapisane na urządzeniu' : 'nie zapisano lokalnie';
  $('progress-count').textContent = String(progress.correct.length);

  $('start-btn').disabled = questions.length === 0;
  $('start-btn').textContent = questions.length ? 'Rozpocznij naukę' : 'Ładowanie bazy pytań…';
  $('export-questions-btn').disabled = questions.length === 0;
  $('clear-questions-btn').disabled = questions.length === 0;
  $('clear-media-btn').disabled = mediaCount === 0;
}

function updateProgressStatus() {
  if ($('progress-count')) $('progress-count').textContent = String(progress.correct.length);
}

function setImportProgress(text) {
  $('import-progress').textContent = text || '';
}

function parseCSV(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const candidates = [',', ';', '\t'];
  const delimiter = candidates.sort((a, b) => (firstLine.split(b).length - firstLine.split(a).length))[0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }

  const headers = (rows.shift() || []).map(h => h.trim().replace(/^\uFEFF/, ''));
  return rows
    .filter(r => r.some(v => String(v).trim() !== ''))
    .map(r => Object.fromEntries(headers.map((header, index) => [header, r[index] ?? ''])));
}

function columnIndexFromRef(ref) {
  const letters = String(ref || '').match(/^[A-Z]+/i)?.[0]?.toUpperCase() || '';
  let value = 0;
  for (const letter of letters) value = value * 26 + (letter.charCodeAt(0) - 64);
  return Math.max(0, value - 1);
}

function xmlTextContent(node) {
  return Array.from(node?.getElementsByTagName('t') || []).map(item => item.textContent || '').join('');
}

function parseXlsxXML(xml, parser, filename) {
  const parsed = parser.parseFromString(xml, 'application/xml');
  if (parsed.getElementsByTagName('parsererror').length || parsed.documentElement?.localName === 'parsererror') {
    throw new Error('Uszkodzony XML w arkuszu XLSX: ' + filename);
  }
  return parsed;
}

function resolveXlsxSheetPath(target) {
  // Relationship Target paths are relative to xl/workbook.xml.
  const path = new URL(String(target).replace(/\\/g, '/'),
    'https://xlsx.invalid/xl/').pathname.replace(/^\//, '');
  if (!path.startsWith('xl/worksheets/')) {
    throw new Error('Nieoczekiwana ścieżka arkusza XLSX.');
  }
  return path;
}

async function parseXLSXArrayBuffer(buffer) {
  if (!window.JSZip) throw new Error('Brak lokalnego modułu ZIP potrzebnego do odczytu XLSX.');
  if (buffer.byteLength > 25 * 1024 * 1024) throw new Error('Plik XLSX przekracza 25 MiB.');
  const zip = await JSZip.loadAsync(buffer);
  const unpackedSizes = Object.values(zip.files)
    .filter(item => !item.dir)
    .map(item => Number(item._data?.uncompressedSize));
  if (unpackedSizes.some(size => Number.isFinite(size) && size > 100 * 1024 * 1024) ||
      unpackedSizes.reduce((sum, size) => sum + (Number.isFinite(size) ? size : 0), 0) > 150 * 1024 * 1024) {
    throw new Error('XLSX jest zbyt duży po rozpakowaniu. Wczytaj mniejszą bazę.');
  }
  const parser = new DOMParser();

  const sharedStrings = [];
  const sharedEntry = zip.file('xl/sharedStrings.xml');
  if (sharedEntry) {
    const xml = parseXlsxXML(await sharedEntry.async('text'), parser, 'sharedStrings.xml');
    Array.from(xml.getElementsByTagName('si')).forEach(si => sharedStrings.push(xmlTextContent(si)));
  }

  let sheetPath = 'xl/worksheets/sheet1.xml';
  const workbookEntry = zip.file('xl/workbook.xml');
  const relsEntry = zip.file('xl/_rels/workbook.xml.rels');
  if (workbookEntry && relsEntry) {
    const workbook = parseXlsxXML(await workbookEntry.async('text'), parser, 'workbook.xml');
    const firstSheet = workbook.getElementsByTagName('sheet')[0];
    const relationshipId = firstSheet?.getAttribute('r:id') || firstSheet?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    if (relationshipId) {
      const rels = parseXlsxXML(await relsEntry.async('text'), parser, 'workbook.xml.rels');
      const relationship = Array.from(rels.getElementsByTagName('Relationship')).find(rel => rel.getAttribute('Id') === relationshipId);
      const target = relationship?.getAttribute('Target');
      if (target) {
        sheetPath = resolveXlsxSheetPath(target);
      }
    }
  }

  const sheetEntry = zip.file(sheetPath) || zip.file('xl/worksheets/sheet1.xml');
  if (!sheetEntry) throw new Error('Nie znaleziono pierwszego arkusza w pliku XLSX.');
  const sheet = parseXlsxXML(await sheetEntry.async('text'), parser, sheetPath);
  const parsedRows = [];

  Array.from(sheet.getElementsByTagName('row')).forEach(rowNode => {
    const row = [];
    let sequentialIndex = 0;
    Array.from(rowNode.getElementsByTagName('c')).forEach(cell => {
      const ref = cell.getAttribute('r');
      const index = ref ? columnIndexFromRef(ref) : sequentialIndex;
      sequentialIndex = index + 1;
      const type = cell.getAttribute('t') || '';
      const valueNode = cell.getElementsByTagName('v')[0];
      let value = '';
      if (type === 's') {
        const sharedIndex = Number.parseInt(valueNode?.textContent || '-1', 10);
        value = sharedStrings[sharedIndex] ?? '';
      } else if (type === 'inlineStr') {
        value = xmlTextContent(cell.getElementsByTagName('is')[0]);
      } else if (type === 'b') {
        value = valueNode?.textContent === '1' ? 'TRUE' : 'FALSE';
      } else {
        value = valueNode?.textContent ?? '';
      }
      row[index] = value;
    });
    parsedRows.push(row);
  });

  const headerRow = parsedRows.shift() || [];
  const headers = headerRow.map(value => String(value ?? '').trim().replace(/^\uFEFF/, ''));
  const rows = parsedRows
    .filter(row => row.some(value => String(value ?? '').trim() !== ''))
    .map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
  if (!headers.some(Boolean) || !rows.length) throw new Error('Arkusz XLSX jest pusty albo ma nieprawidłowy pierwszy wiersz nagłówków.');
  return rows;
}

async function parseQuestionsFile(file) {
  const ext = extensionOf(file.name);
  if (ext === 'json') {
    const parsed = JSON.parse(await file.text());
    return Array.isArray(parsed) ? parsed : parsed.questions;
  }
  if (ext === 'csv') return parseCSV(await file.text());
  if (ext === 'xlsx') return parseXLSXArrayBuffer(await file.arrayBuffer());
  if (ext === 'xls') throw new Error('Stary format .xls nie jest obsługiwany offline. Zapisz plik jako .xlsx, CSV albo JSON.');
  throw new Error('Nieobsługiwany format bazy pytań.');
}

async function replaceQuestions(rows, askBeforeReplace = true) {
  const clean = buildQuestionDatabase(rows);
  if (askBeforeReplace && questions.length && !confirm(`Zastąpić obecną bazę (${questions.length} pytań) nową bazą (${clean.length} pytań)?`)) return false;

  const previous = questions;
  await replaceStoredQuestions(clean, { source: 'manual' });
  questions = clean;
  const changed = forgetChangedQuestionProgress(previous, clean);
  reconcileProgress();
  await saveProgress();
  prepareDecks();
  await refreshSetupStatus();
  if (changed) showToast('Zmieniono ' + changed + ' pytań. Ich stary postęp został wyzerowany.');
  return true;
}

async function importQuestionFile(file) {
  if (!file) return;
  setImportProgress('Wczytywanie bazy pytań…');
  try {
    const rows = await parseQuestionsFile(file);
    if (await replaceQuestions(rows)) {
      setImportProgress(`Gotowe: ${questions.length} pytań.`);
      showToast(`Wczytano ${questions.length} pytań.`);
      requestPersistentStorage(false);
    } else {
      setImportProgress('Import anulowany.');
    }
  } catch (error) {
    console.error(error);
    setImportProgress(error.message || 'Nie udało się wczytać bazy.');
    showToast(error.message || 'Nie udało się wczytać bazy.', 5000);
  }
}

function mediaRecordFromFile(file) {
  return {
    name: normalizeFileName(file.name),
    blob: file,
    type: file.type || '',
    size: file.size || 0,
    updatedAt: Date.now()
  };
}

async function importMediaFiles(fileList) {
  const files = Array.from(fileList || []).filter(file => isMediaFileName(file.name));
  if (!files.length) {
    showToast('Nie znaleziono obsługiwanych zdjęć ani filmów.');
    return;
  }
  setImportProgress(`Zapisywanie ${files.length} plików…`);
  try {
    const records = files.map(mediaRecordFromFile);
    await putMediaRecords(records);
    setImportProgress(`Gotowe: zapisano ${files.length} plików. Duplikaty nazw zostały zastąpione.`);
    await refreshSetupStatus();
    requestPersistentStorage(false);
    showToast(`Zapisano ${files.length} plików multimedialnych.`);
  } catch (error) {
    console.error(error);
    setImportProgress('Nie udało się zapisać multimediów. Pamięć urządzenia może być pełna.');
    showToast('Błąd zapisu multimediów.', 5000);
  }
}

function mimeFromExtension(ext) {
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    heic: 'image/heic', heif: 'image/heif', mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', wmv: 'video/x-ms-wmv'
  };
  return map[ext] || 'application/octet-stream';
}

async function parseQuestionZipEntry(entry) {
  const ext = extensionOf(entry.name);
  if (ext === 'json') {
    const parsed = JSON.parse(await entry.async('text'));
    return Array.isArray(parsed) ? parsed : parsed.questions;
  }
  if (ext === 'csv') return parseCSV(await entry.async('text'));
  if (ext === 'xlsx') return parseXLSXArrayBuffer(await entry.async('arraybuffer'));
  if (ext === 'xls') throw new Error('Pakiet zawiera stary plik .xls. Zapisz bazę jako .xlsx, CSV albo JSON.');
  return null;
}

async function importPackage(file) {
  if (!file || !window.JSZip) return;
  setImportProgress('Otwieranie pakietu ZIP…');
  try {
    const MAX_ZIP_SIZE = 250 * 1024 * 1024;
    const MAX_ENTRY_SIZE = 50 * 1024 * 1024;
    const MAX_UNPACKED = 400 * 1024 * 1024;
    if (file.size > MAX_ZIP_SIZE) {
      throw new Error('ZIP przekracza 250 MiB. Na komputerze importuj folder; na iPhonie podziel pakiet na mniejsze części.');
    }
    const zip = await JSZip.loadAsync(file);
    const entries = Object.values(zip.files).filter(entry => !entry.dir);
    // JSZip exposes uncompressedSize on ZIP-backed entries. Check it before expansion.
    const knownSizes = entries.map(entry => Number(entry._data?.uncompressedSize));
    if (knownSizes.some(size => Number.isFinite(size) && size > MAX_ENTRY_SIZE) ||
        knownSizes.reduce((sum, size) => sum + (Number.isFinite(size) ? size : 0), 0) > MAX_UNPACKED) {
      throw new Error('ZIP po rozpakowaniu byłby zbyt duży. Zamiast ZIP wybierz folder z multimediami.');
    }
    const priority = name => {
      const base = normalizeFileName(name);
      if (base === 'questions.json' || base === 'pytania.json') return 0;
      if (base.endsWith('.json')) return 1;
      if (base.endsWith('.csv')) return 2;
      if (base.endsWith('.xlsx') || base.endsWith('.xls')) return 3;
      return 99;
    };
    const questionEntry = entries
      .filter(entry => ['json', 'csv', 'xlsx', 'xls'].includes(extensionOf(entry.name)))
      .sort((a, b) => priority(a.name) - priority(b.name))[0];

    let parsedQuestions = null;
    if (questionEntry) parsedQuestions = await parseQuestionZipEntry(questionEntry);
    if (parsedQuestions) {
      const replaced = await replaceQuestions(parsedQuestions, true);
      if (!replaced) {
        setImportProgress('Import pakietu anulowany.');
        return;
      }
    }

    const mediaEntries = entries.filter(entry => isMediaFileName(entry.name));
    let batch = [];
    for (let i = 0; i < mediaEntries.length; i++) {
      const entry = mediaEntries[i];
      setImportProgress(`Rozpakowywanie multimediów: ${i + 1} / ${mediaEntries.length}`);
      const ext = extensionOf(entry.name);
      const blob = await entry.async('blob');
      if (blob.size > MAX_ENTRY_SIZE) {
        throw new Error('Plik z ZIP przekracza 50 MiB: ' + entry.name);
      }
      batch.push({
        name: normalizeFileName(entry.name),
        blob: blob.type ? blob : blob.slice(0, blob.size, mimeFromExtension(ext)),
        type: blob.type || mimeFromExtension(ext),
        size: blob.size,
        updatedAt: Date.now()
      });
      if (batch.length >= 10) {
        await putMediaRecords(batch);
        batch = [];
      }
    }
    if (batch.length) await putMediaRecords(batch);

    await refreshSetupStatus();
    requestPersistentStorage(false);
    setImportProgress(`Pakiet gotowy: ${parsedQuestions ? questions.length + ' pytań, ' : ''}${mediaEntries.length} multimediów.`);
    showToast('Import pakietu zakończony.');
  } catch (error) {
    console.error(error);
    setImportProgress(error.message || 'Nie udało się otworzyć pakietu ZIP.');
    showToast(error.message || 'Błąd importu ZIP.', 5000);
  }
}

// Cap startup network waits so users always reach the manual-import screen.
async function fetchWithTimeout(url, timeoutMs = 8000, readBody = response => response) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: 'no-cache', signal: controller.signal });
    // Read the response while the deadline is active, not just its headers.
    return await readBody(response);
  } finally {
    clearTimeout(timer);
  }
}

async function readPublishedCatalog() {
  try {
    const manifest = await fetchWithTimeout('./data/catalog.json', 5000,
      response => response.ok ? response.json() : null);
    if (!manifest) return null;
    if (typeof manifest?.version !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(manifest.version)) {
      console.warn('data/catalog.json: brak poprawnego pola version.');
      return null;
    }
    return manifest.version;
  } catch (error) {
    console.warn('Nie udało się sprawdzić wersji bazy:', error);
    return null;
  }
}

function forgetChangedQuestionProgress(previous, next) {
  const before = new Map(previous.map(item => [item._id, item]));
  const fields = ['Pytanie', 'Odpowiedź A', 'Odpowiedź B', 'Odpowiedź C',
    'Poprawna odp', 'Media', 'Liczba punktów', 'PrawdziwaKategoria'];
  const changed = new Set();
  next.forEach(item => {
    const old = before.get(item._id);
    if (old && fields.some(field => String(old[field] ?? '') !== String(item[field] ?? ''))) {
      changed.add(item._id);
    }
  });
  for (const key of ['correct', 'errors', 'all_time_errors']) {
    progress[key] = progress[key].filter(id => !changed.has(id));
  }
  Object.keys(progress.lastQuestionByTab).forEach(tab => {
    if (changed.has(String(progress.lastQuestionByTab[tab]))) delete progress.lastQuestionByTab[tab];
  });
  return changed.size;
}

async function importPublishedQuestions() {
  const metadata = (await kvGet('questions_meta')) || {};
  const isUpdate = questions.length > 0;
  // Avoid an unnecessary network check for manually imported question banks.
  if (isUpdate && metadata.source !== 'published') return false;
  const version = await readPublishedCatalog();
  if (isUpdate && !(version && metadata.version !== version)) return false;

  if (!isUpdate) setImportProgress('Pobieranie opublikowanej bazy pytań…');
  for (const path of PUBLISHED_QUESTION_PATHS) {
    try {
      const payload = await fetchWithTimeout(path, 12000, async response => {
        if (!response.ok) return null;
        const declaredSize = Number(response.headers.get('content-length') || 0);
        if (declaredSize > 25 * 1024 * 1024) throw new Error('Opublikowana baza jest zbyt duża.');
        if (path.endsWith('.json')) {
          const raw = await response.text();
          if (new Blob([raw]).size > 25 * 1024 * 1024) throw new Error('Opublikowana baza JSON przekracza 25 MiB.');
          return JSON.parse(raw);
        }
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > 25 * 1024 * 1024) throw new Error('Opublikowany XLSX przekracza 25 MiB.');
        return buffer;
      });
      if (!payload) continue;
      const parsed = path.endsWith('.json') ? payload : await parseXLSXArrayBuffer(payload);
      const clean = buildQuestionDatabase(Array.isArray(parsed) ? parsed : parsed.questions);
      // A manual import may have completed while this network request was pending.
      if (!isUpdate && questions.length) return false;
      if (isUpdate) {
        const currentMetadata = (await kvGet('questions_meta')) || {};
        if (currentMetadata.source !== 'published' || currentMetadata.version !== metadata.version) return false;
      }
      if (isUpdate && clean.length < questions.length * 0.8) {
        throw new Error('Aktualizacja zawiera znacznie mniej pytań. Zachowano starszą bazę.');
      }
      const previous = questions;
      await replaceStoredQuestions(clean, { source: 'published', version });
      questions = clean;
      forgetChangedQuestionProgress(previous, clean);
      reconcileProgress();
      await saveProgress();
      prepareDecks();
      if (isUpdate) showToast('Zaktualizowano bazę pytań bez kasowania zachowanego postępu.');
      else setImportProgress('Pobrano ' + clean.length + ' pytań.');
      return true;
    } catch (error) {
      console.warn('Nie udało się pobrać ' + path, error);
    }
  }
  if (!isUpdate) setImportProgress('Baza online jest niedostępna. Możesz wczytać własny plik XLSX.');
  return false;
}

function normalizePublishedMediaMap(raw) {
  if (!raw || raw.version !== 1 || !raw.bases || !raw.files ||
      typeof raw.bases !== 'object' || typeof raw.files !== 'object') return null;

  const bases = {};
  for (const [key, value] of Object.entries(raw.bases)) {
    if (!key || typeof value !== 'string') continue;
    try {
      const url = new URL(value, document.baseURI);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      bases[key] = url.href.endsWith('/') ? url.href : url.href + '/';
    } catch { /* Ignore malformed bases. */ }
  }
  if (!Object.keys(bases).length) return null;

  const files = Object.create(null);
  for (const [rawName, location] of Object.entries(raw.files)) {
    const name = normalizeFileName(rawName);
    if (!name || !isMediaFileName(name) || !Object.hasOwn(bases, location)) continue;
    files[name] = location;
  }
  return { version: 1, bases, files };
}

async function loadPublishedMediaMap() {
  if (!publishedMediaMapPromise) {
    publishedMediaMapPromise = fetchWithTimeout(PUBLISHED_MEDIA_MAP_PATH, 5000,
      response => response.ok ? response.json() : null)
      .then(normalizePublishedMediaMap)
      .catch(error => {
        console.warn('Mapa multimediów jest niedostępna; używam głównego repozytorium.', error);
        return null;
      });
  }
  return publishedMediaMapPromise;
}

function publishedMediaURL(fileName, mediaMap = null) {
  const name = normalizeFileName(fileName);
  if (!name || name === '.' || name === '..' || !isMediaFileName(name)) return null;
  if (mediaMap) {
    const location = mediaMap.files[name];
    if (!location || !mediaMap.bases[location]) return null;
    return new URL(encodeURIComponent(name), mediaMap.bases[location]).href;
  }
  return new URL(PUBLISHED_MEDIA_DIR + encodeURIComponent(name), document.baseURI).href;
}

async function findMediaAsset(originalName) {
  const original = normalizeFileName(originalName);
  if (!original) return null;
  const candidates = original.endsWith('.wmv')
    ? [original.replace(/\.wmv$/i, '.mp4')] : [original];

  // Prefer explicitly imported files. These remain available offline.
  for (const name of candidates) {
    try {
      const record = await getMedia(name);
      if (record?.blob) return { name, blob: record.blob, type: record.type };
    } catch (error) {
      console.warn('Nie udało się odczytać lokalnych multimediów:', error);
    }
  }

  // Stream published files directly, so Safari can request video byte ranges.
  // Absence of a file is handled by the <img>/<video> error event.
  const mediaMap = await loadPublishedMediaMap();
  for (const name of candidates) {
    const url = publishedMediaURL(name, mediaMap);
    if (url) return { name, url, type: mimeFromExtension(extensionOf(name)) };
  }
  return null;
}

function downloadJSON(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function closeImageDialog() {
  const dialog = $('image-dialog');
  if (dialog?.open) dialog.close();
  $('image-dialog-img')?.removeAttribute('src');
}

function openWelcomeDialog() {
  const dialog = $('welcome-dialog');
  if (dialog && !dialog.open && typeof dialog.showModal === 'function') dialog.showModal();
}

async function maybeShowWelcomeDialog() {
  try {
    if (await kvGet('welcome_seen_v1') !== true) openWelcomeDialog();
  } catch (error) {
    console.warn('Nie udało się odczytać ustawień pierwszego uruchomienia:', error);
  }
}

function cleanupMediaUrl() {
  closeImageDialog();
  if (currentMediaUrl) {
    URL.revokeObjectURL(currentMediaUrl);
    currentMediaUrl = null;
  }
  const video = $('media-video');
  video.pause();
  video.removeAttribute('src');
  video.load();
  $('media-img').removeAttribute('src');
}

function resetMediaBox(message = 'Pytanie bez multimediów') {
  mediaLoadToken++;
  cleanupMediaUrl();
  $('media-video').classList.add('hidden');
  $('media-img').classList.add('hidden');
  $('replay-btn').classList.add('hidden');
  $('image-expand-btn').classList.add('hidden');
  $('media-text').textContent = message;
  $('media-text').classList.remove('hidden');
}

async function setMedia(name) {
  resetMediaBox('Ładowanie multimediów…');
  const token = mediaLoadToken;
  const originalName = String(name || '').trim();
  if (!originalName || originalName.toLowerCase() === 'nan') {
    resetMediaBox('Pytanie bez multimediów');
    return;
  }
  let asset;
  try {
    asset = await findMediaAsset(originalName);
  } catch (error) {
    console.warn('Nie udało się otworzyć multimediów:', error);
    if (token === mediaLoadToken) resetMediaBox('Błąd wczytywania multimediów');
    return;
  }
  if (token !== mediaLoadToken) return;
  if (!asset) {
    resetMediaBox('Brak pliku: ' + originalName);
    return;
  }
  cleanupMediaUrl();
  currentMediaUrl = asset.blob ? URL.createObjectURL(asset.blob) : null;
  const url = currentMediaUrl || asset.url;
  const ext = extensionOf(asset.name);
  if ((asset.type || '').startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'].includes(ext)) {
    const image = $('media-img');
    image.onload = () => {
      if (token !== mediaLoadToken) return;
      $('media-text').classList.add('hidden');
      $('image-expand-btn').classList.remove('hidden');
    };
    image.onerror = () => { if (token === mediaLoadToken) resetMediaBox('Nie udało się otworzyć: ' + originalName); };
    image.src = url;
    image.classList.remove('hidden');
    return;
  }
  const video = $('media-video');
  video.onloadedmetadata = () => {
    if (token === mediaLoadToken) $('media-text').classList.add('hidden');
  };
  video.onerror = () => { if (token === mediaLoadToken) resetMediaBox('Nie udało się otworzyć filmu: ' + originalName); };
  video.src = url;
  video.preload = 'metadata';
  video.controls = true;
  video.playbackRate = settings.playbackRate;
  video.classList.remove('hidden');
  $('replay-btn').classList.remove('hidden');
  video.load();
  try { await video.play(); } catch { /* Safari may require a tap */ }
}

function createAnswerButton(label, text, keyNumber, mode) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ans-btn';
  button.dataset.value = label;

  const key = document.createElement('span');
  key.className = 'answer-key';
  key.textContent = mode === 'basic' ? text : `${label}:`;
  button.appendChild(key);

  if (mode !== 'basic') button.appendChild(document.createTextNode(` ${text}`));

  const hint = document.createElement('span');
  hint.className = 'kb-hint';
  hint.textContent = `[${keyNumber}]`;
  button.appendChild(hint);

  button.addEventListener('click', event => handleAnswer(label, button, event));
  return button;
}

function renderAnswers(question, isExam) {
  const box = $('answers-box');
  box.replaceChildren();
  const category = question['PrawdziwaKategoria'];
  box.classList.toggle('answers-basic', category === 'PODSTAWOWY');
  box.classList.toggle('answers-special', category !== 'PODSTAWOWY');

  if (category === 'PODSTAWOWY') {
    box.appendChild(createAnswerButton('T', 'TAK', 1, 'basic'));
    box.appendChild(createAnswerButton('N', 'NIE', 2, 'basic'));
  } else {
    let key = 1;
    ['A', 'B', 'C'].forEach(letter => {
      const text = question[`Odpowiedź ${letter}`];
      if (text) box.appendChild(createAnswerButton(letter, text, key++, 'special'));
    });
  }

  box.dataset.mode = isExam ? 'exam' : 'study';
}

function recordStudyAnswer(question, choice, tab) {
  if (!studyHistory[tab]) return;
  studyHistory[tab].push({ question, choice });
  // Keep a bounded session history; learning progress itself remains in IndexedDB.
  if (studyHistory[tab].length > 200) studyHistory[tab].shift();
}

function updateQuizActions() {
  const back = $('back-btn');
  const next = $('continue-btn');
  const reviewing = studyReview && studyReview.tab === currentTab;
  const history = studyHistory[currentTab] || [];
  const allowed = currentTab !== 'egzamin' && currentTab !== 'lista_bledow';
  back.disabled = !allowed || answering || waitingForContinue ||
    (reviewing ? studyReview.index <= 0 : history.length === 0);
  const showNext = Boolean(reviewing || waitingForContinue);
  next.classList.toggle('is-inactive', !showNext);
  next.disabled = !showNext || answering;
  if (reviewing) {
    next.textContent = studyReview.index === history.length - 1
      ? 'Wróć do bieżącego' : 'Następne';
  } else {
    next.textContent = 'Dalej';
  }
}

function showStudyReview() {
  if (!studyReview || currentTab !== studyReview.tab) return;
  const entry = studyHistory[currentTab]?.[studyReview.index];
  if (!entry) return;
  const question = entry.question;
  $('review-label').classList.remove('hidden');
  $('points-badge').classList.toggle('hidden', question['Liczba punktów'] !== 3);
  if (question['Liczba punktów'] === 3) {
    $('points-badge').textContent = '! Ważne';
  }
  $('q-text').textContent = question['Pytanie'];
  renderAnswers(question, false);
  document.querySelectorAll('#answers-box .ans-btn').forEach(button => {
    button.disabled = true;
    if (button.dataset.value === question['Poprawna odp']) button.classList.add('correct');
    if (button.dataset.value === entry.choice && entry.choice !== question['Poprawna odp']) {
      button.classList.add('wrong');
    }
  });
  setMedia(question['Media']);
  updateQuizActions();
}

function showPreviousQuestion() {
  if (currentTab === 'egzamin' || currentTab === 'lista_bledow' ||
      waitingForContinue || answering) return;
  const history = studyHistory[currentTab] || [];
  if (!history.length) return;
  if (studyReview && studyReview.tab === currentTab) {
    if (studyReview.index <= 0) return;
    studyReview.index--;
  } else {
    studyReview = { tab: currentTab, index: history.length - 1 };
  }
  showStudyReview();
}

function showNextOrContinue() {
  if (studyReview && studyReview.tab === currentTab) {
    const history = studyHistory[currentTab] || [];
    if (studyReview.index < history.length - 1) {
      studyReview.index++;
      showStudyReview();
    } else {
      studyReview = null;
      $('review-label').classList.add('hidden');
      showQuestion();
    }
    return;
  }
  continueAfterError();
}

function setActiveNav(tab) {
  document.querySelectorAll('.nav-btn').forEach(button => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });
  document.querySelector(`.nav-btn[data-tab="${tab}"]`)?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function hideAllMainViews() {
  $('quiz-container').classList.add('hidden');
  $('history-container').classList.add('hidden');
  $('exam-result-container').classList.add('hidden');
}

function cleanupHistoryMedia() {
  historyGeneration++;
  historyObserver?.disconnect();
  historyObserver = null;
  historyUrls.forEach(url => URL.revokeObjectURL(url));
  historyUrls.clear();
}

async function switchTab(tab) {
  const switchId = ++tabSwitchSequence;
  mediaLoadToken++;
  cleanupMediaUrl();
  cleanupHistoryMedia();
  waitingForContinue = false;
  studyReview = null;
  $('review-label').classList.add('hidden');
  currentTab = tab;
  updateQuizActions();
  setActiveNav(tab);
  hideAllMainViews();

  if (tab !== 'egzamin') {
    progress.lastTab = tab;
    await saveProgress();
    if (switchId !== tabSwitchSequence) return;
  }

  if (tab === 'lista_bledow') {
    $('history-container').classList.remove('hidden');
    renderHistory();
    return;
  }

  $('quiz-container').classList.remove('hidden');
  if (tab === 'egzamin') {
    startExam();
    return;
  }

  $('progress-standard').classList.remove('hidden');
  $('progress-exam').classList.add('hidden');
  if (!decks[tab].length) {
    showCompletion();
    return;
  }
  showQuestion();
}

function showCompletion() {
  studyReview = null;
  $('review-label').classList.add('hidden');
  resetMediaBox('Gotowe');
  $('answers-box').replaceChildren();
  $('points-badge').classList.add('hidden');
  updateQuizActions();

  if (currentTab === 'bledy') {
    $('q-text').textContent = 'Nie masz obecnie żadnych błędów do poprawy.';
    $('progress-bar').max = 1;
    $('progress-bar').value = 1;
    $('progress-text').textContent = '0 błędów';
    return;
  }

  const category = currentTab === 'podstawowe' ? 'PODSTAWOWY' : 'SPECJALISTYCZNY';
  const categoryQuestions = questions.filter(q => q['PrawdziwaKategoria'] === category);
  const correctIds = new Set(progress.correct);
  const remaining = categoryQuestions.filter(q => !correctIds.has(q._id));
  const mastered = categoryQuestions.length - remaining.length;

  $('progress-bar').max = Math.max(categoryQuestions.length, 1);
  $('progress-bar').value = mastered;
  $('progress-text').textContent = `${mastered} / ${categoryQuestions.length}`;

  if (!remaining.length) {
    $('q-text').textContent = 'Wszystkie pytania z tej kategorii są oznaczone jako opanowane.';
    return;
  }

  $('q-text').textContent = `Koniec tej rundy. Pozostało ${remaining.length} pytań do opanowania.`;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'ans-btn';
  retry.textContent = `Powtórz nieopanowane (${remaining.length})`;
  retry.addEventListener('click', () => {
    decks[currentTab] = shuffle([...remaining]);
    indices[currentTab] = 0;
    showQuestion();
  });
  $('answers-box').appendChild(retry);
}

function updateStudyProgress(question, index, list) {
  if (currentTab === 'bledy') {
    const max = list.length;
    $('progress-bar').max = Math.max(max, 1);
    $('progress-bar').value = Math.min(index + 1, Math.max(max, 1));
    $('progress-text').textContent = `${Math.min(index + 1, max)} / ${max}`;
    return;
  }
  const category = question['PrawdziwaKategoria'];
  const categoryQuestions = questions.filter(q => q['PrawdziwaKategoria'] === category);
  const categoryIds = new Set(categoryQuestions.map(q => q._id));
  const mastered = progress.correct.filter(id => categoryIds.has(id)).length;
  $('progress-bar').max = Math.max(categoryQuestions.length, 1);
  $('progress-bar').value = mastered;
  $('progress-text').textContent = `${mastered} / ${categoryQuestions.length}`;
}

function showQuestion() {
  studyReview = null;
  $('review-label').classList.add('hidden');
  const isExam = currentTab === 'egzamin';
  const list = isExam ? examQuestions : decks[currentTab];
  const index = isExam ? examIndex : indices[currentTab];

  if (!list || index >= list.length) {
    if (!isExam && currentTab === 'bledy' && decks.bledy.length) {
      indices.bledy = 0;
      showQuestion();
    } else if (!isExam) {
      showCompletion();
    }
    return;
  }

  const question = list[index];
  if (!isExam) updateStudyProgress(question, index, list);

  if (isExam) {
    document.querySelectorAll('.ex-sq').forEach(sq => sq.classList.remove('active'));
    document.getElementById(`sq-${index}`)?.classList.add('active');
    $('points-badge').textContent = `${question['Liczba punktów']} pkt`;
    $('points-badge').classList.remove('hidden');
  } else if (question['Liczba punktów'] === 3) {
    $('points-badge').textContent = '! Ważne';
    $('points-badge').classList.remove('hidden');
  } else {
    $('points-badge').classList.add('hidden');
  }

  $('q-text').textContent = question['Pytanie'];
  waitingForContinue = false;
  renderAnswers(question, isExam);
  setMedia(question['Media']);
  updateQuizActions();

  if (!isExam) {
    progress.lastQuestionByTab[currentTab] = question._id;
    saveProgress().catch(console.error);
  }
}

function markCorrectness(correct, selectedButton) {
  document.querySelectorAll('.ans-btn').forEach(button => {
    button.disabled = true;
    if (button.dataset.value === correct) button.classList.add('correct');
  });
  selectedButton?.classList.add('wrong');
}

async function handleAnswer(choice, button, event) {
  event?.stopPropagation();
  if (waitingForContinue || answering || studyReview) return;
  answering = true;
  try {

  if (currentTab === 'egzamin') {
    const question = examQuestions[examIndex];
    if (!question) return;
    const correct = question['Poprawna odp'];
    examAnswers.push({
      question,
      choice,
      points: choice === correct ? question['Liczba punktów'] : 0,
      isCorrect: choice === correct
    });
    const square = document.getElementById(`sq-${examIndex}`);
    square?.classList.remove('active');
    square?.classList.add('done');
    examIndex++;
    if (examIndex >= examQuestions.length) await finishExam();
    else showQuestion();
    return;
  }

  const question = decks[currentTab]?.[indices[currentTab]];
  if (!question) return;
  const correct = question['Poprawna odp'];
  const isCorrect = choice === correct;
  const qId = question._id;
  const answerTab = currentTab;

  if (isCorrect) {
    if (!progress.correct.includes(qId)) progress.correct.push(qId);
    progress.errors = progress.errors.filter(id => id !== qId);
    decks.bledy = decks.bledy.filter(q => q._id !== qId);
  } else {
    if (!progress.errors.includes(qId)) progress.errors.push(qId);
    if (!progress.all_time_errors.includes(qId)) progress.all_time_errors.push(qId);
    progress.correct = progress.correct.filter(id => id !== qId);
    if (!decks.bledy.some(q => q._id === qId)) decks.bledy.push(question);
  }
  await saveProgress();
  if (currentTab !== answerTab) return;
  recordStudyAnswer(question, choice, answerTab);

  if (isCorrect) {
    if (currentTab === 'bledy') {
      decks.bledy = decks.bledy.filter(q => q._id !== qId);
    } else {
      indices[currentTab]++;
    }
    showQuestion();
  } else {
    markCorrectness(correct, button);
    waitingForContinue = true;
  }
  } finally {
    answering = false;
    updateQuizActions();
  }
}

function continueAfterError() {
  if (!waitingForContinue) return;
  waitingForContinue = false;
  indices[currentTab]++;
  showQuestion();
}

function examGroups() {
  return {
    p3: questions.filter(q => q['PrawdziwaKategoria'] === 'PODSTAWOWY' && q['Liczba punktów'] === 3),
    p2: questions.filter(q => q['PrawdziwaKategoria'] === 'PODSTAWOWY' && q['Liczba punktów'] === 2),
    p1: questions.filter(q => q['PrawdziwaKategoria'] === 'PODSTAWOWY' && q['Liczba punktów'] === 1),
    s3: questions.filter(q => q['PrawdziwaKategoria'] === 'SPECJALISTYCZNY' && q['Liczba punktów'] === 3),
    s2: questions.filter(q => q['PrawdziwaKategoria'] === 'SPECJALISTYCZNY' && q['Liczba punktów'] === 2),
    s1: questions.filter(q => q['PrawdziwaKategoria'] === 'SPECJALISTYCZNY' && q['Liczba punktów'] === 1)
  };
}

function startExam() {
  examAnswers = [];
  examIndex = 0;
  const groups = examGroups();
  const required = { p3: 10, p2: 6, p1: 4, s3: 6, s2: 4, s1: 2 };
  const missing = Object.entries(required)
    .filter(([key, count]) => groups[key].length < count)
    .map(([key, count]) => `${key.toUpperCase()}: ${groups[key].length}/${count}`);

  $('progress-standard').classList.add('hidden');
  $('progress-exam').classList.remove('hidden');

  if (missing.length) {
    $('progress-exam').replaceChildren();
    resetMediaBox('Egzamin niedostępny');
    $('q-text').textContent = `Baza nie zawiera wystarczającej liczby pytań do pełnego egzaminu. Braki: ${missing.join(', ')}.`;
    $('answers-box').replaceChildren();
    $('points-badge').classList.add('hidden');
    return;
  }

  const basics = shuffle([
    ...sample(groups.p3, 10),
    ...sample(groups.p2, 6),
    ...sample(groups.p1, 4)
  ]);
  const specials = shuffle([
    ...sample(groups.s3, 6),
    ...sample(groups.s2, 4),
    ...sample(groups.s1, 2)
  ]);
  examQuestions = [...basics, ...specials];

  const progressBox = $('progress-exam');
  progressBox.replaceChildren();
  examQuestions.forEach((_, index) => {
    if (index === 20) {
      const sep = document.createElement('div');
      sep.className = 'ex-sep';
      progressBox.appendChild(sep);
    }
    const square = document.createElement('div');
    square.className = 'ex-sq';
    square.id = `sq-${index}`;
    progressBox.appendChild(square);
  });
  showQuestion();
}

async function finishExam() {
  let points = 0;
  examAnswers.forEach(answer => {
    const id = answer.question._id;
    if (answer.isCorrect) {
      points += answer.points;
      if (!progress.correct.includes(id)) progress.correct.push(id);
      progress.errors = progress.errors.filter(item => item !== id);
    } else {
      if (!progress.errors.includes(id)) progress.errors.push(id);
      if (!progress.all_time_errors.includes(id)) progress.all_time_errors.push(id);
      progress.correct = progress.correct.filter(item => item !== id);
    }
  });
  await saveProgress();
  prepareDecks();
  if (currentTab !== 'egzamin') return;
  mediaLoadToken++;
  cleanupMediaUrl();

  hideAllMainViews();
  $('exam-result-container').classList.remove('hidden');
  const maxPoints = examQuestions.reduce((sum, q) => sum + q['Liczba punktów'], 0);
  $('exam-points').textContent = String(points);
  $('exam-max-points').textContent = String(maxPoints);
  const status = $('exam-status');
  status.className = points >= 68 ? 'result-pass' : 'result-fail';
  status.textContent = points >= 68 ? 'WYNIK POZYTYWNY' : 'WYNIK NEGATYWNY';

  const errors = examAnswers.filter(answer => !answer.isCorrect);
  $('exam-errors-heading').textContent = errors.length ? 'Błędy popełnione na egzaminie' : 'Bez błędów';
  const list = $('exam-errors-list');
  list.replaceChildren();
  if (errors.length) {
    setupLazyMediaObserver();
    errors.forEach(answer => list.appendChild(createErrorCard(answer.question, answer.question['Liczba punktów'])));
  }
}

function correctAnswerText(question) {
  const correct = question['Poprawna odp'];
  if (question['PrawdziwaKategoria'] === 'PODSTAWOWY') return correct === 'T' ? 'TAK' : 'NIE';
  return `${correct}: ${question[`Odpowiedź ${correct}`] || ''}`.trim();
}

function setupLazyMediaObserver() {
  historyObserver?.disconnect();
  if (typeof IntersectionObserver !== 'function') {
    historyObserver = null;
    return;
  }
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting || observer !== historyObserver) return;
      observer.unobserve(entry.target);
      loadCardMedia(entry.target, entry.target.dataset.mediaName).catch(console.error);
    });
  }, { rootMargin: '220px 0px' });
  historyObserver = observer;
}

async function loadCardMedia(container, originalName) {
  const generation = historyGeneration;
  if (!originalName) {
    container.textContent = 'Bez multimediów';
    return;
  }
  const asset = await findMediaAsset(originalName);
  if (generation !== historyGeneration || !container.isConnected) return;
  if (!asset) {
    container.textContent = 'Brak: ' + originalName;
    return;
  }
  const ext = extensionOf(asset.name);
  const url = asset.blob ? URL.createObjectURL(asset.blob) : asset.url;
  if (asset.blob) historyUrls.add(url);
  container.replaceChildren();
  if ((asset.type || '').startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'].includes(ext)) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.onerror = () => { if (generation === historyGeneration) container.textContent = 'Brak: ' + originalName; };
    container.appendChild(img);
  } else {
    const video = document.createElement('video');
    video.src = url;
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.controls = true;
    video.onerror = () => { if (generation === historyGeneration) container.textContent = 'Brak: ' + originalName; };
    video.addEventListener('play', () => { video.playbackRate = settings.playbackRate; });
    container.appendChild(video);
  }
}

function createErrorCard(question, lostPoints = null) {
  const item = document.createElement('article');
  item.className = 'error-item';

  const media = document.createElement('div');
  media.className = 'error-media';
  media.dataset.mediaName = question['Media'] || '';
  media.textContent = question['Media'] ? 'Ładowanie…' : 'Bez multimediów';
  item.appendChild(media);
  historyObserver?.observe(media);
  if (!historyObserver && media.dataset.mediaName) {
    requestAnimationFrame(() => {
      if (media.isConnected) loadCardMedia(media, media.dataset.mediaName).catch(console.error);
    });
  }

  const content = document.createElement('div');
  content.className = 'error-content';
  if (lostPoints != null) {
    const loss = document.createElement('div');
    loss.className = 'answer-line incorrect-answer';
    loss.textContent = `Strata: ${lostPoints} pkt`;
    content.appendChild(loss);
  }

  const questionText = document.createElement('div');
  questionText.className = 'error-question';
  questionText.textContent = question['Pytanie'];
  content.appendChild(questionText);

  if (question['PrawdziwaKategoria'] === 'PODSTAWOWY') {
    ['T', 'N'].forEach(value => {
      const line = document.createElement('div');
      line.className = `answer-line ${question['Poprawna odp'] === value ? 'correct-answer' : 'incorrect-answer'}`;
      line.textContent = value === 'T' ? 'TAK' : 'NIE';
      content.appendChild(line);
    });
  } else {
    ['A', 'B', 'C'].forEach(letter => {
      const text = question[`Odpowiedź ${letter}`];
      if (!text) return;
      const line = document.createElement('div');
      line.className = `answer-line ${question['Poprawna odp'] === letter ? 'correct-answer' : 'incorrect-answer'}`;
      line.textContent = `${letter}: ${text}`;
      content.appendChild(line);
    });
  }

  item.appendChild(content);
  return item;
}

function renderHistory() {
  const list = $('history-list');
  list.replaceChildren();
  const ids = new Set(progress.all_time_errors);
  const items = questions.filter(q => ids.has(q._id));
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'Brak zapisanych błędów.';
    list.appendChild(empty);
    return;
  }
  setupLazyMediaObserver();
  items.forEach(question => list.appendChild(createErrorCard(question)));
}

function enterApp(tab = progress.lastTab || 'podstawowe') {
  if (!questions.length) return;
  $('setup-screen').classList.add('hidden');
  $('app-screen').classList.remove('hidden');
  const safeTab = ['podstawowe', 'specjalistyczne', 'bledy', 'lista_bledow'].includes(tab) ? tab : 'podstawowe';
  switchTab(safeTab);
}

async function enterSetup() {
  tabSwitchSequence++;
  mediaLoadToken++;
  cleanupMediaUrl();
  cleanupHistoryMedia();
  $('app-screen').classList.add('hidden');
  $('setup-screen').classList.remove('hidden');
  await refreshSetupStatus();
  await updateStorageStatus();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function setupInstallFlow() {
  const button = $('install-btn');
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    button.classList.remove('hidden');
  });

  if (isIOS && !isStandalone) {
    button.classList.remove('hidden');
    button.textContent = 'Jak zainstalować na iPhonie';
  }

  button.addEventListener('click', async () => {
    if (installPrompt) {
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      button.classList.add('hidden');
    } else if (isIOS) {
      showToast('W Safari użyj Udostępnij → Do ekranu początkowego.', 5000);
    }
  });
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then(registration => registration.update())
      .catch(error => console.warn('Service Worker:', error));
  }
}

function bindEvents() {
  // Published questions are loaded automatically; no Excel picker is shown.
  $('media-files').addEventListener('change', event => {
    importMediaFiles(event.target.files);
    event.target.value = '';
  });
  $('media-folder').addEventListener('change', event => {
    importMediaFiles(event.target.files);
    event.target.value = '';
  });
  $('package-file').addEventListener('change', event => {
    importPackage(event.target.files?.[0]);
    event.target.value = '';
  });

  $('start-btn').addEventListener('click', () => enterApp(progress.lastTab));
  $('settings-btn').addEventListener('click', enterSetup);
  $('help-btn').addEventListener('click', openWelcomeDialog);
  $('welcome-close-btn').addEventListener('click', () => $('welcome-dialog').close());
  $('welcome-dialog').addEventListener('close', () => {
    kvSet('welcome_seen_v1', true).catch(error =>
      console.warn('Nie udało się zapisać ustawień pomocy:', error));
  });
  $('image-expand-btn').addEventListener('click', () => {
    const image = $('media-img');
    const dialog = $('image-dialog');
    if (image.classList.contains('hidden') || !image.src ||
        dialog.open || typeof dialog.showModal !== 'function') return;
    $('image-dialog-img').src = image.currentSrc || image.src;
    dialog.showModal();
  });
  $('image-close-btn').addEventListener('click', closeImageDialog);
  $('image-dialog').addEventListener('close', () =>
    $('image-dialog-img').removeAttribute('src'));
  document.querySelectorAll('.nav-btn').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
  $('continue-btn').addEventListener('click', showNextOrContinue);
  $('back-btn').addEventListener('click', showPreviousQuestion);

  $('replay-btn').addEventListener('click', async event => {
    event.stopPropagation();
    const video = $('media-video');
    if (video.classList.contains('hidden')) return;
    video.currentTime = 0;
    video.playbackRate = settings.playbackRate;
    try { await video.play(); } catch { /* user can tap again */ }
  });
  $('media-video').addEventListener('play', event => { event.currentTarget.playbackRate = settings.playbackRate; });

  $('speed-select').addEventListener('change', async event => {
    settings.playbackRate = Number(event.target.value);
    $('media-video').playbackRate = settings.playbackRate;
    await saveSettings();
  });

  $('export-questions-btn').addEventListener('click', () => {
    downloadJSON('prawko-pytania.json', { version: 1, exportedAt: new Date().toISOString(), questions });
  });
  $('export-progress-btn').addEventListener('click', () => {
    downloadJSON('prawko-postep.json', { version: 1, exportedAt: new Date().toISOString(), progress, settings });
  });
  $('progress-file').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      progress = normalizeProgress(data.progress ?? data);
      settings = normalizeSettings(data.settings ?? settings);
      reconcileProgress();
      await saveProgress();
      await saveSettings();
      prepareDecks();
      $('speed-select').value = String(settings.playbackRate);
      await refreshSetupStatus();
      showToast('Postęp został wczytany.');
    } catch {
      showToast('Nie udało się wczytać pliku postępu.');
    }
  });

  $('reset-progress-btn').addEventListener('click', async () => {
    if (!confirm('Zresetować cały postęp i historię błędów? Baza pytań i multimedia zostaną zachowane.')) return;
    progress = DEFAULT_PROGRESS();
    await saveProgress();
    prepareDecks();
    await refreshSetupStatus();
    showToast('Postęp zresetowany.');
  });

  $('clear-questions-btn').addEventListener('click', async () => {
    if (!confirm('Usunąć lokalną bazę pytań? Multimedia zostaną zachowane.')) return;
    questions = [];
    questionMap.clear();
    progress = DEFAULT_PROGRESS();
    await clearStoredQuestions();
    await saveProgress();
    prepareDecks();
    await refreshSetupStatus();
    showToast('Baza pytań usunięta.');
  });

  $('clear-media-btn').addEventListener('click', async () => {
    if (!confirm('Usunąć wszystkie zapisane lokalnie zdjęcia i filmy?')) return;
    await clearMedia();
    setImportProgress('Multimedia usunięte.');
    await refreshSetupStatus();
    showToast('Multimedia usunięte.');
  });

  $('persist-storage-btn').addEventListener('click', () => requestPersistentStorage(true));

  document.addEventListener('keydown', event => {
    if ($('app-screen').classList.contains('hidden') || $('quiz-container').classList.contains('hidden')) return;
    if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName)) return;
    if (studyReview) {
      if (event.key === 'ArrowLeft') { event.preventDefault(); showPreviousQuestion(); }
      if (event.key === 'ArrowRight') { event.preventDefault(); showNextOrContinue(); }
      return;
    }
    if (waitingForContinue) {
      if ((event.key === 'Enter' || event.key === ' ') && !target?.closest?.('button')) {
        event.preventDefault();
        continueAfterError();
      }
      return;
    }
    const isExam = currentTab === 'egzamin';
    const question = isExam ? examQuestions[examIndex] : decks[currentTab]?.[indices[currentTab]];
    if (!question) return;
    const keys = question['PrawdziwaKategoria'] === 'PODSTAWOWY' ? { '1': 'T', '2': 'N' } : { '1': 'A', '2': 'B', '3': 'C' };
    const value = keys[event.key];
    if (!value) return;
    const button = document.querySelector(`.ans-btn[data-value="${value}"]`);
    if (button && !button.disabled) {
      event.preventDefault();
      handleAnswer(value, button, event).catch(console.error);
    }
  });
}

async function init() {
  try {
    db = await openDatabase();
    await migrateLegacyIfNeeded();

    questions = await getAllStoredQuestions();
    progress = normalizeProgress(await kvGet('progress'));
    settings = normalizeSettings(await kvGet('settings'));
    questions = Array.isArray(questions) ? questions.map((q, i) => normalizeQuestion(q, i)).filter(Boolean) : [];
    reconcileProgress();
    await kvSet('progress', progress);
    await kvSet('settings', settings);
    prepareDecks();

    // Register user interactions before waiting for optional online data.
    bindEvents();
    setupInstallFlow();
    registerServiceWorker();
    maybeShowWelcomeDialog().catch(console.warn);
    $('speed-select').value = String(settings.playbackRate);
    await refreshSetupStatus();
    await updateStorageStatus();
    if (questions.length) {
      $('start-btn').disabled = true;
      $('start-btn').textContent = 'Sprawdzanie aktualizacji bazy…';
    }

    await importPublishedQuestions();
    await refreshSetupStatus();
    if (questions.length) {
      $('catalog-hint').textContent =
        'Baza pytań jest gotowa. Postęp pozostaje zapisany na tym urządzeniu.';
    } else {
      $('start-btn').textContent = 'Baza pytań niedostępna';
      $('question-status').textContent = 'nie udało się pobrać';
      $('catalog-hint').textContent =
        'Baza nie jest jeszcze opublikowana lub chwilowo niedostępna. Spróbuj później odświeżyć stronę.';
    }
    if (questions.length && $('app-screen').classList.contains('hidden')) {
      enterApp(progress.lastTab);
    }
  } catch (error) {
    console.error(error);
    $('question-status').textContent = 'błąd pamięci';
    showToast('Nie udało się uruchomić lokalnej bazy danych. Sprawdź tryb prywatny lub ustawienia Safari.', 7000);
  }
}

document.addEventListener('DOMContentLoaded', init);
