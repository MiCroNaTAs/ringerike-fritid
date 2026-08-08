# Fritid i Ringerike

Uoffisiell, automatisk oppdatert oversikt over fritidstilbud for barn, unge og voksne i
Ringerike kommune — idrettslag, kulturforeninger, frivillige organisasjoner og annet.

Siden bygges statisk (Astro) og oppdateres av seg selv: en planlagt GitHub Action henter
ferske data fra offentlige registre og nettsider, committer endringene, og publiserer
siden på nytt automatisk. Ingen manuell redigering av innhold er nødvendig i det daglige.

## Hvordan det henger sammen

```
scripts/fetch-data.mjs          -> henter/samler data
  ├─ Frivillighetsregisteret     (Brønnøysundregistrenes åpne Enhetsregister-API)
  ├─ Ringerike kommunes nettside (beste-innsats HTML-skraping av fritidsaktiviteter-siden)
  └─ src/data/manual-tilbud.json (manuelt kuraterte tilbud)
        ↓
src/data/tilbud.json + src/data/meta.json   (generert, sjekket inn i git)
        ↓
Astro-sidene (src/pages/*.astro) leser disse filene ved bygg
        ↓
.github/workflows/update-and-deploy.yml     -> kjører skriptet daglig, committer, bygger, publiserer til GitHub Pages
```

### Datakilder

- **Frivillighetsregisteret**: hentes via `https://data.brreg.no/enhetsregisteret/api/enheter`
  filtrert på `kommunenummer=3305` (Ringerike, gjeldende nummer siden 2024) og
  `registrertIFrivillighetsregisteret=true`. Gir navn, adresse og bransjekode — registeret
  har ikke nettside/e-post/telefon, så disse feltene er tomme for disse oppføringene.
- **Ringerike kommune**: en enkel skraping av kommunens side om fritidsaktiviteter. Dette er
  *ikke* et offisielt API, og kan være skjørt hvis kommunen endrer sidestruktur — skriptet er
  laget for å feile "høflig" (beholder forrige kjørings data for denne kilden) fremfor å
  krasje hele oppdateringen.
- **Manuelle tilbud**: legg til i `src/data/manual-tilbud.json` (se
  `src/data/manual-tilbud.example.json` for format). Nyttig for tilbud som ikke er egne
  juridiske enheter (f.eks. en fritidsklubb drevet av kommunen).
- **Automatisk lenkesøk**: for tilbud uten registrert nettside forsøker
  `scripts/fetch-data.mjs` å finne en nettside, Facebook- eller Instagram-side automatisk
  via [Serper.dev](https://serper.dev) (tredjeparts søke-API). Krever oppsett, se under.
  Uten oppsett hoppes dette steget bare over, og siden viser i stedet en direkte
  Google-/Facebook-søkelenke (se `src/pages/index.astro`).

Kategori og aldersgruppe settes av enkle nøkkelord-/bransjekode-heuristikker i
`scripts/fetch-data.mjs` — det er **ikke** verifisert manuelt for hvert tilbud. Feil kan
rettes permanent via `src/data/overrides.json` (nøkkel: `orgnr:<organisasjonsnummer>` eller
tilbudets `id`).

## Sette opp automatisk lenkesøk (valgfritt)

Gir automatisk oppslag av nettsted/Facebook/Instagram for tilbud som mangler det, via
[Serper.dev](https://serper.dev) — en tredjeparts Google-søke-API med 2500 gratis søk ved
registrering (ikke behov for betalingskort). Skriptet bruker maks 40 søk per kjøring og
cacher resultatet permanent, så en full gjennomgang av alle tilbud koster et par hundre
søk totalt — godt innenfor det gratis nivået.

1. Gå til [serper.dev](https://serper.dev) og opprett en gratis konto.
2. Kopier **API-nøkkelen** fra dashbordet.
3. I GitHub-repoet: **Settings → Secrets and variables → Actions → New repository secret**,
   legg til `SERPER_API_KEY` med nøkkelen fra steg 2.
4. Ferdig — neste kjøring av workflowen plukker den opp automatisk. Status vises på
   "Om siden" (antall søkt/funnet per kjøring).

Uten denne secreten hopper skriptet rett og slett over lenkesøket og fungerer som før. Et
treff må matche minst halvparten av ordene i tilbudets navn og ikke komme fra et
bedriftsregister/oppslagsverk for å bli godtatt — usikre treff droppes heller enn å vise
feil lenke. Resultatet caches i `src/data/lenke-cache.json` slik at samme tilbud ikke
slås opp på nytt hver kjøring. Merk: Serper.dev er en betalt tredjepartstjeneste utover
den gratis kvoten (fra ca. 500 kr for 50 000 søk, gyldig 6 måneder, ikke abonnement) —
ved vårt bruksmønster bør den gratis kvoten vare svært lenge.

## Kjøre lokalt

```bash
npm install
export SERPER_API_KEY=...   # valgfritt, se "Sette opp automatisk lenkesøk" over
npm run fetch-data   # henter ferske data (krever nettilgang til data.brreg.no og
                      # ringerike.kommune.no)
npm run dev           # utviklingsserver på http://localhost:4321
npm run build         # statisk bygg til dist/
npm run preview       # forhåndsvis bygget
```

## Publisering (GitHub Pages)

Workflowen `.github/workflows/update-and-deploy.yml` bygger og publiserer automatisk til
GitHub Pages ved push til `main`, på en daglig tidsplan, og ved manuell kjøring
(`workflow_dispatch`). Én engangs-innstilling må gjøres i repoet før det virker:

1. Gå til **Settings → Pages** i GitHub-repoet.
2. Under **Build and deployment**, sett **Source** til **GitHub Actions**.

Etter det trenger ingen å røre noe manuelt — workflowen tar seg av resten. Skal siden
hostes et annet sted (Vercel/Netlify/egen server), overstyr `SITE_URL`/`SITE_BASE`
miljøvariablene brukt i `astro.config.mjs` og fjern GitHub Pages-stegene i workflowen.

## Foreslå tilbud eller meld feil

Bruk issue-malen "Foreslå et fritidstilbud" i GitHub-repoet, eller send inn en PR som
endrer `src/data/manual-tilbud.json` / `src/data/overrides.json` direkte.
