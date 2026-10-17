# Atlas ETF Internacional

Monitor local de ETF negociados en España y otras plazas europeas. Usa datos públicos reales y no genera precios simulados.

## Ejecutar

No necesita cuenta, clave de API ni dependencias externas:

```bash
python3 server.py
```

Después abre `http://localhost:4173`.

## Publicar rápidamente en Render

1. Sube este directorio a un repositorio de GitHub.
2. En Render, selecciona `New` y después `Blueprint`.
3. Conecta el repositorio y confirma el archivo `render.yaml`.
4. Render creará una URL pública `https://atlas-etf-....onrender.com` con HTTPS.

El plan gratuito se suspende cuando no recibe tráfico. Para disponibilidad continua, cambia el servicio a un plan siempre activo.

## Datos incluidos

- Los seis ETF que BME publica actualmente.
- Tres ETF internacionales comparables entre Londres, Xetra, Milán, Ámsterdam y SIX.
- Precio original en EUR, USD, GBP o peniques, más conversión a euros.
- Variación, volumen, hora de cotización y diferencia entre plazas para el mismo ISIN.
- Exportación CSV y actualización automática cada 60 segundos.
- Tipo de cambio diario del Banco Central Europeo.
- Identificación visible de la fuente y de su política de retraso.

Fuentes:

`https://www.bolsasymercados.es/es/bme-exchange/mercados-y-cotizaciones/etfs/precios.html`

`https://finance.yahoo.com/`

`https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml`

## Limitaciones

BME indica que su información pública está diferida 15 minutos. Yahoo Finance ofrece aquí precios públicos con retraso variable y sin garantía de continuidad. Ninguna de estas fuentes incluye un libro de órdenes sincronizado en esta aplicación.

Cuando el mercado está cerrado, Atlas busca automáticamente la sesión más reciente de los últimos ocho días. Si BME no devuelve datos, la aplicación muestra el error y mantiene la tabla vacía.

La diferencia normalizada a euros es orientativa: mezcla horas de cotización y un cambio de divisa diario. Para arbitraje ejecutable se necesitan feeds contratados en tiempo real, bid, ask, profundidad y marcas temporales sincronizadas.
