# PfotenPix Preview Function (Vercel)

Kleine Serverless-Function, die 3 Bild-Previews erzeugt oder im Mock-Modus 3× die Original-URL zurückgibt.

## Schritte
1. GitHub-Repo anlegen und diese Dateien hochladen.
2. Vercel: New Project → Repo importieren → Deploy.
3. Environment Variables setzen:
   - CALLBACK_SECRET (gleich wie in WordPress)
   - Optional: REPLICATE_API_TOKEN (sonst Mock)
4. URL kopieren (z. B. https://DEINNAME.vercel.app/api/generate) und im WP-Snippet eintragen.
