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
- **Escudo de Prioridad y Escudo Ponderado**: Herramientas de diagnóstico que muestran tu capacidad para procesar material de alta prioridad y la fracción de tu cola total, ponderada por prioridad, que ya has procesado.
- **Analíticas FSRS**: Estadísticas de Dificultad (D), Estabilidad (S) y Recuperabilidad (R) calculadas en tiempo real para tus tarjetas.
- **Documentos de Revisión Prioritaria**: Genera sesiones de estudio enfocadas para tus N elementos más importantes (lectura pasiva y tarjetas) cuando estés abrumado.

### 📊 Historial, Panel y Mastery Drill *(nuevo en v0.2.182)*
Un conjunto completo de herramientas de historial y práctica, ahora integrado en la barra lateral derecha:
- **Historial de Rems Visitados**: vuelve de un salto a cualquier documento que hayas consultado recientemente.
- **Historial de Tarjetas**: encuentra y abre cualquier tarjeta que hayas repasado, con búsqueda por el texto del anverso y del reverso.
- **Panel de Colas Practicadas**: métricas de la sesión en tiempo real (velocidad, retención, antigüedad de las tarjetas) y un historial completo de cada sesión de práctica, con copia de seguridad mediante Exportar/Importar.
- **Mastery Drill**: una cola de repráctica enfocada en las tarjetas que calificaste como *Forgot* u *Hard* — inspirada en el Final Drill de SuperMemo. Ábrela con el comando `Mastery Drill` o desde la notificación de la Barra Lateral Izquierda.

