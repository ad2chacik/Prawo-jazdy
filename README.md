# Prawo Jazdy B — Szybka Powtórka

PWA do nauki pytań na prawo jazdy kategorii B. Działa na Macu i iPhonie, a po pierwszym uruchomieniu i imporcie danych także offline.

## GitHub Pages

Repozytorium jest gotowe do publikacji bez procesu budowania. W GitHub:

1. **Settings → Pages**
2. **Build and deployment → Source: Deploy from a branch**
3. Branch: **main**
4. Folder: **/(root)**
5. **Save**

Adres projektu będzie miał postać:

`https://<login>.github.io/<nazwa-repo>/`

Wszystkie ścieżki aplikacji są względne, więc PWA działa również jako GitHub Pages project site w podfolderze repozytorium.

## iPhone

1. Otwórz adres GitHub Pages w Safari.
2. Udostępnij → **Dodaj do ekranu początkowego**.
3. Uruchom aplikację z ikony.
4. Zaimportuj bazę `.xlsx`/CSV/JSON oraz multimedia lub ZIP.
5. W ustawieniach użyj **Zabezpiecz dane offline**.
6. Przetestuj po wyłączeniu Wi‑Fi i danych komórkowych.

Pytania, postęp i multimedia są zapisywane lokalnie w IndexedDB. Nie są publikowane w repozytorium ani wysyłane na GitHub.

## Obsługiwane dane

- pytania: `.xlsx`, CSV, JSON,
- multimedia: JPG, PNG, GIF, WebP, MP4 i inne formaty odtwarzane przez przeglądarkę,
- pakiety: ZIP z bazą i multimediami,
- eksport/import postępu: JSON.

WMV nie jest obsługiwany przez Safari na iPhonie. Jeżeli baza wskazuje `plik.wmv`, aplikacja automatycznie próbuje znaleźć `plik.mp4`.

## Offline

Service Worker przechowuje interfejs aplikacji w cache, a baza i multimedia są przechowywane w IndexedDB. Plik `.nojekyll` wyłącza przetwarzanie Jekyll w GitHub Pages.
