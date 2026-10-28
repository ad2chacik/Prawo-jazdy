# Prawo Jazdy B • Szybka Powtórka

Statyczna aplikacja PWA dla Maca i iPhone'a. Publikacja:
https://ad2chacik.github.io/Prawo-jazdy/

## Publikacja wspólnej bazy

1. Prześlij `data/questions.json` **albo** `data/questions.xlsx` do tego repozytorium. Format JSON: tablica pytań lub obiekt `{"questions": [...]}`.
2. Umieść pliki JPG/PNG/MP4 bezpośrednio w `media/`. Nazwy muszą odpowiadać kolumnie `Media` (najlepiej używaj małych liter). Jeśli pytanie wskazuje `xyz.wmv`, opublikuj `xyz.mp4`.
3. Po wejściu na stronę nowy użytkownik automatycznie pobiera bazę. Film jest pobierany dopiero, gdy pojawia się w pytaniu. Multimedia opublikowane w `media/` są odtwarzane strumieniowo, bez wcześniejszego pobierania całego filmu. Ręczny import multimediów nadal zapisuje je lokalnie do pracy offline.
4. Własny postęp i historia błędów zapisują się osobno na każdym urządzeniu w IndexedDB. Nie są wysyłane do GitHub ani synchronizowane między urządzeniami.

### Pola bazy

`Numer pytania`, `Pytanie`, `Odpowiedź A`, `Odpowiedź B`, `Odpowiedź C`, `Poprawna odp`, `Media`, `Liczba punktów`, `Kategorie`.

Import XLSX i ZIP działa offline dzięki lokalnej bibliotece JSZip. Ze względów bezpieczeństwa pojedynczy importowany ZIP ma limit 250 MiB oraz limity rozpakowywania. Duży folder multimediów importuj bezpośrednio jako folder na komputerze.

### Ważne ograniczenia

- Nowi użytkownicy pobierają bazę automatycznie. Dodaj `data/catalog.json` z polem `version` (np. `"072026"`), aby przy kolejnych publikacjach użytkownicy bazy online otrzymywali nowe wydanie. Identyfikatory niezmienionych pytań zachowują postęp; zmienione pytania tracą poprzedni status. Bazy importowane ręcznie nie są automatycznie zastępowane.
- Offline: interfejs i pobrane pytania są przechowywane lokalnie. Filmy z `media/` są odtwarzane przez internet. Aby oglądać je bez internetu, należy wcześniej ręcznie zaimportować multimedia (plikami, folderem lub ZIP). Nie obiecujemy automatycznego przechowywania 900 MB na iPhonie.
- GitHub Pages: zalecana maksymalna wielkość publikacji 1 GB i miękki limit transferu 100 GB/miesiąc. Wgrywanie przez stronę GitHub ogranicza pojedyncze pliki do 25 MiB.
- Przed publikacją oficjalnych filmów i zdjęć sprawdź prawa do redystrybucji. Gov.pl wyraźnie informuje, że niektóre zasoby są własnością osób trzecich.

Źródła: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits , https://www.gov.pl/web/gov/prawa-autorskie , https://www.gov.pl/web/infrastruktura/prawo-jazdy

## Tryb offline

Otwórz witrynę w Safari na iPhonie i wybierz **Udostępnij → Dodaj do ekranu początkowego**. Po pobraniu bazy przetestuj działanie przy wyłączonym internecie. Pamiętaj, że Safari może usunąć dane przy presji na pamięć; eksport postępu tworzy kopię zapasową.

## Konserwacja

Kod: `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`. Lokalny JSZip: `vendor/jszip.min.js`. Service Worker buforuje jedynie pliki interfejsu. Nie przechwytuje `data/`, `media/` ani żądań HTTP Range, aby nie dublować bazy i nie psuć natywnego streamingu.

## Architektura i testy

Opis komponentów, strategii danych i ograniczeń znajduje się w [`ARCHITECTURE.md`](ARCHITECTURE.md). Podstawowe testy regresji wykonuje GitHub Actions (`tests/smoke.cjs`). Testy jednostkowe nie zastępują sprawdzenia prawdziwego XLSX, zgodności nazw multimediów i Safari na iPhonie.

## Egzamin próbny

Tryb egzaminu stosuje 32 pytania i punktację 74/68 zgodnie z § 19 rozporządzenia. **Nie odtwarza państwowego limitu 25 minut ani czasu na poszczególne pytania.** To tryb treningowy, nie pełna symulacja ośrodka egzaminowania. Źródło: https://eli.gov.pl/api/acts/DU/2023/2659/text.html
