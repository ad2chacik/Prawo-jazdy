'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function main() {
  const writes = [];
  const publishedWrites = [];
  const createdElements = [];
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      textContent: '',
      classList: { add() {}, remove() {} }
    });
    return elements.get(id);
  }
  const context = vm.createContext({
    document: {
      addEventListener() {},
      getElementById: element,
      createElement(tagName) {
        const node = {
          tagName: tagName.toUpperCase(), src: '', preload: '', muted: false,
          playsInline: false, loadCalls: 0, pauseCalls: 0,
          load() { this.loadCalls++; }, pause() { this.pauseCalls++; },
          removeAttribute(name) { if (name === 'src') this.src = ''; }
        };
        createdElements.push(node);
        return node;
      },
      baseURI: 'https://example.org/Prawo-jazdy/'
    },
    console, URL, Blob, AbortController, Date, Array, Set, Map, Math, Number, String,
    Promise, setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 100)),
    clearTimeout, writes, publishedWrites,
    navigator: { connection: { saveData: false } },
    window: { JSZip: {} },
    fetch: async () => ({ ok: false })
  });
  vm.runInContext(fs.readFileSync('app.js', 'utf8'), context, { filename: 'app.js' });
  const run = code => vm.runInContext(code, context);

  assert.equal(run("normalizeFileName('X\\\\PICTURE.WMV')"), 'picture.wmv');
  assert.equal(run("publishedMediaURL('movie.mp4')"), 'https://example.org/Prawo-jazdy/media/movie.mp4');
  assert.equal(run("publishedMediaURL('../movie.mp4')"), 'https://example.org/Prawo-jazdy/media/movie.mp4');
  assert.equal(run("publishedMediaURL('evil.js')"), null);
  const mediaMap = run("normalizePublishedMediaMap({version:1,bases:{primary:'./media/',secondary:'https://example.org/Prawo-jazdy-media/media/'},files:{'MOVIE.MP4':'secondary','photo.jpg':'primary','evil.js':'secondary'}})");
  context.mediaMap = mediaMap;
  assert.equal(run("publishedMediaURL('movie.mp4', mediaMap)"), 'https://example.org/Prawo-jazdy-media/media/movie.mp4');
  assert.equal(run("publishedMediaURL('photo.jpg', mediaMap)"), 'https://example.org/Prawo-jazdy/media/photo.jpg');
  assert.equal(run("publishedMediaURL('missing.mp4', mediaMap)"), null);
  assert.equal(run("normalizePublishedMediaMap({version:2,bases:{primary:'./media/'},files:{}})"), null);
  assert.equal(run("normalizeQuestion({'Pytanie':'test','Poprawna odp':'Z','Kategorie':'B'})"), null);
  const valid = run("normalizeQuestion({'Numer pytania':1,'Pytanie':'test','Poprawna odp':'T','Kategorie':'B'})");
  assert.equal(valid['PrawdziwaKategoria'], 'PODSTAWOWY');
  assert.equal(valid['Liczba punktów'], 1);
  assert.equal(run("normalizeQuestion({'Pytanie':'test','Poprawna odp':'A','Kategorie':'B','PrawdziwaKategoria':'SPECJALISTYCZNY'})"), null);

  const csv = run("parseCSV('Pytanie;Odpowiedź A\\n\"A; B\";tak')");
  assert.equal(csv[0].Pytanie, 'A; B');

  // The browser should stream online video rather than wait for a full Blob.
  run('getMedia = async () => undefined; loadPublishedMediaMap = async () => null');
  const online = await run("findMediaAsset('FOLDER/CLIP.MP4')");
  assert.equal(online.name, 'clip.mp4');
  assert.equal(online.url, 'https://example.org/Prawo-jazdy/media/clip.mp4');
  assert.equal(Object.hasOwn(online, 'blob'), false);
  const wmv = await run("findMediaAsset('video.wmv')");
  assert.equal(wmv.name, 'video.mp4');

  run("loadPublishedMediaMap = async () => mediaMap");
  const mapped = await run("findMediaAsset('movie.mp4')");
  assert.equal(mapped.url, 'https://example.org/Prawo-jazdy-media/media/movie.mp4');
  assert.equal(await run("findMediaAsset('missing.mp4')"), null);
  const q1 = {_id:'q1', Media:'one.jpg'};
  const q2 = {_id:'q2', Media:'two.jpg'};
  context.q1 = q1;
  context.q2 = q2;
  assert.equal(run("nextQuestionInList([q1,q2], 0, false)._id"), 'q2');
  assert.equal(run("nextQuestionInList([q1,q2], 1, true)"), null);
  run("findMediaAsset = async name => ({name, url:'https://example.org/media/' + name, type:name.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4'})");
  await run("preloadQuestionMedia(q2, nextMediaPreloadToken)");
  assert.equal(createdElements.at(-1).tagName, 'IMG');
  assert.equal(createdElements.at(-1).src, 'https://example.org/media/two.jpg');
  run("cancelNextMediaPreload()");
  context.videoQuestion = {_id:'q3', Media:'three.mp4'};
  await run("preloadQuestionMedia(videoQuestion, nextMediaPreloadToken)");
  assert.equal(createdElements.at(-1).tagName, 'VIDEO');
  assert.equal(createdElements.at(-1).preload, 'auto');
  assert.equal(createdElements.at(-1).loadCalls, 1);

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

  // Published version updates must never overwrite manually imported question banks.
  assert.equal(run("resolveXlsxSheetPath('worksheets/sheet2.xml')"), 'xl/worksheets/sheet2.xml');
  assert.equal(run("resolveXlsxSheetPath('/xl/worksheets/sheet3.xml')"), 'xl/worksheets/sheet3.xml');
  assert.throws(() => run("parseXlsxXML('oops', {parseFromString() {return {documentElement:{localName:'parsererror'},getElementsByTagName() {return []}}}}, 'bad.xml')"), /Uszkodzony XML/);

  const Q = (id, question) => ({
    'Numer pytania': id, Pytanie: question, 'Poprawna odp': 'T',
    Kategorie: 'B', 'Liczba punktów': 3
  });
  const older = [Q('a', 'Unchanged'), Q('b', 'Old question')];
  const newer = [Q('a', 'Unchanged'), Q('b', 'Changed question')];
  context.publishedPayload = JSON.stringify(newer);
  run("questions = [normalizeQuestion(" + JSON.stringify(older[0]) + "), normalizeQuestion(" + JSON.stringify(older[1]) + ")]");
  run("progress = normalizeProgress({correct:['a','b'],errors:['b'],all_time_errors:['b'],lastQuestionByTab:{podstawowe:'b'}})");
  run("kvGet = async key => key === 'questions_meta' ? {source:'published',version:'v1'} : null");
  run("replaceStoredQuestions = async (rows, meta) => publishedWrites.push({ids:rows.map(q=>q._id), meta})");
  run("kvSet = async () => {}");
  run("fetch = async path => path.includes('catalog.json') ? {ok:true,json:async()=>({version:'v2'})} : path.includes('questions.json') ? {ok:true,headers:{get:()=>null},text:async()=>publishedPayload} : {ok:false}");
  assert.equal(await run('importPublishedQuestions()'), true);
  assert.equal(publishedWrites.length, 1);
  assert.equal(publishedWrites[0].meta.source, 'published');
  assert.equal(publishedWrites[0].meta.version, 'v2');
  assert.deepEqual(Array.from(run('progress.correct')), ['a']);
  assert.deepEqual(Array.from(run('progress.errors')), []);
  assert.equal(run('progress.lastQuestionByTab.podstawowe'), undefined);

  run("questions = [normalizeQuestion(" + JSON.stringify(older[0]) + ")]");
  run("kvGet = async key => key === 'questions_meta' ? {source:'manual'} : null");
  run("fetch = async () => { throw new Error('Manual database should never fetch'); }");
  assert.equal(await run('importPublishedQuestions()'), false);
  assert.equal(run('questions.length'), 1);

  // ZIP bombs and oversized archives must be rejected before JSZip expands data.
  run("window.JSZip = {loadAsync: async () => {throw new Error('ZIP was expanded unexpectedly');}}");
  await run("importPackage({size:251 * 1024 * 1024, name:'oversized.zip'})");
  assert.match(element('import-progress').textContent, /250 MiB/);

  // Responsive frontend and guide must remain in sync with JavaScript hooks.
  const html = fs.readFileSync('index.html', 'utf8');
  const styles = fs.readFileSync('styles.css', 'utf8');
  for (const id of [
    'welcome-dialog', 'welcome-close-btn', 'help-btn',
    'image-dialog', 'image-dialog-img', 'image-expand-btn',
    'image-close-btn', 'catalog-hint', 'media-img', 'media-video'
  ]) {
    assert.ok(html.includes('id="' + id + '"'), 'Missing frontend ID: ' + id);
  }
  assert.ok(!html.includes('id="questions-file"'), 'Excel picker should not return');
  assert.match(styles, /aspect-ratio:\s*16\s*\/\s*10/);
  assert.match(styles, /object-fit:\s*contain/);
  assert.match(styles, /background:\s*#000/);
  assert.match(styles, /height:\s*100dvh/);
  assert.match(styles, /grid-template-rows:\s*auto\s+minmax\(/);
  assert.match(styles, /\.answers-grid\.answers-basic\s*\{\s*grid-template-columns:\s*repeat\(2/);
  assert.match(styles, /\.continue-btn\.is-inactive/);
  for (const id of ['back-btn', 'continue-btn', 'review-label', 'points-badge']) {
    assert.ok(html.includes('id="' + id + '"'), 'Missing navigation ID: ' + id);
  }
  assert.ok(!html.includes('Kategoria B</span>'), 'Redundant category B badge returned');

  // Review previous answers without mutating stored progress or allowing a retry.
  run("currentTab = 'podstawowe'; answering = false; waitingForContinue = false; studyReview = null; studyHistory.podstawowe = []");
  run("showStudyReview = () => {}; showQuestion = () => {}");
  run("recordStudyAnswer({ _id:'first', 'Poprawna odp':'T' }, 'T', 'podstawowe')");
  run("recordStudyAnswer({ _id:'second', 'Poprawna odp':'N' }, 'T', 'podstawowe')");
  run("progress.correct = ['first']; progress.errors = ['second']");
  run("showPreviousQuestion()");
  assert.equal(run("studyReview.index"), 1);
  run("showPreviousQuestion()");
  assert.equal(run("studyReview.index"), 0);
  run("showNextOrContinue()");
  assert.equal(run("studyReview.index"), 1);
  run("showNextOrContinue()");
  assert.equal(run("studyReview"), null);
  assert.deepEqual(Array.from(run("progress.correct")), ['first']);
  assert.deepEqual(Array.from(run("progress.errors")), ['second']);
  run("currentTab = 'egzamin'; studyReview = null; showPreviousQuestion()");
  assert.equal(run("studyReview"), null);
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html), 'UI contains emoji');
  assert.match(html, /playsinline/);
  assert.match(html, /Dobra odpowiedź/);
  assert.match(html, /od razu przenosi do kolejnego pytania/);

  console.log('PASS: imports, progress, ZIP safety, service worker, responsive frontend and onboarding');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
