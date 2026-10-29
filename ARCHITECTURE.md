# Architektura PWA: Prawo Jazdy B

## Cel i zasady

Aplikacja edukacyjna działająca na statycznym hostingu GitHub Pages.
Bez serwera aplikacyjnego, logowania, analityki i synchronizacji postępu między urządzeniami.
Dane publiczne (pytania i multimedia) są oddzielone od danych prywatnych użytkownika (postęp).

## Moduły

| Plik | Odpowiedzialność |
| --- | --- |
| `index.html` | Układ interfejsu, semantyka, dostępność, pierwsze uruchomienie, podgląd obrazów |
| `styles.css` | Responsywny wygląd, Safari/iPhone |
| `app.js` | Import, IndexedDB, logika nauki/egzaminu, prezentacja, multimedia |
| `sw.js` | Cache tylko powłoki aplikacji i fallback offline |
| `manifest.webmanifest` / `icon.svg` | Instalacja PWA |
| `vendor/jszip.min.js` | Lokalny parser ZIP potrzebny m.in. do XLSX |
| `tests/smoke.cjs` | Bezserwerowe testy regresji |
| `.github/workflows/verify.yml` | Sprawdzanie składni i testów po push |
| `data/questions.json` lub `data/questions.xlsx` | Publiczna baza pytań (po publikacji przez właściciela) |
| `data/catalog.json` | Opcjonalna wersja opublikowanej bazy do bezpiecznych aktualizacji |
| `data/media-map.json` | Generowana mapa nazwy pliku do jednej z dwóch stron Pages |
| `media/*.mp4`, `media/*.jpg` | Pierwsza część publicznych multimediów |
| `Prawo-jazdy-media/media/*` | Druga część publicznych multimediów na osobnej stronie Pages |
| `scripts/publish-media.sh` | Walidacja, równy podział, publikacja i kontrola obu wdrożeń |

## Przepływ danych

1. Na starcie IndexedDB jest odczytywana lokalnie.
2. Przy braku bazy aplikacja pobiera `data/questions.json`, potem `data/questions.xlsx`. Przy lokalnej bazie pochodzącej z publikacji sprawdza `data/catalog.json`; gdy `version` się zmieni, pobiera aktualną bazę. Baza ręcznie importowana nie jest automatycznie zastępowana.
3. Dane po normalizacji trafiają do IndexedDB, gdzie pozostają dostępne offline. Podczas aktualizacji zachowujemy postęp dla identyfikatorów o niezmienionej treści i odpowiedzi. Postęp pytań zmodyfikowanych jest resetowany. Aktualizacja, która usunęłaby ponad 20% pytań, jest wstrzymywana do ręcznej weryfikacji.
4. Każdy użytkownik ma osobny postęp przypisany do identyfikatorów pytań. Zapis jest kolejkowany, aby wcześniejsza transakcja nie nadpisała nowszego stanu.
5. Dla obrazów i filmów pierwszeństwo ma ręcznie zaimportowana kopia lokalna. W innym przypadku aplikacja pobiera `data/media-map.json` i wybiera `Prawo-jazdy/media/` albo `Prawo-jazdy-media/media/`. Przy braku mapy zachowuje zgodność wsteczną i próbuje głównego `media/`.
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
│   ├── catalog.json
│   └── media-map.json
├── media/
│   ├── nazwa-zdjecia.jpg
│   └── nazwa-filmu.mp4
└── tests/
    └── smoke.cjs
