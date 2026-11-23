# El Viejo Timbero — Sitio Estático MPA (Netlify + AdSense Ready)

Proyecto informativo y recreativo sobre resultados de loterías y quinielas argentinas, reconstruido como aplicación multipágina estática (10 archivos `.html`) optimizada para SEO, Google AdSense y actualización automatizada vía `data/resultados.json`.

## Estructura del proyecto

- `index.html`: Panel de Sorteos Poceados (Quini 6, Loto Plus, Telekino, Brinco, Loto 5, La Poceada, Quiniela Plus) + guía de horarios y FAQ.
- `quinielas.html`: Panel de Quinielas (7 jurisdicciones, 5 turnos de Provincia y Ciudad) + tabla de pagos + buscador de los 100 Sueños (00 al 99).
- `controlar-boleta.html`: Verificador completo para los 8 juegos (incluye La Poceada y Quinielas) + guía de cobro y retenciones.
- `simulador.html`: Generador estadístico con candados, exclusiones y filtros + nota educativa sobre probabilidad.
- `mis-jugadas.html`: Billetera local en `localStorage` conectada con el controlador mediante parámetros URL.
- `privacidad.html`, `terminos.html`, `juego-responsable.html`, `acerca.html`, `contacto.html`: Páginas legales, de transparencia y formulario compatible con Netlify Forms.
- `robots.txt`, `sitemap.xml`, `ads.txt`, `netlify.toml`: Archivos raíz preparados para bots de Google y despliegue en Netlify.
- `data/resultados.json`: Contrato único de datos consumido por todos los paneles.

## Pasos antes de publicar

1. **Subir a GitHub** y conectar el repositorio a tu sitio de Netlify (`elviejotimbero.netlify.app`).
2. **Configurar `ads.txt`**: reemplazá `pub-0000000000000000` por tu ID de editor real de Google AdSense.
3. **Automatizar `data/resultados.json`**: el archivo incluido contiene datos semilla con el esquema definitivo; el paso siguiente es sumar el workflow de GitHub Actions que actualizará `data/resultados.json` y las fechas de `sitemap.xml` después de cada sorteo.
4. **Publicidad limpia**: los contenedores `.ad-slot` permanecen ocultos por CSS (`display: none`) hasta que cargues el script oficial de AdSense y el anuncio se complete (`data-ad-status="filled"`).
