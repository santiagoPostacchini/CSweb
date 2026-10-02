# Worker de TURN (Cloudflare)

Entrega credenciales TURN efímeras a la página de GitHub Pages, así los jugadores no tienen que
configurar nada para conectar entre redes distintas. El secreto de Cloudflare queda en el Worker.

## Puesta en marcha (una sola vez)

1. Cuenta gratuita en <https://dash.cloudflare.com>.
2. **Realtime → TURN Server → Create**: te da un *Key ID* y un *API Token*.
   Cloudflare incluye 1.000 GB/mes gratis y después cobra US$0,05 por GB: configurá una alerta de uso
   (el juego usa muy poco; lo que más gasta es la primera descarga de los archivos si pasa por relay).
3. Desplegar el Worker:

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_API_TOKEN
npx wrangler deploy
```

4. `wrangler deploy` imprime la URL (`https://csweb-turn.<tu-subdominio>.workers.dev`).
   En GitHub: **Settings → Secrets and variables → Actions → Variables → New repository variable**
   `TURN_ENDPOINT` = `https://csweb-turn.<tu-subdominio>.workers.dev/turn`.
5. Hacer push a `main`: la página se vuelve a publicar con el relay automático.

Si tu página no está en `https://santiagopostacchini.github.io`, cambiá `ALLOWED_ORIGINS` en `wrangler.toml`.

## Despliegue automático

`.github/workflows/worker.yml` despliega el Worker cuando cambia `worker/**`.
Necesita el secreto de repositorio `CLOUDFLARE_API_TOKEN` (plantilla *Edit Cloudflare Workers*)
y `CLOUDFLARE_ACCOUNT_ID`.

## Probar

```bash
curl -H "Origin: https://santiagopostacchini.github.io" https://csweb-turn.<tu-subdominio>.workers.dev/turn
```

Debe devolver `{"iceServers":[…]}`. En la página, `?relay=1` fuerza a pasar siempre por TURN
(sirve para comprobar que el relay anda de punta a punta; el diagnóstico debe decir `relay`).
