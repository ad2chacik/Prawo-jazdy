Baza publiczna. Umieść tutaj `questions.json` (zalecane) lub `questions.xlsx`.

Żeby przyszłe aktualizacje trafiły do znajomych, dodaj także `catalog.json`:

```json
{"version": "072026"}
```

Po każdej świadomej aktualizacji bazy zmień `version` (np. na `092026`). Samo nadpisanie pliku pytań bez zmiany `version` nie spowoduje ich automatycznej aktualizacji na urządzeniach z istniejącą bazą pobraną z serwera.

Nazwy wymaganych kolumn: Numer pytania, Pytanie, Odpowiedź A/B/C, Poprawna odp, Media, Liczba punktów, Kategorie. Stosuj trwałe numery pytań. Zmiana treści lub poprawnej odpowiedzi resetuje postęp konkretnego pytania.

Nie publikuj plików, do których nie masz praw do publicznego udostępnienia.
