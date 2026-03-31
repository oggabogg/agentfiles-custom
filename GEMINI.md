# Prosjekt-instrukser for Agentfiles Custom

Dette er en tilpasset versjon av Obsidian-utvidelsen Agentfiles, optimalisert for bruk med Gemini CLI.

## Kritiske Regler (for å unngå krasj)
- **IKKE rør `main.js` direkte**: Filen er minifisert og svært sårbar. Gjør alle endringer i TypeScript-filene under `src/`.
- **Bygge-prosedyre**: Etter endringer i `src/`, kjør alltid `npm run build` for å generere en ny `main.js`.
- **Absolutte stier**: Bruk alltid absolutte stier for filer utenfor kildekoden (f.eks. `/Users/fredrikskauen/.gemini/GEMINI.md`). Obsidian vet ikke alltid hvilken mappe den kjører fra.
- **npm install**: Bruk `npm install --legacy-peer-deps` for å unngå versjonskonflikter mellom ESLint 8 og 9.

## Implementert funksjonalitet
- **Gemini Context Tax**: Sporer tokens for både global `Memory` (~/.gemini/GEMINI.md) og lokal `GEMINI.md` i vaulten.
- **Gemini Skill Usage**: Skanner chat-logger i `~/.gemini/tmp/fredrikskauen/chats/` for å telle bruk av ferdigheter.
- **Core Tool Filtering**: Filtrerer bort innebygde Gemini-verktøy (som `run_shell_command`, `read_file`, osv.) fra "Top Skills"-listen ved å bruke `DashboardPanel.CORE_TOOLS`-svartelisten i `src/views/dashboard.ts`.
- **Logikken ligger i**: `src/skillkit.ts` (datafangst) og `src/views/dashboard.ts` (visning).

## Utvikler-miljø
- **Lokal mappe**: `~/agentfiles-custom`
- **Obsidian-kobling**: Det er opprettet en symbolsk lenke (symlink) fra `Documents/MDVault/.obsidian/plugins/agentfiles` til denne mappen.
- **GitHub**: [oggabogg/agentfiles-custom](https://github.com/oggabogg/agentfiles-custom)
