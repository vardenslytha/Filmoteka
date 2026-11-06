# Półka Raczyńskich

Filmy na płytach z katalogu Biblioteki Raczyńskich w Poznaniu, z dostępnością w filiach. Co noc GitHub Actions pobiera katalog, dociąga plakaty z TMDB i publikuje stronę na GitHub Pages. Całość jest darmowa.

## Uruchomienie (jednorazowo, ok. 10 minut)

1. Załóż na GitHubie **publiczne** repozytorium, np. `polka-raczynskich`. Publiczne repo ma darmowe, nielimitowane minuty Actions.
2. Wrzuć zawartość tego folderu do repozytorium, łącznie z ukrytym folderem `.github`. Najprościej przez GitHub Desktop albo:
   ```
   git init && git add . && git commit -m "Półka Raczyńskich" && git branch -M main
   git remote add origin https://github.com/TWOJ_LOGIN/polka-raczynskich.git && git push -u origin main
   ```
3. **Settings → Secrets and variables → Actions → New repository secret**: nazwa `TMDB_API_KEY`, wartość: Twój klucz API (v3) z TMDB. Bez sekretu strona działa, tylko bez plakatów.
4. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
5. **Actions → Odśwież półkę → Run workflow**. Pierwsze uruchomienie trwa ok. 15–30 minut (pełny katalog i wszystkie okładki). Kolejne noce są szybsze, bo okładki są w cache.
6. Adres strony pojawi się w podsumowaniu uruchomienia i w Settings → Pages: `https://TWOJ_LOGIN.github.io/polka-raczynskich/`.

## Co jest w środku

| Plik | Rola |
|---|---|
| `harvester/harvest.mjs` | Pobiera filmy z katalogu Primo (rok po roku, z przerwami między zapytaniami) |
| `harvester/enrich-tmdb.mjs` | Dodaje plakaty, oceny, opisy i czyste polskie tytuły z TMDB |
| `site/index.html` | Strona (bez frameworków, jeden plik) |
| `site/films.json` | Dane; w repo leży próbka 142 filmów, workflow nadpisuje ją pełnym zbiorem |
| `.github/workflows/odswiez-polke.yml` | Harmonogram: codziennie ok. 3:17 + ręczny przycisk |

## Warto wiedzieć

- **Dostępność** jest aktualna na moment nocnego pobrania. W ciągu dnia mogła się zmienić; strona to mówi.
- **GitHub wyłącza zaplanowane uruchomienia** w repo bez żadnej aktywności przez 60 dni. Dostaniesz wtedy maila; wystarczy kliknąć „Enable workflow” albo zrobić dowolny commit.
- **Uprzejmość wobec biblioteki**: harvester robi przerwę 0,4 s między zapytaniami i chodzi raz na dobę. Przy publicznym starcie warto napisać do Biblioteki Raczyńskich, co to jest. Może zechcą to polecać czytelnikom.
- **TMDB** wymaga stopki z informacją o źródle (jest na stronie) i do użytku komercyjnego osobnej licencji.

## Hosting na Netlify zamiast Pages

Pobieranie i tak musi zostać w GitHub Actions (funkcje Netlify mają limit ok. 30 s, a pobranie trwa kilkanaście minut). Zmienia się tylko publikacja:

1. Na Netlify: **Add new site → Deploy manually**, wrzuć folder `site`. Zapisz **Site ID** (Site configuration → General).
2. Netlify: **User settings → Applications → Personal access tokens → New access token**.
3. W GitHub dodaj sekrety `NETLIFY_AUTH_TOKEN` i `NETLIFY_SITE_ID`.
4. W workflow usuń kroki `configure-pages`, `upload-pages-artifact` oraz cały job `deploy`, a na końcu jobu `build` dodaj:
   ```yaml
         - name: Publikuj na Netlify
           env:
             NETLIFY_AUTH_TOKEN: ${{ secrets.NETLIFY_AUTH_TOKEN }}
             NETLIFY_SITE_ID: ${{ secrets.NETLIFY_SITE_ID }}
           run: npx --yes netlify-cli deploy --dir=site --prod
   ```

## Lokalnie

```
node harvester/harvest.mjs 2023 2024 > films.json
node harvester/enrich-tmdb.mjs films.json tmdb-cache.json > site/films.json   # klucz w harvester/.env
npx serve site
```
Strony nie da się otworzyć podwójnym kliknięciem (`file://`), bo przeglądarka blokuje wczytanie `films.json`. Potrzebny jest serwer, choćby `npx serve`.
