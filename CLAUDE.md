# CLAUDE.md — Juguete de físicas

Juguete de cuerpos blandos en el navegador: estiras, disparas y deformas objetos con física XPBD. Pieza de portfolio. Effort en el vault: `Efforts/juguete-fisicas/`.

## Cómo se ejecuta

Tres archivos estáticos sin build: `index.html`, `style.css`, `main.js`. Three.js 0.170 por el endpoint `+esm` de jsDelivr; fuentes de Google Fonts.

```
python -m http.server 8000
```
y abrir `http://localhost:8000`.

## Publicación

- Repo público `alvaroalca/juguete-fisicas`. Demo en `alvaroalcaraz.com/juguete/`: es una **copia** de estos tres archivos en `public/juguete/` del repo del portfolio (`C:\Mis Proyectos\pagina web promocion`), que se publica con su flujo dev → main.
- **La CSP del portfolio manda**: nada de `<style>`, `<script>` ni `style="..."` en línea (tampoco `importmap`, que es un script en línea). Scripts solo de `'self'` y `cdn.jsdelivr.net`. Por eso los imports van con URL completa a `+esm`.
- Al cambiar el juguete, copiar los tres archivos al portfolio; no editar la copia.

## Estructura de `main.js`

- `// ==== SIM ====` … `// ==== FIN SIM ====`: motor puro, sin Three ni DOM. Se puede extraer a un `.mjs` y probar en Node (así se midieron estabilidad, rendimiento, penetración del balín, plastilina y mezcla).
- Formas como SDF → malla de simulación (vóxeles en 6 tetraedros, partición de Kuhn) + superficie visible (surface nets, celda × 0,4) incrustada con baricéntricas.
- Escena, interacción y panel debajo.

## Decisiones que no hay que deshacer sin medir

- **Un objeto en escena**: no hay colisiones entre cuerpos, y autocolisión solo en plastilina.
- **WebGL2 + `MeshPhysicalMaterial` con `transmission`**, no WebGPU: da la translucidez y va en cualquier móvil.
- **`volCompliance = 1e-9`, no 0**: hay más tetraedros que grados de libertad; con volumen rígido el residuo se convierte en velocidad (∝ 1/dt) y en cámara lenta explota (medido: 46 MJ con 0, 18 J con 1e-9).
- **Posiciones en `Float64Array`**: más rápido que Float32 en V8 y sin ruido de redondeo en `(pos - prev) / dt`.
- **Subpasos extra con balín en vuelo** (que avance ≤ 0,25 r por subpaso): con menos, a ×1 atraviesa la gelatina y a ×0,1 no; la física no puede depender de la cámara lenta.
- **Contacto balín–partícula repartido por masas** (el balín es una partícula PBD): conserva el momento.
- **Rango de firmeza por objeto** (`rango` en `OBJETOS`): la firmeza 0 queda justo por encima de donde la forma deja de sostenerse. Medido: la gelatina aguanta desde 1e-2,5; rey y letras pandean entre 1e-3,5 y 1e-4.
- **Balín de 4,5 mm** (el diez interior). En la diana va por rayo sobre la superficie deformada; en el resto empuja partículas con radio de cavidad 0,085, porque las partículas están a 10 cm y uno de 4,5 mm pasaría entre ellas.
- **La diana solo dispara** y su firmeza decide qué le pasa al balín, no la rigidez (fija a 1e-3,5): < 0,1 atraviesa; hasta 0,85 lo atrapa, se estira y se rompe; desde 0,85 lo devuelve hacia atrás (efecto Luffy). Mientras lo tiene atrapado, el parche sigue un recorrido guiado (`body.kin`: sale frenando 0,35 s, tenso 0,12 s, vuelve de golpe 0,12 s; hasta 1,2 m) porque un impulso suelto se reparte en 578 kg de cartulina y solo estira 8 cm (medido). El agujero es siempre del calibre y su cerco va con `source-atop`.
- **Ratón**: izquierdo solo para el objeto; central gira, derecho desplaza.
- **Plastilina es un material**, no un interruptor: rigidez propia por objeto (`plastilina` en `OBJETOS`), límite elástico del 1 % y amortiguación 20. Ventana estrecha medida: la gelatina se escurre por debajo de 1e-4,2 y por encima de 1e-4,4 se levanta entera al tirar; el rey va bien a 1e-5 (conserva el 95 % del estirón).
- **Mezcla de plastilina**: autocolisión una vez por frame (hash espacial, ignora pares que eran vecinos en reposo, corrige solo posición) y soldadura con arista nueva si dos partes se aprietan por debajo de 0,75 celdas. No se quitan partículas (masa intacta) y los tetraedros sostienen el volumen. Medido con dos cubos: 51 soldaduras, al tirar de uno el otro le sigue 0,44 (sin mezcla, −0,04); 1 ms/frame.
- **Amortiguación interna** (relativa al centro de masas): frena el temblor sin frenar la caída.
- **Cada material es aspecto + física** (`fisica` en `MATERIALES`): al elegirlo coloca firmeza, amortiguación y restitución. Si un material nuevo no se comporta distinto, no entra (por eso se quitó Cristal).
- **Restitución a nivel de cuerpo**, no por partícula: por partícula el resto del cuerpo se come el rebote (medido: 8 cm de 100 con o sin ella). Con la de cuerpo, goma e=0,8 rebota 57 cm.
- **Maza**: cilindro cinemático que baja acelerando, se hunde 0,12 más allá del punto de impacto y vuelve; recorrido en tiempo de simulación.
- **El agarre no baja del suelo**: si baja, al soltar el suelo saca las partículas en un subpaso y salen disparadas.
- Paleta: OP-1 de Teenage Engineering. Tipografías: IBM Plex Mono (UI) y Archivo Black (letras).

Estado y pendientes: `docs/STATUS.md`.
