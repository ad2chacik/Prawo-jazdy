# Architektura PWA: Prawo Jazdy B

## Cel i zasady

Aplikacja edukacyjna działająca na statycznym hostingu GitHub Pages.
Bez serwera aplikacyjnego, logowania, analityki i synchronizacji postępu między urządzeniami.
Dane publiczne (pytania i multimedia) są oddzielone od danych prywatnych użytkownika (postęp).

## Moduły

| Plik | Odpowiedzialność |
| --- | --- |
| `index.html` | Układ interfejsu, semantyka, dostępność |
| `styles.css` | Responsywny wygląd, Safari/iPhone |
| `app.js` | Import, IndexedDB, logika nauki/egzaminu, prezentacja, multimedia |
| `sw.js` | Cache tylko powłoki aplikacji i fallback offline |
| `manifest.webmanifest` / `icon.svg` | Instalacja PWA |
| `vendor/jszip.min.js` | Lokalny parser ZIP potrzebny m.in. do XLSX |
| `tests/smoke.cjs` | Bezserwerowe testy regresji |
| `.github/workflows/verify.yml` | Sprawdzanie składni i testów po push |
| `data/questions.json` lub `data/questions.xlsx` | Publiczna baza pytań (po publikacji przez właściciela) |
| `data/catalog.json` | Opcjonalna wersja opublikowanej bazy do bezpiecznych aktualizacji |
| `media/*.mp4`, `media/*.jpg` | Publiczne multimedia (po publikacji przez właściciela) |

## Przepływ danych

1. Na starcie IndexedDB jest odczytywana lokalnie.
2. Przy braku bazy aplikacja pobiera `data/questions.json`, potem `data/questions.xlsx`. Przy lokalnej bazie pochodzącej z publikacji sprawdza `data/catalog.json`; gdy `version` się zmieni, pobiera aktualną bazę. Baza ręcznie importowana nie jest automatycznie zastępowana.
3. Dane po normalizacji trafiają do IndexedDB, gdzie pozostają dostępne offline. Podczas aktualizacji zachowujemy postęp dla identyfikatorów o niezmienionej treści i odpowiedzi. Postęp pytań zmodyfikowanych jest resetowany. Aktualizacja, która usunęłaby ponad 20% pytań, jest wstrzymywana do ręcznej weryfikacji.
4. Każdy użytkownik ma osobny postęp przypisany do identyfikatorów pytań. Zapis jest kolejkowany, aby wcześniejsza transakcja nie nadpisała nowszego stanu.
5. Dla obrazów i filmów pierwszeństwo ma ręcznie zaimportowana kopia lokalna. W innym przypadku następuje odczyt publicznego pliku z `media/` przez standardowe elementy `img` i `video`.
6. `video` odtwarza MP4 z obsługą natywnego HTTP Range. Duże pliki nie są automatycznie kopiowane do IndexedDB ani Cache API.
7. Service Worker przechowuje tylko elementy interfejsu. Nie przechwytuje `/media/`, `/data/` ani żądań `Range`.

## Struktura katalogów docelowych

```text
/
├── index.html
├── app.js
├── styles.css
├── sw.js
├── manifest.webmanifest
├── icon.svg
├── vendor/
│   ├── jszip.min.js
│   └── JSZIP-LICENSE.md
├── data/
│   ├── questions.json
│   └── catalog.json
├── media/
│   ├── nazwa-zdjecia.jpg
│   └── nazwa-filmu.mp4
└── tests/
    └── smoke.cjs
```

Pliki w `data/` i `media/` powyżej są **docelową strukturą**, a nie stwierdzeniem, że baza i multimedia zostały już opublikowane.

## Niezmienniki i zgodność

- Nie zmieniać formatów zapisanych w IndexedDB bez migracji.
- Identyfikatory pytań muszą pozostać stabilne przy aktualizacjach bazy, inaczej postęp użytkownika może przestać pasować.
- Nazwy multimediów są normalizowane do małych liter i Unicode NFC. W katalogu publicznym należy zachować takie same nazwy.
- W przypadku `.wmv` aplikacja próbuje odtworzyć `.mp4` o identycznej nazwie bazowej.
- Nie publikować plików multimedialnych bez upewnienia się, że wolno je redystrybuować.

## Stan wdrożenia i dalsze prace

- [x] Statyczny interfejs PWA
- [x] Import lokalny XLSX/CSV/JSON/ZIP
- [x] Automatyczny import przy braku lokalnej bazy
- [x] Własny postęp w IndexedDB
- [x] Strumieniowanie opublikowanych MP4
- [x] Ograniczony cache aplikacji
- [ ] Publikacja rzeczywistego `KATALOG_dla_kandydatów_na_kierowców_072026.xlsx` po sprawdzeniu kolumn i pytań
- [ ] Publikacja skompresowanego zestawu multimediów po sprawdzeniu wynikowego rozmiaru, nazw i uprawnień
- [ ] E2E na fizycznym iPhonie, w tym połączenie/bez internetu
- [x] Kontrolowany mechanizm aktualizacji opublikowanej bazy przez `catalog.json`
- [ ] Testy z rzeczywistym XLSX w Safari i walidacja jakości kompletnego katalogu

## Referencje

- GitHub Pages limits: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- Service Worker: https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers
- Safari video: https://developer.apple.com/documentation/webkit/delivering-video-content-for-safari
