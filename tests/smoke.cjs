const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app.js', 'utf8');
const sandbox = {
  document: { addEventListener() {}, baseURI: 'https://example.org/Prawo-jazdy/' },
  console, URL, Blob, Date, Array, Set, Map, Math, Number, String
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'app.js' });
const exec = code => vm.runInContext(code, sandbox);
assert.equal(exec("normalizeFileName('X\\\\PICTURE.WMV')"), 'picture.wmv');
assert.equal(exec("publishedMediaURL('movie.mp4')"), 'https://example.org/Prawo-jazdy/media/movie.mp4');
assert.equal(exec("publishedMediaURL('../movie.mp4')"), 'https://example.org/Prawo-jazdy/media/movie.mp4');
assert.equal(exec("publishedMediaURL('evil.js')"), null);
assert.equal(exec("normalizeQuestion({'Pytanie':'test','Poprawna odp':'Z','Kategorie':'B'})"), null);
const valid = exec("normalizeQuestion({'Numer pytania':1,'Pytanie':'test','Poprawna odp':'T','Kategorie':'B'})");
assert.equal(valid['PrawdziwaKategoria'], 'PODSTAWOWY');
assert.equal(valid['Liczba punktów'], 1);
console.log('PASS: basic question validation and published-media path safety');