```

Druga część plików ma analogiczny katalog `media/` w repozytorium `Prawo-jazdy-media`. Mapa powstaje w tym samym przebiegu co publikacja i jest wysyłana do głównej aplikacji dopiero po potwierdzeniu wdrożenia dodatkowej strony.

## Egzamin próbny

Tryb egzaminu dobiera 20 pytań podstawowych (10 za 3 pkt, 6 za 2 pkt, 4 za 1 pkt)
oraz 12 specjalistycznych (6 za 3 pkt, 4 za 2 pkt, 2 za 1 pkt).
Maksimum wynosi 74 pkt, próg zdania 68 pkt. Ten rozkład odpowiada zasadom
opisanym w § 19 rozporządzenia dotyczącego egzaminowania.

**Ważne:** obecny tryb nie odtwarza ograniczeń czasu (25 minut ogółem,
ani limitów przypisanych pytaniom). Jest to **egzamin próbny** do nauki,
a nie pełna symulacja egzaminu państwowego. Nie sugerować inaczej w interfejsie.

Źródło: https://eli.gov.pl/api/acts/DU/2023/2659/text.html

## Niezmienniki i zgodność

- Nie zmieniać formatów zapisanych w IndexedDB bez migracji.
- Identyfikatory pytań muszą pozostać stabilne przy aktualizacjach bazy, inaczej postęp użytkownika może przestać pasować.
- Nazwy multimediów są normalizowane do małych liter i Unicode NFC. W katalogu publicznym należy zachować takie same nazwy.
- W przypadku `.wmv` aplikacja próbuje odtworzyć `.mp4` o identycznej nazwie bazowej.
- Mapa w wersji 1 wskazuje jedynie bazy HTTP(S); nazwy spoza kompletnej mapy nie są zgadywane między repozytoriami.
- Publikator odrzuca kolizje nazw, niezgodność z Excelem, liczbę inną niż 1702 i pliki ponad 100 MiB. Kopie sprawdza sumami SHA-256.
- Nie publikować plików multimedialnych bez upewnienia się, że wolno je redystrybuować.

## Stan wdrożenia i dalsze prace

- [x] Statyczny interfejs PWA
- [x] Import lokalny XLSX/CSV/JSON/ZIP
- [x] Automatyczny import przy braku lokalnej bazy
- [x] Własny postęp w IndexedDB
- [x] Strumieniowanie opublikowanych MP4
- [x] Ograniczony cache aplikacji
- [x] Publikacja rzeczywistego pliku XLSX kategorii B i wersji katalogu
- [ ] Uruchomienie `scripts/publish-media.sh` na kompletnym folderze 1702 multimediów po sprawdzeniu uprawnień
- [ ] E2E na fizycznym iPhonie, w tym połączenie/bez internetu
- [x] Kontrolowany mechanizm aktualizacji opublikowanej bazy przez `catalog.json`
- [ ] Testy z rzeczywistym XLSX w Safari i walidacja jakości kompletnego katalogu

## Referencje

- GitHub Pages limits: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- Service Worker: https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers
- Safari video: https://developer.apple.com/documentation/webkit/delivering-video-content-for-safari

## Responsywność i nawigacja

- Wyświetlacz główny ma `aspect-ratio: 16 / 10` na telefonie, tablecie i komputerze. To proporcja ramki, a nie pliku.
- `img` i `video` są osadzone w ramce z `object-fit: contain`, czarnym tłem i bez zmiany wysokości po wczytaniu.
- Filmy używają natywnego sterowania, `preload=metadata`, `muted` i `playsinline`; w Safari automatyczne odtwarzanie może zostać ograniczone, wtedy użytkownik naciska Play.
- Obrazy otwierają powiększony podgląd w natywnym `<dialog>`.
- Pierwsze uruchomienie pokazuje krótką instrukcję; po zamknięciu ustawienie `welcome_seen_v1` zapisuje się w IndexedDB. Pomoc można otworzyć ponownie z ustawień.
- Ręczny przycisk wyboru Excela usunięto. Baza jest wczytywana z `data/questions.json` lub `data/questions.xlsx` automatycznie, a import pakietu ZIP zostaje jako awaryjna funkcja lokalna.
- Publiczna baza musi zostać fizycznie opublikowana; zmiana samego interfejsu tego nie zastępuje.

## Układ pojedynczego pytania — wariant kompaktowy

Widok quizu wykorzystuje wysokość `100dvh` w Safari i układ CSS Grid. Najpierw ustalana jest wysokość menu, paska postępu, tekstu pytania, odpowiedzi i dolnych przycisków; pozostałe miejsce otrzymuje ramka multimediów. Obraz i film używają `object-fit: contain`, nie są kadrowane. Przy bardzo małym oknie lub wyjątkowo długiej treści dopuszczone jest przewijanie samego quizu, aby nie ucinać odpowiedzi.

Pytania podstawowe mają TAK/NIE w dwóch kolumnach. Specjalistyczne mają odpowiedzi A/B/C jedna pod drugą. Znacznik `! Ważne` występuje dla pytań za 3 punkty, bez redundantnego napisu `Kategoria B`.

Przycisk `Poprzednie` dotyczy **tylko nauki**: cofa do pytania już ocenionego w bieżącej sesji i pokazuje je w trybie odczytu. Nie zmienia ani nie przelicza postępu, a `Następne/Wróć do bieżącego` wraca do aktualnego pytania. Egzamin próbny nie pozwala na cofanie. Historia nawigacji jest sesyjna (nie jest zapisywana wraz z postępem).
