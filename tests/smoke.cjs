'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function main() {
  const writes = [];
  const context = vm.createContext({
    document: {
      addEventListener() {},
      getElementById() { return null; },
      baseURI: 'https://example.org/Prawo-jazdy/'
    },
    console, URL, Blob, Date, Array, Set, Map, Math, Number, String,
    Promise, setTimeout, writes
  });
  vm.runInContext(fs.readFileSync('app.js', 'utf8'), context, { filename: 'app.js' });
  const run = code => vm.runInContext(code, context);

  assert.equal(run("normalizeFileName('X\\\\PICTURE.WMV')"), 'picture.wmv');
  assert.equal(run("publishedMediaURL('movie.mp4')"), 'https://example.org/Prawo-jazdy/media/movie.mp4');
  assert.equal(run("publishedMediaURL('../movie.mp4')"), 'https://example.org/Prawo-jazdy/media/movie.mp4');
  assert.equal(run("publishedMediaURL('evil.js')"), null);
  assert.equal(run("normalizeQuestion({'Pytanie':'test','Poprawna odp':'Z','Kategorie':'B'})"), null);
  const valid = run("normalizeQuestion({'Numer pytania':1,'Pytanie':'test','Poprawna odp':'T','Kategorie':'B'})");
  assert.equal(valid['PrawdziwaKategoria'], 'PODSTAWOWY');
  assert.equal(valid['Liczba punktów'], 1);
  assert.equal(run("normalizeQuestion({'Pytanie':'test','Poprawna odp':'A','Kategorie':'B','PrawdziwaKategoria':'SPECJALISTYCZNY'})"), null);

  const csv = run("parseCSV('Pytanie;Odpowiedź A\\n\"A; B\";tak')");
  assert.equal(csv[0].Pytanie, 'A; B');

  // The browser should stream online video rather than wait for a full Blob.
  run('getMedia = async () => undefined');
  const online = await run("findMediaAsset('FOLDER/CLIP.MP4')");
  assert.equal(online.name, 'clip.mp4');
  assert.equal(online.url, 'https://example.org/Prawo-jazdy/media/clip.mp4');
  assert.equal(Object.hasOwn(online, 'blob'), false);
  const wmv = await run("findMediaAsset('video.wmv')");
  assert.equal(wmv.name, 'video.mp4');

  // In-flight writes must commit in submission order.
  run("kvSet = async (key, value) => { await new Promise(resolve => setTimeout(resolve, 3)); writes.push(JSON.stringify({correct: value.correct, lastQuestion: value.lastQuestionByTab.podstawowe})); }");
  await run("(async () => { progress.correct = ['first']; progress.lastQuestionByTab.podstawowe = 'q1'; const first = saveProgress(); progress.correct = ['second']; progress.lastQuestionByTab.podstawowe = 'q2'; const second = saveProgress(); await Promise.all([first, second]); })()");
  assert.deepEqual(writes.map(item => JSON.parse(item)), [{correct:['first'],lastQuestion:'q1'},{correct:['second'],lastQuestion:'q2'}]);

  // The service worker should only intercept shell resources.
  const callbacks = {};
  const sw = vm.createContext({
    self: {
      registration: { scope: 'https://example.org/Prawo-jazdy/' },
      location: { origin: 'https://example.org' },
      addEventListener(name, callback) { callbacks[name] = callback; }
    },
    URL, Set, Promise, console,
    caches: { open: async () => ({}) },
    fetch: async () => ({ ok: true, type: 'basic', clone() { return this; } })
  });
  vm.runInContext(fs.readFileSync('sw.js', 'utf8'), sw, { filename: 'sw.js' });
  function intercepted(url, options = {}) {
    let called = false;
    const headers = new Map(Object.entries(options.headers || {}));
    callbacks.fetch({
      request: {
        method: 'GET', url, mode: options.mode || 'same-origin',
        headers: { has: key => headers.has(key) }
      },
      respondWith() { called = true; },
      waitUntil() {}
    });
    return called;
  }
  assert.equal(intercepted('https://example.org/Prawo-jazdy/data/questions.json'), false);
  assert.equal(intercepted('https://example.org/Prawo-jazdy/media/clip.mp4'), false);
  assert.equal(intercepted('https://example.org/Prawo-jazdy/app.js', { headers: { range: 'bytes=0-' } }), false);
  assert.equal(intercepted('https://example.org/Prawo-jazdy/app.js'), true);
  assert.equal(intercepted('https://example.org/Prawo-jazdy/', { mode: 'navigate' }), true);

  console.log('PASS: validation, CSV, paths, streaming, progress and service worker');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
