# Incremental Everything

![Incremental Everything Logo](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/inc-logo.png)

🇺🇸 [English](https://github.com/bjsi/incremental-everything/blob/main/README.md) | 🇧🇷 [Português Brasileiro](https://github.com/bjsi/incremental-everything/blob/main/README_PT-BR.md)

**Un Sistema Completo de Aprendizaje para RemNote.**

Incremental Everything te permite intercalar tus repeticiones de tarjetas con notas, libros, sitios web y videos. Fuertemente inspirado en [Incremental Reading](https://supermemo.guru/wiki/Incremental_reading) de SuperMemo, transforma RemNote en una poderosa herramienta de aprendizaje permanente que maneja todo el ciclo de vida del conocimiento: **Adquisición → Procesamiento → Maestría**.

## 🚀 Características

### El Ciclo Principal
- **Lectura Incremental**: Lee y repasa miles de notas, libros y sitios web en paralelo. [Aprende más](https://www.youtube.com/watch?v=oNCLLNZEtz0).
- **Escritura Incremental**: Escribe tus ensayos y publicaciones de blog de manera incremental para maximizar la creatividad. [Aprende más](https://www.youtube.com/watch?v=LLS_8Y744lk).
- **Video Incremental**: Mira y toma notas de tu lista de videos de YouTube pendientes.
- **Tareas Incrementales**: Despeja tu lista de tareas entre repasos de tarjetas.

### 🧠 Priorización Avanzada
Gestiona la sobrecarga de información con un robusto sistema de doble prioridad:
- **Prioridades Absolutas y Relativas**: Prioriza elementos del 0 al 100 y ve exactamente dónde se clasifican en tu base de conocimiento.
- **Herencia de Prioridad**: Los nuevos extractos y tarjetas heredan automáticamente la prioridad de su material fuente.
- **Escudo de Prioridad**: Una herramienta de diagnóstico en tiempo real que muestra tu capacidad para procesar material de alta prioridad.
- **Documentos de Revisión Prioritaria**: Genera sesiones de estudio enfocadas para tus N elementos más importantes (lectura pasiva y tarjetas) cuando estés abrumado.

### 📱 Modos de Rendimiento
- **Modo Ligero (Predeterminado para Móvil/Web)**: Características rápidas, estables y esenciales solamente. Previene fallos en teléfonos y tabletas.
- **Modo Completo (Usuario Avanzado de Escritorio)**: Conjunto completo de características con cálculos estadísticos pesados para análisis detallados.

## Instalación

- Abre la [tienda de complementos de RemNote](https://www.remnote.com/plugins), busca "Incremental Everything" e instala el complemento.

## 📚 Documentación y Soporte

Este README cubre lo básico. Para las guías completas, por favor visita el **Manual de Usuario**:

👉 **[Wiki de Incremental Everything](https://github.com/bjsi/incremental-everything/wiki)**

### 🎥 Videos sobre lo básico

- **Videos Introductorios**: 
  * [Lectura Incremental de Páginas Web en RemNote](https://youtu.be/eXRlfCTOQNw)
  * [Lectura Incremental en RemNote](https://youtu.be/SL7wjgntrbg)

- **Lista de Reproducción de Prioridades**: [Priorización en Incremental Everything](https://www.youtube.com/playlist?list=PLpmcfTqNVuo9DWjeIrMZZfG140kOZD8Tl) – Cubre la configuración de prioridades, herencia, el Escudo de Prioridad, creación de Documentos de Revisión Prioritaria y cómo usar la priorización para gestionar la sobrecarga de información.

- **¿Qué es la Lectura Incremental?**: [Viaje Incremental - Lectura Incremental en Términos Simples](https://youtu.be/V4xEziM8mco)

### Enlaces Útiles
- **[Registro de Cambios](https://github.com/bjsi/incremental-everything/wiki/Changelog)**: Mira las últimas características y actualizaciones.
- **[Discord](http://bit.ly/RemNoteDiscord)**: Únete a la comunidad y chatea con nosotros (busca los canales del complemento).


## Uso

### Empezando
1. **Hazlo Incremental**: Haz cualquier Rem, PDF o Sitio Web `Incremental` usando el comando `/Incremental Everything` (Atajo: `Alt+X`).

![Hacer Incremental usando el comando](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/tag-inc-rem.gif)

2. **Priorízalo**: Usa `Alt+P` para establecer su importancia.
3. **Repásalo**: El complemento intercala estos elementos en tu cola regular de tarjetas.
4. **Desactívalo**: Elimina la etiqueta `Incremental` o presiona el botón **Done** (Hecho) en la cola si has terminado de repasarlo.

### ⚡ Priorización y Ordenamiento
- 0 es para tu material más importante y 100 es para el menos importante.
- **Cambiar Prioridad**: Haz clic en el botón en la cola o presiona `Alt+P` para abrir la ventana emergente de prioridad completa.
- **Atajos Rápidos**: Usa `Ctrl+Opt+Arriba` / `Ctrl+Opt+Abajo` para ajustar la prioridad instantáneamente sin interrumpir el flujo.
- **Criterios de Ordenamiento**: Usa el menú de la cola para ajustar el equilibrio entre **Estructura** (prioridad estricta) y **Exploración** (aleatoriedad), y controlar la proporción de Tarjetas a Material de Lectura.

### Programación

- **Programador Predeterminado**: Usa una fórmula exponencial — `intervalo = ⌈Multiplicador ^ N⌉` días (el multiplicador es 1.5 por defecto). Simple y eficaz para elementos que necesitan pocas revisiones.
- **Programador Beta (Curva de Saturación)**: Una alternativa opcional en la que los intervalos comienzan en un *Intervalo de Primera Revisión* configurable (por defecto 5 días) y se acercan gradualmente a un *Intervalo Máximo* (por defecto 30 días). Ideal para elementos que necesitan muchas revisiones (libros, capítulos). Consulta la página wiki [IncRem Scheduler](https://github.com/bjsi/incremental-everything/wiki/IncRem-Scheduler) para más detalles.
- Puedes establecer manualmente la próxima fecha de repetición usando el comando **Reprogramar** (**Ctrl+J**), o las funciones de tablas y propiedades de RemNote.

### 📱 Soporte Móvil
El complemento ahora cuenta con **Modo Ligero Automático**.
- Cuando abres RemNote en iOS o Android, el complemento cambia automáticamente a "Modo Ligero".
- Esto desactiva los cálculos pesados en segundo plano para asegurar una experiencia libre de fallos en dispositivos móviles.
- Tu experiencia de escritorio permanece con todas las funciones.

### Lectura Incremental

- Puedes etiquetar PDFs, sitios web y resaltados con la etiqueta `Incremental` para hacer lectura incremental clásica estilo SuperMemo.
- Funcionará si etiquetas el PDF o sitio web en sí, o un Rem con un solo PDF o sitio web como fuente.
- El complemento renderizará la vista de lectura del PDF o sitio web dentro de la cola.
- Si quieres convertir un resaltado en un Rem incremental, haz clic en el resaltado y haz clic en el icono de la pieza de rompecabezas.
- ** 📄 PDFs y Web**
  - **Estado Visual**: Los resaltados se vuelven **Verdes** cuando se activan como Incrementales, y **Azules** cuando se extraen.
  - **Crear Rem Incremental**: Selecciona texto en un PDF -> Resáltalo -> Haz clic en el Icono de Rompecabezas -> **"Create Incremental Rem"**. Esto extrae el texto a un nuevo Rem bajo un padre de tu elección (usando el selector inteligente de padres).
![Resaltar](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/highlight.gif)

### Escritura Incremental

- Puedes etiquetar cualquier Rem normal con la etiqueta `Incremental` para convertirlo en un Rem incremental.
- El complemento lo renderizará como un Rem normal en la vista de documento en la cola.

### Video Incremental

- Puedes etiquetar videos de YouTube con la etiqueta `Incremental` para verlos incrementalmente.
- Funcionará si etiquetas el Rem del enlace en sí, o un Rem con el enlace de YouTube como fuente.
- El complemento guardará automáticamente tu progreso y velocidad de reproducción.
- Puedes abrir la sección de notas redimensionable a la izquierda para tomar notas mientras ves.

![Video Incremental](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/inc-vid.png)

### Matemáticas Incrementales

- Un ejemplo rápido de interoperabilidad de complementos.
- Se integra con mi [complemento de probador de teoremas Lean](https://github.com/bjsi/remnote-lean) para programar conjuntos de problemas de pruebas matemáticas a lo largo del tiempo.
- El complemento Lean proporciona el widget de cola y el complemento Incremental Everything proporciona la programación.
- ¡Espero que otros desarrolladores puedan construir integraciones similares con sus complementos!

![Matemáticas Incrementales](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/lean.png)

### Revisión de Subconjuntos

- Puedes hacer revisiones básicas de subconjuntos estudiando un documento en particular. Solo se te mostrarán Rems de ese documento.
- También puedes crear una tabla desde la etiqueta `Incremental` y filtrarla a un subconjunto ordenado usando las funciones de filtro y ordenamiento de tablas.
- Puedes revisar las filas de una tabla en orden ordenando la tabla y usando el modo de práctica "Practicar en Orden".

Hay muchas formas en que puedes filtrar la tabla para crear un subconjunto de Rem para revisar. Aquí hay algunos ejemplos:

- Solo extractos Web

![Filtro de solo extractos](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/only-extracts.png)

- Solo videos de YouTube

![Filtro de solo videos de YouTube](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/inc-vid-filter.png)


## Problemas Conocidos

### Posición de Lectura Incremental de PDF

Al leer un PDF grande (como un libro) como un Rem incremental regular, el complemento puede no devolverte de manera confiable a tu último punto de lectura incremental.

  * **El Problema**: Si abres y te desplazas por el mismo PDF en otra ventana o pestaña, tu posición de lectura incremental se perderá. El visor de PDF nativo de RemNote solo recuerda la posición más reciente para un documento, lo que sobrescribe la posición de tu sesión de lectura incremental. Esto también significa que no puedes tener múltiples Rems incrementales para diferentes capítulos del mismo archivo PDF, ya que todos compartirían la misma posición de desplazamiento.
  * **La Causa**: Esto se debe a una limitación en el SDK de Complementos de RemNote actual. El complemento carece de las herramientas necesarias para guardar y restaurar programáticamente una posición de desplazamiento específica para un PDF y debe depender del comportamiento predeterminado de RemNote.
  * **Cómo Puedes Ayudar**: Para solucionar esto, necesitamos que los desarrolladores de RemNote expandan las capacidades de su API de Complementos. Hemos enviado una Solicitud de Función pidiendo estas herramientas. Por favor ayúdanos votando la solicitud en la plataforma de comentarios de RemNote. Más votos aumentarán su prioridad.

➡️ **[Vota la Solicitud de Función en el Sitio de Comentarios de RemNote](https://feedback.remnote.com/p/feature-request-programmatic-control-over-pdf-scroll-position-for-plugins?b=Plugin-Requests)**

### Conflicto de Atajos de Teclado:

Al ver una tarjeta Rem regular en la cola, el editor aparece correctamente. Sin embargo, los atajos de teclado nativos de la cola tendrán prioridad sobre escribir en el editor. Esto parece deberse a una limitación en la API actual del complemento que impide que un complemento capture completamente la entrada del teclado dentro del entorno de la cola. El botón "Presiona 'P' para Editar" se ha añadido como una solución alternativa. También puedes usar el botón recién creado "Revisar y Abrir".


## Detalles de Desarrollo

- El complemento almacena datos de repetición como propiedades powerup en el Rem. Estas no son tarjetas "normales" de RemNote. Toda la programación es gestionada internamente por el complemento.

### Cómo Desarrollar

Ejecuta los siguientes comandos:

```sh
git clone https://github.com/bjsi/incremental-everything
cd incremental-everything
npm i
npm run dev
```

Luego sigue [esta parte de la guía de inicio rápido](https://plugins.remnote.com/getting-started/quick_start_guide#run-the-plugin-template-inside-remnote) para poner el complemento en funcionamiento en RemNote.
