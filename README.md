# Półka Raczyńskich

Filmy i muzyka na płytach z katalogu Biblioteki Raczyńskich w Poznaniu, z dostępnością w filiach. GitHub Actions co godzinę pobiera porcję katalogu, dociąga plakaty filmów z TMDB i okładki płyt z MusicBrainz, i publikuje stronę na GitHub Pages. Całość jest darmowa.

## Uruchomienie (jednorazowo, ok. 10 minut)

1. Załóż na GitHubie **publiczne** repozytorium, np. `polka-raczynskich`. Publiczne repo ma darmowe, nielimitowane minuty Actions.
2. Wrzuć zawartość tego folderu do repozytorium, łącznie z ukrytym folderem `.github`. Najprościej przez GitHub Desktop albo:
   ```
   git init && git add . && git commit -m "Półka Raczyńskich" && git branch -M main
   git remote add origin https://github.com/TWOJ_LOGIN/polka-raczynskich.git && git push -u origin main
   ```
3. **Settings → Secrets and variables → Actions → New repository secret**: nazwa `TMDB_API_KEY`, wartość: Twój klucz API (v3) z TMDB. Bez sekretu strona działa, tylko bez plakatów filmów. Okładki płyt nie wymagają klucza.
4. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
5. **Actions → Pobierz katalog → Run workflow**. Pełny cykl to kilka godzinnych porcji; strona publikuje się po każdej.
6. Adres strony pojawi się w podsumowaniu uruchomienia i w Settings → Pages: `https://TWOJ_LOGIN.github.io/polka-raczynskich/`.

## Co jest w środku

| Plik | Rola |
|---|---|
| `harvester/harvest.mjs` | Pobiera z katalogu Primo filmy (`RTYPE=videos`) albo muzykę (`RTYPE=audios`), porcjami z wznawianiem |
| `harvester/enrich-tmdb.mjs` | Plakaty, oceny, opisy i czyste polskie tytuły filmów z TMDB |
| `harvester/enrich-music.mjs` | Okładki płyt z MusicBrainz i Cover Art Archive (1 zapytanie/s, porcjami, z cache) |
| `site/index.html` | Strona (bez frameworków, jeden plik) |
| `site/films.json`, `site/music.json` | Dane; workflow tworzy je i publikuje |
| `.github/workflows/katalog.yml` | „Pobierz katalog”: tylko biblioteka, porcje do 45 min z wznawianiem; po każdej porcji zamawia publikację, a w toku cyklu kolejną porcję |
| `.github/workflows/publikuj.yml` | „Wzbogać i opublikuj”: szybka publikacja z cache (ok. 2 min), potem nowe dopasowania TMDB i MusicBrainz (do 40 min) i druga publikacja |

## Warto wiedzieć

- **Dwa workflow**: zmiana strony (`site/`) albo skryptów wzbogacania publikuje się od razu przez „Wzbogać i opublikuj”, bez czekania na pobieranie katalogu. Ręcznie: Actions → Wzbogać i opublikuj → Run workflow.
- **Podsumowanie przebiegu**: w Actions kliknij przebieg; na jego stronie (Summary) jest tabelka dla filmów, muzyki i okładek: rekordy, strony, blokady, pominięte strony, luki w kontroli kompletności.
- **Dostępność** jest aktualna na moment pobrania. W ciągu dnia mogła się zmienić; strona to mówi.
- **GitHub wyłącza zaplanowane uruchomienia** w repo bez żadnej aktywności przez 60 dni. Dostaniesz wtedy maila; wystarczy kliknąć „Enable workflow” albo zrobić dowolny commit.
- **Jak harvester oszczędza katalog**: gość widzi najwyżej 500 wyników jednego wyszukiwania, a dalsze strony dużych wyników katalog często liczy dłużej niż 30 s. Dlatego każdy przedział lat z ponad 100 pozycjami jest dzielony na wyszukiwania po pierwszej literze tytułu (cyfry i a–z; „s…” obejmuje też „ś…”). Litery, które w całości zmieściły się na pierwszej stronie roku, są pomijane. Pyta po jednym zapytaniu naraz.
- **Kontrola kompletności**: dla każdego podzielonego roku liczba różnych rekordów ze wszystkich liter jest porównywana z liczbą wyników roku. Przy brakach harvester raz ponawia litery, które dały 0; resztę zgłasza w podsumowaniu jako lukę.
- **Zacięte strony**: katalog czasem nie oddaje strony przez kilkanaście minut. Harvester ponawia ją z rosnącymi przerwami (30 s … 10 min), a po 5 próbach pomija i zgłasza w podsumowaniu.
- **Porcje i wznawianie**: workflow rusza co godzinę, a gdy cykl jest w toku, każdy przebieg od razu zamawia następny (harmonogram GitHuba bywa zawodny). Każdy przebieg pobiera do ok. 45 minut, zapisuje postęp (cache GitHuba) i publikuje stronę: pozycje już odświeżone w tym cyklu plus reszta z poprzedniego pełnego cyklu. Po pełnym cyklu przez ok. 20 h katalog nie jest odpytywany.
- **Okładki płyt**: MusicBrainz pozwala na 1 zapytanie na sekundę, więc pierwsze uzupełnienie trwa kilka godzin rozłożonych na przebiegi (w godzinach bez pobierania katalogu po 50 min). Płyty bez wykonawcy (składanki) są pomijane, a okładka wymaga zgodności tytułu i wykonawcy, żeby nie pokazać cudzej.
- **Nowości**: harvester zapamiętuje, kiedy pierwszy raz zobaczył dany rekord. Daty zaczynają się po pierwszym pełnym cyklu v9; od tego momentu strona pokazuje odznakę „Nowość” (30 dni) i sortowanie „Nowe w bibliotece”.
- **Uprzejmość wobec biblioteki**: przy publicznym starcie warto napisać do Biblioteki Raczyńskich, co to jest.
- **TMDB** wymaga stopki z informacją o źródle (jest na stronie) i do użytku komercyjnego osobnej licencji. Dane MusicBrainz są na licencji CC0, okładki pochodzą z Cover Art Archive.

## Lokalnie

```
RTYPE=videos node harvester/harvest.mjs > films.json
RTYPE=audios node harvester/harvest.mjs > music-raw.json
node harvester/enrich-tmdb.mjs films.json tmdb-cache.json > site/films.json   # klucz w harvester/.env
node harvester/enrich-music.mjs music-raw.json mb-cache.json > site/music.json
npx serve site
```
Strony nie da się otworzyć podwójnym kliknięciem (`file://`), bo przeglądarka blokuje wczytanie danych. Potrzebny jest serwer, choćby `npx serve`.