👉 [Documentación completa](https://hugomarins.github.io/incremental-everything/History-Queue-Dashboard-and-Mastery-Drill/)

### 📱 Modos de Rendimiento
- **Modo Ligero (Predeterminado para Móvil/Web)**: Características rápidas, estables y esenciales solamente. Previene fallos en teléfonos y tabletas.
- **Modo Completo (Usuario Avanzado de Escritorio)**: Conjunto completo de características, con una carga pesada de caché al iniciar (la prioridad de todos los Rems con tarjetas), que habilita cálculos estadísticos en tiempo real para análisis detallados.

### 🧰 Más que Lectura Incremental: un Conjunto de Herramientas para tu BC
Más allá del ciclo principal de aprendizaje, Incremental Everything incluye **docenas de utilidades independientes** que agilizan la toma de notas y la organización de tu base de conocimiento en el día a día — útiles incluso cuando no estás repasando. Algunos ejemplos:

- **Herramientas de esquema y encabezados**: [Reestructurar Esquema por Encabezados](https://hugomarins.github.io/incremental-everything/Utilities/#restructure-outline-by-headings) (reanida bajo sus encabezados un documento plano o mal pegado), [Aplicar Niveles de Encabezado por Jerarquía (Tabla de Contenidos)](https://hugomarins.github.io/incremental-everything/Utilities/#apply-heading-levels-by-hierarchy-table-of-contents) y [Establecer Siguiente Nivel de Encabezado](https://hugomarins.github.io/incremental-everything/Utilities/#set-next-heading-level) — todas con vista previa lado a lado y deshacer en un clic.
- **Control de la cola**: [Ocultar / Eliminar Padre y Abuelo, entre otras](https://hugomarins.github.io/incremental-everything/Utilities/#queue-display-utilities), para depurar cómo aparecen los Rems ancestros en tus tarjetas.
- **Ayudas de edición**: [Conversor de Mayúsculas/Minúsculas](https://hugomarins.github.io/incremental-everything/Utilities/#text-case-converter) (ciclo con Shift+F3, con reglas de capitalización para inglés y portugués) y [Convertir en Viñetas el Texto Seleccionado](https://hugomarins.github.io/incremental-everything/Utilities/#bulletize-inline-selected-text), para restaurar las viñetas que los resaltados de PDF aplanan.
- **Navegación y fuentes**: [Find Rem](https://hugomarins.github.io/incremental-everything/Utilities/#find-rem--reference-or-open) (encuentra Rems que la búsqueda `[[` de RemNote no muestra) y [Abrir Fuente en Popup / Ventana Flotante](https://hugomarins.github.io/incremental-everything/Utilities/#open-source-in-popup), para consultar un PDF o una web sin salir de la cola.
- **Analíticas y diagnóstico**: el [Panel de Estudio](https://hugomarins.github.io/incremental-everything/Study-Dashboard/) con estadísticas de aprendizaje de toda la base de conocimiento, y el [conjunto de Historiales y el Panel de Colas Practicadas](https://hugomarins.github.io/incremental-everything/History-Queue-Dashboard-and-Mastery-Drill/) para volver a cualquier documento, tarjeta o sesión pasada.
- **Detalle por elemento**: explora la línea de tiempo de un solo elemento con los popups de [Historial de Repeticiones de Tarjetas](https://hugomarins.github.io/incremental-everything/Plugin-Widgets-Reference/#211-flashcard-repetition-history) e [Historial de Repeticiones de IncRems](https://hugomarins.github.io/incremental-everything/Plugin-Widgets-Reference/#212-increm-repetition-history--aggregated-view) — este último con un **resumen agregado** de repeticiones, tiempo y conteos de todo el subárbol de descendientes de un Rem. Todo respaldado por un motor **FSRS v6** integrado que calcula Dificultad / Estabilidad / Recuperabilidad por tarjeta, además de un [desglose del Escudo ponderado por prioridad](https://hugomarins.github.io/incremental-everything/Prioritization-&-Sorting/#weighted-shield) en el que puedes hacer clic para ver qué parte de tu carga de trabajo ya has procesado.

👉 Consulta la página de **[Utilidades](https://hugomarins.github.io/incremental-everything/Utilities/)** para la lista completa, y la **[Referencia de Comandos del Complemento](https://hugomarins.github.io/incremental-everything/Plugin-Commands-Reference/)** para todos los comandos.

## Instalación

- Abre la [tienda de complementos de RemNote](https://www.remnote.com/plugins), busca "Incremental Everything" e instala el complemento.

## 📚 Documentación y Soporte

Este README cubre lo básico. Para las guías completas, por favor visita el **Manual de Usuario**:

👉 **[Incremental Everything — Manual de Usuario](https://hugomarins.github.io/incremental-everything/)**

*(La documentación dejó el Wiki de GitHub en agosto de 2026. El nuevo sitio permite búsqueda completa, funciona en móvil y tiene temas claro y oscuro — actualiza tus marcadores, por favor.)*

### 🎥 Videos sobre lo básico

- **Videos Introductorios**: 
  * [Lectura Incremental de Páginas Web en RemNote](https://youtu.be/eXRlfCTOQNw)
  * [Lectura Incremental en RemNote](https://youtu.be/SL7wjgntrbg)

- **Lista de Reproducción de Prioridades**: [Priorización en Incremental Everything](https://www.youtube.com/playlist?list=PLpmcfTqNVuo9DWjeIrMZZfG140kOZD8Tl) – Cubre la configuración de prioridades, herencia, el Escudo de Prioridad, creación de Documentos de Revisión Prioritaria y cómo usar la priorización para gestionar la sobrecarga de información.

- **¿Qué es la Lectura Incremental?**: [Viaje Incremental - Lectura Incremental en Términos Simples](https://youtu.be/V4xEziM8mco)

### Enlaces Útiles
- **[Registro de Cambios](https://hugomarins.github.io/incremental-everything/Changelog/)**: Mira las últimas características y actualizaciones.
- **[Discord](http://bit.ly/RemNoteDiscord)**: Únete a la comunidad y chatea con nosotros (busca los canales del complemento).


## Uso

### Empezando
1. **Hazlo Incremental**: Haz cualquier Rem, PDF o Sitio Web `Incremental` usando el comando `/Make Incremental (Extract)` (Atajo: `Alt+X`).
   * **Extraer Selección**: Si tienes texto seleccionado, `Alt+X` extraerá ese fragmento concreto a un nuevo Rem hijo y lo enlazará de vuelta.

![Hacer Incremental usando el comando](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/tag-inc-rem.gif)

2. **Priorízalo**: Usa `Alt+P` o `Alt+Shift+X` (Extraer con Prioridad) para establecer su importancia.
3. **Copiar/Pegar Fuentes**: Enlaza varios capítulos a un mismo PDF de forma eficiente con `Ctrl+Shift+F1` (Copiar) y `Alt+Shift+V` (Pegar).
4. **Crea Tarjetas**: Usa `Alt+Z` para crear rápidamente una **Cloze Deletion** a partir del texto seleccionado.
5. **Repásalo**: El complemento intercala estos elementos en tu cola regular de tarjetas.
6. **Desactívalo**: Elimina la etiqueta `Incremental` o presiona el botón **Dismiss** (Descartar) en la cola si has terminado de repasarlo.

### ⚡ Priorización y Ordenamiento
- 0 es para tu material más importante y 100 es para el menos importante.
- **Cambiar Prioridad**: Haz clic en el botón en la cola o presiona `Alt+P` para abrir la ventana emergente de prioridad completa.
- **Atajos Rápidos**: Usa `Ctrl+Opt+Arriba` / `Ctrl+Opt+Abajo` para ajustar la prioridad instantáneamente sin interrumpir el flujo.
- **Criterios de Ordenamiento**: Usa el menú de la cola para ajustar el equilibrio entre **Estructura** (prioridad estricta) y **Exploración** (aleatoriedad), y controlar la proporción de Tarjetas a Material de Lectura.

### Programación

- **Programador Predeterminado**: Usa una fórmula exponencial — `intervalo = ⌈Multiplicador ^ N⌉` días (el multiplicador es 1.5 por defecto). Simple y eficaz para elementos que necesitan pocas revisiones.
- **Programador Beta (Curva de Saturación)**: Una alternativa opcional en la que los intervalos comienzan en un *Intervalo de Primera Revisión* configurable (por defecto 5 días) y se acercan gradualmente a un *Intervalo Máximo* (por defecto 30 días). Ideal para elementos que necesitan muchas revisiones (libros, capítulos). Consulta la página [IncRem Scheduler](https://hugomarins.github.io/incremental-everything/IncRem-Scheduler/) para más detalles.
- Puedes establecer manualmente la próxima fecha de repetición usando el comando **Reprogramar** (**Ctrl+J**), o las funciones de tablas y propiedades de RemNote.

### 📱 Soporte Móvil
El complemento ahora cuenta con **Modo Ligero Automático**.
- Cuando abres RemNote en iOS o Android, el complemento cambia automáticamente a "Modo Ligero".
- Esto desactiva los cálculos pesados en segundo plano para asegurar una experiencia libre de fallos en dispositivos móviles.
- Tu experiencia de escritorio permanece con todas las funciones.

### Lectura Incremental

- Puedes etiquetar PDFs, sitios web y resaltados con la etiqueta `Incremental` para hacer lectura incremental clásica estilo SuperMemo.
- Funciona si etiquetas el PDF/sitio en sí, un Rem con una única fuente, o un Rem con **múltiples PDFs como fuente** — el complemento te permite alternar entre ellos al vuelo y fijar uno como el PDF *activo* para ese Inc Rem.
- El complemento renderizará la vista de lectura del PDF o sitio web dentro de la cola.
- Si quieres convertir un resaltado en un Rem incremental, haz clic en el resaltado y haz clic en el icono de la pieza de rompecabezas.
- 📄 **PDFs y Web**
  - **Estado Visual**: Los resaltados se vuelven **Verdes** cuando se activan como Incrementales, y **Azules** cuando se extraen.
  - **Insignias de Etiqueta**: Para no recargar el editor, las etiquetas `Incremental` y `pdfextract` se sustituyen por insignias compactas de emoji — **🔍** para `Incremental` y **✂️** para `pdfextract` — de modo que sigues identificando el tipo de elemento de un vistazo sin perder espacio horizontal.
  - **Panel de Control de PDF**: Gestiona capítulos, define rangos de páginas y consulta el historial de lectura para documentos largos.
  - **Selector multi-PDF** *(nuevo)*: Cuando un Inc Rem tiene múltiples PDFs como fuente, aparece un desplegable en el Reader (junto al ícono 📝 de Notas del Documento), en el Cronómetro de Revisión del Editor, en el popup de Ejecutar Repetición, en el Panel de Control de PDF y en la Barra de Herramientas del Editor — permitiéndote cambiar el PDF que se muestra y fijar uno como activo para ese Inc Rem. El orden de resolución es **fijación explícita → `#preferthispdf` → primer PDF**, aplicado de forma uniforme en todas las superficies.
  - **Seguimiento de Posición**: El complemento guarda automáticamente tu última página leída al usar el flujo de Capítulos de PDF o al crear extractos.
  - **Crear Rem Incremental**: Selecciona texto en un PDF -> Resáltalo -> Haz clic en el Icono de Rompecabezas -> **"Create Incremental Rem"**. Esto extrae el texto a un nuevo Rem bajo un padre de tu elección (usando el selector inteligente de padres).

![Barra de herramientas de resaltado de PDF](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/pdfhighlight-toolbar.png)

![Resaltar](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/highlight.gif)

### Escritura Incremental

- Puedes etiquetar cualquier Rem normal con la etiqueta `Incremental` para convertirlo en un Rem incremental.
- El complemento lo renderizará como un Rem normal en la vista de documento en la cola.

### Video Incremental

- Puedes etiquetar videos de YouTube con la etiqueta `Incremental` para verlos incrementalmente.
- Funcionará si etiquetas el Rem del enlace en sí, o un Rem con el enlace de YouTube como fuente.
- **Extractos de Video**: Crea subclips precisos con marcas de tiempo de inicio y fin, cada uno con su propia programación y prioridad.
- **Transcripción Automática**: Obtén automáticamente las transcripciones de YouTube para los rangos extraídos, dejando el contenido buscable y listo para clozes. [P.D.: actualmente fuera de servicio tras las recientes medidas anti-bot de YouTube]
- El complemento guardará automáticamente tu progreso y velocidad de reproducción.
- Puedes abrir la sección de notas redimensionable a la izquierda para tomar notas mientras ves.

![Video Incremental](https://hugomarins.github.io/incremental-everything/assets/YT-extract-mode.png)

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

Antes, las posiciones de lectura de PDFs grandes se perdían con facilidad.

  * **La Solución**: El complemento ahora admite un **flujo de trabajo por capítulos**. Al dividir un PDF en varios Rems Incrementales (cada uno con su rango de páginas definido) o al usar **Resaltados de PDF** como elementos incrementales, el complemento **guarda y restaura de forma fiable tu posición de lectura** para cada elemento concreto.
  * **El Reto Pendiente**: Aunque ya podemos rastrear la posición de cada elemento, el SDK de Complementos de RemNote sigue sin ofrecer control programático directo sobre el motor de desplazamiento interno del visor de PDF nativo. Es decir: podemos llevarte a la página correcta, pero todavía no controlar el desplazamiento vertical exacto dentro de esa página.
  * **Cómo Puedes Ayudar**: Seguimos abogando por una API de Complementos más robusta. Por favor, continúa votando nuestra solicitud de un mejor control programático del desplazamiento.

➡️ **[Vota la Solicitud de Función en el Sitio de Comentarios de RemNote](https://feedback.remnote.com/p/feature-request-programmatic-control-over-pdf-scroll-position-for-plugins?b=Plugin-Requests)**

### Edición de un Rem Incremental de tipo Rem en la Cola

Versiones anteriores incrustaban un editor **editable** para las tarjetas Rem normales directamente en la cola, pero los atajos de teclado nativos de la cola tenían prioridad sobre la escritura en él — un complemento no puede capturar completamente la entrada del teclado dentro del panel de la cola (Flashcard), ya que el editor es un "fake embed" renderizado en la ventana principal de RemNote mientras el complemento se ejecuta en un marco aislado (sandbox).

  * **La Solución**: La tarjeta de la cola para un Rem Incremental de tipo Rem ahora es una **vista previa de solo lectura** (que muestra el Rem y el subárbol de sus descendientes), por lo que no hay conflicto de teclado ni riesgo de que teclas accidentales califiquen/avancen la tarjeta. La edición se dirige a la **barra lateral de Notas del Documento**, que se abre automáticamente cuando se carga el elemento (un panel separado que mantiene el foco correctamente) — o haz clic en el botón **"✎ Editar en la barra lateral →"** de la tarjeta. El previsualizador **"Presiona 'P' para Editar"** y el botón **"Revisar en Editor"** siguen disponibles como alternativas.


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
