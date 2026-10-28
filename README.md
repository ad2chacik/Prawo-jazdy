# Prawo Jazdy B • Szybka Powtórka

Statyczna aplikacja PWA dla Maca i iPhone'a. Publikacja:
https://ad2chacik.github.io/Prawo-jazdy/

## Publikacja wspólnej bazy

1. Prześlij `data/questions.json` **albo** `data/questions.xlsx` do tego repozytorium. Format JSON: tablica pytań lub obiekt `{"questions": [...]}`.
2. Umieść pliki JPG/PNG/MP4 bezpośrednio w `media/`. Nazwy muszą odpowiadać kolumnie `Media` (najlepiej używaj małych liter). Jeśli pytanie wskazuje `xyz.wmv`, opublikuj `xyz.mp4`.
3. Po wejściu na stronę nowy użytkownik automatycznie pobiera bazę. Film jest pobierany dopiero, gdy pojawia się w pytaniu. Mniejsze media (do 25 MiB) są zapisywane lokalnie po obejrzeniu.
4. Własny postęp i historia błędów zapisują się osobno na każdym urządzeniu w IndexedDB. Nie są wysyłane do GitHub ani synchronizowane między urządzeniami.

### Pola bazy

`Numer pytania`, `Pytanie`, `Odpowiedź A`, `Odpowiedź B`, `Odpowiedź C`, `Poprawna odp`, `Media`, `Liczba punktów`, `Kategorie`.

Import XLSX i ZIP działa offline dzięki lokalnej bibliotece JSZip.

### Ważne ograniczenia

- Automatyczne pobranie działa **tylko gdy użytkownik nie ma już lokalnej bazy**. Istniejące dane mają pierwszeństwo, co zabezpiecza zapisany postęp.
- Offline: interfejs i pobrane pytania są przechowywane lokalnie. Filmy są pobierane na żądanie. Duże filmy nie są automatycznie przechowywane w IndexedDB i wymagają internetu, chyba że zostały wcześniej ręcznie zaimportowane.
- GitHub Pages: zalecana maksymalna wielkość publikacji 1 GB i miękki limit transferu 100 GB/miesiąc. Wgrywanie przez stronę GitHub ogranicza pojedyncze pliki do 25 MiB.
- Przed publikacją oficjalnych filmów i zdjęć sprawdź prawa do redystrybucji. Gov.pl wyraźnie informuje, że niektóre zasoby są własnością osób trzecich.

Źródła: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits , https://www.gov.pl/web/gov/prawa-autorskie , https://www.gov.pl/web/infrastruktura/prawo-jazdy

## Tryb offline

Otwórz witrynę w Safari na iPhonie i wybierz **Udostępnij → Dodaj do ekranu początkowego**. Po pobraniu bazy przetestuj działanie przy wyłączonym internecie. Pamiętaj, że Safari może usunąć dane przy presji na pamięć; eksport postępu tworzy kopię zapasową.

## Konserwacja

Kod: `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`. Lokalny JSZip: `vendor/jszip.min.js`. Service Worker nie przechwytuje żądań HTTP Range ani /media/, aby nie psuć natywnego streamingu.
