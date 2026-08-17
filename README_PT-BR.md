# Incremental RemNote

![Logo Incremental RemNote](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/inc-logo.png)

🇺🇸 [English](https://github.com/bjsi/incremental-everything/blob/main/README.md) | 🇪🇸 [Español](https://github.com/bjsi/incremental-everything/blob/main/README_ES.md)

**Um Sistema Completo de Aprendizado para o RemNote.**

O Incremental RemNote permite que você intercale suas revisões de flashcards com notas, livros, sites e vídeos. Fortemente inspirado na [Leitura Incremental](https://supermemo.guru/wiki/Incremental_reading) do SuperMemo, ele transforma o RemNote em uma poderosa ferramenta de aprendizado contínuo que lida com todo o ciclo de vida do conhecimento: **Aquisição → Processamento → Maestria**.

## 🚀 Funcionalidades

### O Ciclo Principal
- **Leitura Incremental**: Leia e revise milhares de notas, livros e sites em paralelo. [Saiba mais](https://www.youtube.com/watch?v=oNCLLNZEtz0).
- **Escrita Incremental**: Escreva seus ensaios e postagens de blog de forma incremental para maximizar a criatividade. [Saiba mais](https://www.youtube.com/watch?v=LLS_8Y744lk).
- **Vídeo Incremental**: Assista e faça anotações da sua lista de vídeos do YouTube pendentes.
- **Tarefas Incrementais**: Limpe sua lista de tarefas entre as revisões de flashcards.

### 🧠 Priorização Avançada
Gerencie a sobrecarga de informações com um sistema robusto de prioridade dupla:
- **Prioridades Absolutas e Relativas**: Priorize itens de 0 a 100 e veja exatamente onde eles se classificam na sua base de conhecimento.
- **Herança de Prioridade**: Novos extratos e flashcards herdam automaticamente a prioridade de seu material de origem.
- **Escudo de Prioridade e Escudo Ponderado**: Ferramentas de diagnóstico que mostram sua capacidade de processar material de alta prioridade e a fração da sua fila total, ponderada por prioridade, que você já processou.
- **Análises FSRS**: Estatísticas de Dificuldade (D), Estabilidade (S) e Recuperabilidade (R) calculadas em tempo real para seus flashcards.
- **Documentos de Revisão Prioritária**: Gere sessões de estudo focadas para seus N itens mais importantes (leitura passiva e flashcards) quando estiver sobrecarregado.

### 📊 Histórico, Painel e Mastery Drill *(novo na v0.2.182)*
Um conjunto completo de ferramentas de histórico e prática, agora integrado à barra lateral direita:
- **Histórico de Rems Visitados**: volte de imediato a qualquer documento que você acessou recentemente.
- **Histórico de Flashcards**: encontre e abra qualquer flashcard que você revisou, com busca pelo texto da frente e do verso.
- **Painel de Filas Praticadas**: métricas da sessão em tempo real (velocidade, retenção, idade dos cards) e um histórico completo de cada sessão de prática, com backup via Exportar/Importar.
- **Mastery Drill**: uma fila de repráctica focada nos cards que você avaliou como *Forgot* ou *Hard* — inspirada no Final Drill do SuperMemo. Abra pelo comando `Mastery Drill` ou pela notificação na Barra Lateral Esquerda.

👉 [Documentação completa](https://hugomarins.github.io/incremental-remnote/History-Queue-Dashboard-and-Mastery-Drill/)

### 📱 Modos de Desempenho
- **Modo Leve (Padrão para Móvel/Web)**: Apenas funcionalidades rápidas, estáveis e essenciais. Previne travamentos em telefones e tablets.
- **Modo Completo (Usuário Avançado de Desktop)**: Conjunto completo de funcionalidades, com uma carga pesada de cache na inicialização (a prioridade de todos os Rems com flashcards), que habilita cálculos estatísticos em tempo real para análises detalhadas.

### 🧰 Mais que Leitura Incremental: um Conjunto de Ferramentas para sua BC
Além do ciclo principal de aprendizado, o Incremental RemNote traz **dezenas de utilitários independentes** que tornam mais rápido o dia a dia de tomar notas e organizar sua base de conhecimento — úteis mesmo quando você não está revisando. Alguns exemplos:

- **Ferramentas de estrutura e títulos**: [Reestruturar Outline por Títulos](https://hugomarins.github.io/incremental-remnote/Utilities/#restructure-outline-by-headings) (reaninha sob seus títulos um documento plano ou mal colado), [Aplicar Níveis de Título por Hierarquia (Sumário)](https://hugomarins.github.io/incremental-remnote/Utilities/#apply-heading-levels-by-hierarchy-table-of-contents) e [Definir Próximo Nível de Título](https://hugomarins.github.io/incremental-remnote/Utilities/#set-next-heading-level) — todas com pré-visualização lado a lado e desfazer em um clique.
- **Controle de exibição na fila**: [Ocultar / Remover Pai e Avô, entre outros](https://hugomarins.github.io/incremental-remnote/Utilities/#queue-display-utilities), para limpar como os Rems ancestrais aparecem nos seus flashcards.
- **Auxiliares de edição**: [Conversor de Maiúsculas/Minúsculas](https://hugomarins.github.io/incremental-remnote/Utilities/#text-case-converter) (ciclo com Shift+F3, com regras de capitalização para inglês e português) e [Transformar Texto Selecionado em Tópicos](https://hugomarins.github.io/incremental-remnote/Utilities/#bulletize-inline-selected-text), para restaurar os bullets que os destaques de PDF achatam.
- **Navegação e fontes**: [Find Rem](https://hugomarins.github.io/incremental-remnote/Utilities/#find-rem--reference-or-open) (revela Rems que a busca `[[` do RemNote não encontra) e [Abrir Fonte em Popup / Janela Flutuante](https://hugomarins.github.io/incremental-remnote/Utilities/#open-source-in-popup), para consultar um PDF ou site sem sair da fila.
- **Análises e diagnóstico**: o [Painel de Estudos](https://hugomarins.github.io/incremental-remnote/Study-Dashboard/) com estatísticas de aprendizado de toda a base de conhecimento, e o [conjunto de Históricos e o Painel de Filas Praticadas](https://hugomarins.github.io/incremental-remnote/History-Queue-Dashboard-and-Mastery-Drill/) para revisitar qualquer documento, flashcard ou sessão passada.
- **Detalhe por item**: explore a linha do tempo de um único item com os popups de [Histórico de Repetições de Flashcards](https://hugomarins.github.io/incremental-remnote/Plugin-Widgets-Reference/#211-flashcard-repetition-history) e [Histórico de Repetições de IncRems](https://hugomarins.github.io/incremental-remnote/Plugin-Widgets-Reference/#212-increm-repetition-history--aggregated-view) — este último com um **resumo agregado** de repetições, tempo e contagens de toda a subárvore de descendentes de um Rem. Tudo apoiado por um motor **FSRS v6** embutido que calcula Dificuldade / Estabilidade / Recuperabilidade por card, além de um [detalhamento do Escudo ponderado por prioridade](https://hugomarins.github.io/incremental-remnote/Prioritization-&-Sorting/#weighted-shield) clicável, mostrando quanto da sua carga de trabalho você já processou.

👉 Veja a página de **[Utilitários](https://hugomarins.github.io/incremental-remnote/Utilities/)** para a lista completa, e a **[Referência de Comandos do Plugin](https://hugomarins.github.io/incremental-remnote/Plugin-Commands-Reference/)** para todos os comandos.

## Instalação

- Abra a [loja de plugins do RemNote](https://www.remnote.com/plugins), procure por "Incremental RemNote" e instale o plugin.

## 📚 Documentação e Suporte

Este README cobre o básico. Para os guias completos, visite o **Manual do Usuário**:

👉 **[Incremental RemNote — Manual do Usuário](https://hugomarins.github.io/incremental-remnote/)**

*(A documentação saiu do Wiki do GitHub em agosto de 2026. O novo site tem busca completa, funciona no celular e possui temas claro e escuro — atualize seus favoritos, por favor.)*

### 🎥 Vídeos sobre o básico

- **Vídeos Introdutórios**: 
  * [Leitura Incremental de Páginas Web no RemNote](https://youtu.be/eXRlfCTOQNw)
  * [Leitura Incremental no RemNote](https://youtu.be/SL7wjgntrbg)

- **Playlist de Prioridades**: [Priorização no Incremental RemNote](https://www.youtube.com/playlist?list=PLpmcfTqNVuo9DWjeIrMZZfG140kOZD8Tl) – Cobre a configuração de prioridades, herança, o Escudo de Prioridade, criação de Documentos de Revisão Prioritária e como usar a priorização para gerenciar a sobrecarga de informações.

- **O que é Leitura Incremental?**: [Jornada Incremental - Leitura Incremental em Termos Simples](https://youtu.be/V4xEziM8mco)

### Links Úteis
- **[Histórico de Mudanças](https://hugomarins.github.io/incremental-remnote/Changelog/)**: Veja as últimas funcionalidades e atualizações.
- **[Discord](http://bit.ly/RemNoteDiscord)**: Junte-se à comunidade e converse conosco (procure pelos canais do plugin).


## Uso

### Começando
1. **Torne Incremental**: Marque qualquer Rem, PDF ou Site como `Incremental` usando o comando `/Make Incremental (Extract)` (Atalho: `Alt+X`).
   * **Extrair Seleção**: Se você tiver texto selecionado, `Alt+X` extrairá aquele trecho específico para um novo Rem filho e o vinculará de volta.

![Tornar Incremental usando o comando](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/tag-inc-rem.gif)

2. **Priorize**: Use `Alt+P` ou `Alt+Shift+X` (Extrair com Prioridade) para definir sua importância.
3. **Copiar/Colar Fontes**: Vincule vários capítulos a um mesmo PDF de forma eficiente com `Ctrl+Shift+F1` (Copiar) e `Alt+Shift+V` (Colar).
4. **Crie Flashcards**: Use `Alt+Z` para criar rapidamente uma **Cloze Deletion** a partir do texto selecionado.
5. **Revise**: O plugin intercala esses itens na sua fila regular de flashcards.
6. **Desative**: Remova a etiqueta `Incremental` ou pressione o botão **Dismiss** (Descartar) na fila se tiver terminado de revisar.

### ⚡ Priorização e Ordenação
- 0 é para seu material mais importante e 100 é para o menos importante.
- **Mudar Prioridade**: Clique no botão na fila ou pressione `Alt+P` para abrir o popup de prioridade completa.
- **Atalhos Rápidos**: Use `Ctrl+Opt+Cima` / `Ctrl+Opt+Baixo` para ajustar a prioridade instantaneamente sem interromper o fluxo.
- **Critérios de Ordenação**: Use o menu da fila para ajustar o equilíbrio entre **Estrutura** (prioridade estrita) e **Exploração** (aleatoriedade), e controlar a proporção de Flashcards para Material de Leitura.

### Agendamento

- **Agendador Padrão**: Usa uma fórmula exponencial — `intervalo = ⌈Multiplicador ^ N⌉` dias (o multiplicador é 1.5 por padrão). Simples e eficaz para itens que precisam de poucas revisões.
- **Agendador Beta (Curva de Saturação)**: Uma alternativa opcional onde os intervalos começam em um *Intervalo da Primeira Revisão* configurável (padrão 5 dias) e se aproximam gradualmente de um *Intervalo Máximo* (padrão 30 dias). Ideal para itens que precisam de muitas revisões (livros, capítulos). Consulte a página [IncRem Scheduler](https://hugomarins.github.io/incremental-remnote/IncRem-Scheduler/) para detalhes.
- Você pode definir manualmente a próxima data de repetição usando o comando **Reagendar** (**Ctrl+J**), ou os recursos de tabelas e propriedades do RemNote.

### 📱 Suporte Móvel
O plugin agora possui **Modo Leve Automático**.
- Quando você abre o RemNote no iOS ou Android, o plugin muda automaticamente para o "Modo Leve".
- Isso desabilita cálculos pesados em segundo plano para garantir uma experiência livre de travamentos em dispositivos móveis.
- Sua experiência no desktop permanece completa.

### Leitura Incremental

- Você pode marcar PDFs, sites e destaques com a etiqueta `Incremental` para fazer leitura incremental clássica estilo SuperMemo.
- Funciona se você marcar o PDF/site em si, um Rem com uma única fonte, ou um Rem com **múltiplos PDFs como fonte** — o plugin permite alternar entre eles e fixar um como o PDF *ativo* para aquele Inc Rem.
- O plugin renderizará a visualização de leitura do PDF ou site dentro da fila.
- Se você quiser transformar um destaque em um Rem incremental, clique no destaque e clique no ícone da peça de quebra-cabeça.
- 📄 **PDFs e Web**
  - **Estado Visual**: Os destaques ficam **Verdes** quando alternados como Incrementais e **Azuis** quando extraídos.
  - **Selos de Etiqueta**: Para não poluir o editor, as etiquetas `Incremental` e `pdfextract` são substituídas por selos compactos de emoji — **🔍** para `Incremental` e **✂️** para `pdfextract` — assim você continua identificando o tipo de item num relance, sem perder espaço horizontal.
  - **Painel de Controle de PDF**: Gerencie capítulos, defina intervalos de páginas e veja o histórico de leitura para documentos longos.
  - **Seletor multi-PDF** *(novo)*: Quando um Inc Rem tem múltiplos PDFs como fonte, um dropdown aparece no Reader (ao lado do ícone 📝 de Notas do Documento), no Cronômetro de Revisão no Editor, no popup de Executar Repetição, no Painel de Controle de PDF e na Barra de Ferramentas do Editor — permitindo alternar o PDF em exibição e fixar um como ativo para aquele Inc Rem. A ordem de resolução é **fixação explícita → `#preferthispdf` → primeiro PDF**, aplicada uniformemente em todas as superfícies.
  - **Rastreamento de Posição**: O plugin salva automaticamente sua última página lida ao usar o fluxo de Capítulos de PDF ou ao criar extrações.
  - **Criar Rem Incremental**: Selecione o texto em um PDF -> Destaque-o -> Clique no ícone de quebra-cabeça -> **"Create Incremental Rem"**. Isso extrai o texto para um novo Rem sob um pai de sua escolha (usando o seletor inteligente de pais).

![Barra de ferramentas de destaque de PDF](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/pdfhighlight-toolbar.png)

![Destacar](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/highlight.gif)

### Escrita Incremental

- Você pode marcar qualquer Rem normal com a etiqueta `Incremental` para transformá-lo em um Rem incremental.
- O plugin irá renderizá-lo como um Rem normal na visualização de documento na fila.

### Vídeo Incremental

- Você pode marcar vídeos do YouTube com a etiqueta `Incremental` para assisti-los incrementalmente.
- Funcionará se você marcar o Rem do link em si, ou um Rem com o link do YouTube como fonte.
- **Extrações de Vídeo**: Crie subtrechos precisos com marcações de início e fim, cada um com seu próprio agendamento e prioridade.
- **Transcrição Automática**: Busque automaticamente as transcrições do YouTube para os intervalos extraídos, deixando o conteúdo pesquisável e pronto para clozes. [P.S.: atualmente fora do ar após as recentes medidas anti-bot do YouTube]
- O plugin salvará automaticamente seu progresso e velocidade de reprodução.
- Você pode abrir a seção de notas redimensionável à esquerda para fazer anotações enquanto assiste.

![Vídeo Incremental](https://hugomarins.github.io/incremental-remnote/assets/YT-extract-mode.png)

### Matemática Incremental

- Um exemplo rápido de interoperabilidade de plugins.
- Integra-se com meu [plugin de prova de teoremas Lean](https://github.com/bjsi/remnote-lean) para agendar conjuntos de problemas de provas matemáticas ao longo do tempo.
- O plugin Lean fornece o widget de fila e o plugin Incremental RemNote fornece o agendamento.
- Espero que outros desenvolvedores possam construir integrações semelhantes com seus plugins!

![Matemática Incremental](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/lean.png)

### Revisão de Subconjuntos

- Você pode fazer revisões básicas de subconjuntos estudando um documento em particular. Apenas Rems desse documento serão mostrados a você.
- Você também pode criar uma tabela a partir da etiqueta `Incremental` e filtrá-la para um subconjunto ordenado usando os recursos de filtro e ordenação de tabelas.
- Você pode revisar as linhas de uma tabela em ordem classificando a tabela e usando o modo de prática "Praticar em Ordem".

Existem muitas maneiras de filtrar a tabela para criar um subconjunto de Rem para revisar. Aqui estão alguns exemplos:

- Apenas extratos da Web

![Filtro de apenas extratos](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/only-extracts.png)

- Apenas vídeos do YouTube

![Filtro de apenas vídeos do YouTube](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/inc-vid-filter.png)


## Problemas Conhecidos

### Posição de Leitura Incremental de PDF

Antes, as posições de leitura de PDFs grandes se perdiam com facilidade.

  * **A Solução**: O plugin agora suporta um **fluxo de trabalho por capítulos**. Ao dividir um PDF em vários Rems Incrementais (cada um com seu intervalo de páginas definido) ou ao usar **Destaques de PDF** como itens incrementais, o plugin **salva e restaura de forma confiável a sua posição de leitura** para cada item específico.
  * **O Desafio Remanescente**: Embora já consigamos rastrear a posição de cada item, o SDK de Plugins do RemNote ainda não oferece controle programático direto sobre o motor de rolagem interno do visualizador de PDF nativo. Ou seja: conseguimos levar você até a página correta, mas ainda não controlar a rolagem vertical exata dentro dessa página.
  * **Como Você Pode Ajudar**: Seguimos defendendo uma API de Plugins mais robusta. Por favor, continue votando em nosso pedido por um melhor controle programático da rolagem.

➡️ **[Vote na Solicitação de Recurso no Site de Feedback do RemNote](https://feedback.remnote.com/p/feature-request-programmatic-control-over-pdf-scroll-position-for-plugins?b=Plugin-Requests)**

### Editando um Rem Incremental do tipo Rem na Fila

Versões anteriores embutiam um editor **editável** para cartões Rem comuns diretamente na fila, mas os atalhos de teclado nativos da fila tinham precedência sobre a digitação nele — um plugin não consegue capturar totalmente a entrada do teclado dentro do painel da fila (Flashcard), já que o editor é um "fake embed" renderizado na janela principal do RemNote enquanto o plugin roda em um frame isolado (sandbox).

  * **A Solução**: O cartão da fila para um Rem Incremental do tipo Rem agora é uma **prévia somente leitura** (mostrando o Rem e a sub-árvore de seus descendentes), então não há conflito de teclado nem risco de teclas acidentais avaliarem/avançarem o cartão. A edição é direcionada para a **barra lateral de Notas do Documento**, que abre automaticamente quando o item é carregado (um painel separado que mantém o foco corretamente) — ou clique no botão **"✎ Editar na barra lateral →"** do cartão. O previsualizador **"Pressione 'P' para Editar"** e o botão **"Revisar no Editor"** continuam disponíveis como alternativas.


## Detalhes de Desenvolvimento

- O plugin armazena dados de repetição como propriedades powerup no Rem. Estes não são flashcards "normais" do RemNote. Todo o agendamento é gerenciado internamente pelo plugin.

### Como Desenvolver

Execute os seguintes comandos:

```sh
git clone https://github.com/bjsi/incremental-everything
cd incremental-everything
npm i
npm run dev
```

Em seguida, siga [esta parte do guia de início rápido](https://plugins.remnote.com/getting-started/quick_start_guide#run-the-plugin-template-inside-remnote) para fazer o plugin funcionar no RemNote.
