# Incident Log — openclaw-pages

## 2026-05-20 — Incident closed: /ocae page restored

### Stato iniziale
- `/ocae` restituiva 404 (pagina non trovata)
- `/OCAE` funzionava ma era una pagina diversa
- File corretto `/ocae` esisteva in locale ma non era deployato
- Repository `workspace-carlo` era vuota e non proteggeva il progetto

### Causa root
- Assenza di versioning Git nel progetto `openclaw-pages`
- Deploy precedente non tracciato o perso
- Rischio di confusione tra `/ocae` (minuscolo) e `/OCAE` (maiuscolo)

### Azioni eseguite
1. **Fase 1 — Inventario fonti**: Ricerca completa in file locali, memory, GitHub, Vercel log
2. **Fase 2 — Identificazione**: Trovato file corretto in `vercel-deploy/ocae/index.html` e `openclaw-pages/public/ocae/index.html`
3. **Fase 3 — Protezione**: Inizializzato Git locale in `openclaw-pages/`, creato commit `b9407a3`
4. **Fase 4 — Deploy**: Eseguito deploy produzione Vercel
5. **Fase 5 — Verifica**: Confermato HTTP 200 su `/ocae/` con headline corretta

### Risultato
- ✅ `/ocae` ripristinato: `https://pages.riccardoromano.biz/ocae/`
- ✅ `/OCAE` preservato: pagina distinta intatta
- ✅ `/L-OCAE` preservato: pagina distinta intatta
- ✅ Root preservata

### Lezione principale
`openclaw-pages` deve essere protetto da:
- Versioning Git con commit regolari
- Remote GitHub configurato per backup
- Documentazione dei deploy
- Distinguere esplicitamente `/ocae` vs `/OCAE` vs `/L-OCAE`

### Differenze pagine

| Slug | Headline | Stato |
|------|----------|-------|
| `/ocae/` | "Hai già provato l'AI. Ma non hai ancora un **sistema** che lavora per te." | ✅ Ripristinata |
| `/OCAE/` | "Scopri come **automatizzare** il tuo business senza stress" | ✅ Preservata |
| `/L-OCAE/` | "Demo: Un sistema che costruisce il funnel al posto tuo" | ✅ Preservata |

---
