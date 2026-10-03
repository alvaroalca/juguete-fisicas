# Juguete de físicas

Cuerpos blandos en el navegador. Estira, golpea con una maza y dispara a una gelatina balística, una diana de 10 m pistola, un rey de ajedrez o tu propio nombre en letras, en cinco materiales que se comportan distinto: gelatina, silicona, goma, laca y plastilina que se mezcla consigo misma.

**Jugar:** [alvaroalcaraz.com/juguete](https://alvaroalcaraz.com/juguete/)

## Cómo está hecho

- Motor XPBD escrito a mano (restricciones de arista y de volumen por tetraedro), sin librería de física. Three.js solo pinta.
- Las formas son funciones de distancia con signo: de ellas salen la malla de simulación (vóxeles partidos en 6 tetraedros) y la superficie visible (surface nets), que va incrustada en los tetraedros.
- Todo cabe en tres archivos estáticos, sin build.

## Ejecutar en local

```
python -m http.server 8000
```

y abrir `http://localhost:8000`.
