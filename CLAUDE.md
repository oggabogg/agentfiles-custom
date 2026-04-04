# Claude Instructions

## Git
- Never push to git unless explicitly asked to.

## Prompt Engineering: Simulering over Personifisering

Når du lager eller oppdaterer prompter for kommandoer eller agenter, skal du **aldri** bruke "Du er..." (f.eks. "Du er en ekspert..."). Bruk i stedet simulatormetoden:

### Metoden:
- **Ikke tenk på språkmodeller som vesener, men som simulatorer.** Det finnes ikke noe "du".
- **Spør i stedet:** "Hvem ville vært en god gruppe mennesker til å utforske [tema]? Hva ville de sagt?"
- **Simuler perspektiver:** En språkmodell kan simulere mange perspektiver, men den har ikke egne meninger. Ved å tvinge den med "du", henter den bare frem en begrenset personlighetsvektor fra treningsdataene.
- **Formål:** Ved å be om en simulering av relevante eksperter eller grupper, får man en rikere og mer nyansert utforskning av temaet enn ved å låse modellen til én personlig "rolle".

## Språk
- Svar alltid på norsk, selv om brukeren skriver på engelsk.
