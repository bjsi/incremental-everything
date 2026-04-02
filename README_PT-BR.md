# Incremental Everything

![Logo Incremental Everything](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/inc-logo.png)

🇺🇸 [English](https://github.com/bjsi/incremental-everything/blob/main/README.md) | 🇪🇸 [Español](https://github.com/bjsi/incremental-everything/blob/main/README_ES.md)

**Um Sistema Completo de Aprendizado para o RemNote.**

O Incremental Everything permite que você intercale suas revisões de flashcards com notas, livros, sites e vídeos. Fortemente inspirado na [Leitura Incremental](https://supermemo.guru/wiki/Incremental_reading) do SuperMemo, ele transforma o RemNote em uma poderosa ferramenta de aprendizado contínuo que lida com todo o ciclo de vida do conhecimento: **Aquisição → Processamento → Maestria**.

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
- **Escudo de Prioridade**: Uma ferramenta de diagnóstico em tempo real que mostra sua capacidade de processar material de alta prioridade.
- **Documentos de Revisão Prioritária**: Gere sessões de estudo focadas para seus N itens mais importantes (leitura passiva e flashcards) quando estiver sobrecarregado.

### 📱 Modos de Desempenho
- **Modo Leve (Padrão para Móvel/Web)**: Apenas funcionalidades rápidas, estáveis e essenciais. Previne travamentos em telefones e tablets.
- **Modo Completo (Usuário Avançado de Desktop)**: Conjunto completo de funcionalidades com cálculos estatísticos pesados para análises detalhadas.

## Instalação

- Abra a [loja de plugins do RemNote](https://www.remnote.com/plugins), procure por "Incremental Everything" e instale o plugin.

## 📚 Documentação e Suporte

Este README cobre o básico. Para os guias completos, visite o **Manual do Usuário**:

👉 **[Wiki do Incremental Everything](https://github.com/bjsi/incremental-everything/wiki)**

### 🎥 Vídeos sobre o básico

- **Vídeos Introdutórios**: 
  * [Leitura Incremental de Páginas Web no RemNote](https://youtu.be/eXRlfCTOQNw)
  * [Leitura Incremental no RemNote](https://youtu.be/SL7wjgntrbg)

- **Playlist de Prioridades**: [Priorização no Incremental Everything](https://www.youtube.com/playlist?list=PLpmcfTqNVuo9DWjeIrMZZfG140kOZD8Tl) – Cobre a configuração de prioridades, herança, o Escudo de Prioridade, criação de Documentos de Revisão Prioritária e como usar a priorização para gerenciar a sobrecarga de informações.

- **O que é Leitura Incremental?**: [Jornada Incremental - Leitura Incremental em Termos Simples](https://youtu.be/V4xEziM8mco)

### Links Úteis
- **[Histórico de Mudanças](https://github.com/bjsi/incremental-everything/wiki/Changelog)**: Veja as últimas funcionalidades e atualizações.
- **[Discord](http://bit.ly/RemNoteDiscord)**: Junte-se à comunidade e converse conosco (procure pelos canais do plugin).


## Uso

### Começando
1. **Torne Incremental**: Marque qualquer Rem, PDF ou Site como `Incremental` usando o comando `/Incremental Everything` (Atalho: `Alt+X`).

![Tornar Incremental usando o comando](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/tag-inc-rem.gif)

2. **Priorize**: Use `Alt+P` para definir sua importância.
3. **Revise**: O plugin intercala esses itens na sua fila regular de flashcards.
4. **Desative**: Remova a etiqueta `Incremental` ou pressione o botão **Dismiss** (Descartar) na fila se tiver terminado de revisar.

### ⚡ Priorização e Ordenação
- 0 é para seu material mais importante e 100 é para o menos importante.
- **Mudar Prioridade**: Clique no botão na fila ou pressione `Alt+P` para abrir o popup de prioridade completa.
- **Atalhos Rápidos**: Use `Ctrl+Opt+Cima` / `Ctrl+Opt+Baixo` para ajustar a prioridade instantaneamente sem interromper o fluxo.
- **Critérios de Ordenação**: Use o menu da fila para ajustar o equilíbrio entre **Estrutura** (prioridade estrita) e **Exploração** (aleatoriedade), e controlar a proporção de Flashcards para Material de Leitura.

### Agendamento

- **Agendador Padrão**: Usa uma fórmula exponencial — `intervalo = ⌈Multiplicador ^ N⌉` dias (o multiplicador é 1.5 por padrão). Simples e eficaz para itens que precisam de poucas revisões.
- **Agendador Beta (Curva de Saturação)**: Uma alternativa opcional onde os intervalos começam em um *Intervalo da Primeira Revisão* configurável (padrão 5 dias) e se aproximam gradualmente de um *Intervalo Máximo* (padrão 30 dias). Ideal para itens que precisam de muitas revisões (livros, capítulos). Consulte a página wiki [IncRem Scheduler](https://github.com/bjsi/incremental-everything/wiki/IncRem-Scheduler) para detalhes.
- Você pode definir manualmente a próxima data de repetição usando o comando **Reagendar** (**Ctrl+J**), ou os recursos de tabelas e propriedades do RemNote.

### 📱 Suporte Móvel
O plugin agora possui **Modo Leve Automático**.
- Quando você abre o RemNote no iOS ou Android, o plugin muda automaticamente para o "Modo Leve".
- Isso desabilita cálculos pesados em segundo plano para garantir uma experiência livre de travamentos em dispositivos móveis.
- Sua experiência no desktop permanece completa.

### Leitura Incremental

- Você pode marcar PDFs, sites e destaques com a etiqueta `Incremental` para fazer leitura incremental clássica estilo SuperMemo.
- Funcionará se você marcar o PDF ou site em si, ou um Rem com um único PDF ou site como fonte.
- O plugin renderizará a visualização de leitura do PDF ou site dentro da fila.
- Se você quiser transformar um destaque em um Rem incremental, clique no destaque e clique no ícone da peça de quebra-cabeça.
- ** 📄 PDFs e Web**
  - **Estado Visual**: Os destaques ficam **Verdes** quando alternados como Incrementais e **Azuis** quando extraídos.
  - **Criar Rem Incremental**: Selecione o texto em um PDF -> Destaque-o -> Clique no ícone de quebra-cabeça -> **"Create Incremental Rem"**. Isso extrai o texto para um novo Rem sob um pai de sua escolha (usando o seletor inteligente de pais).
![Destacar](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/highlight.gif)

### Escrita Incremental

- Você pode marcar qualquer Rem normal com a etiqueta `Incremental` para transformá-lo em um Rem incremental.
- O plugin irá renderizá-lo como um Rem normal na visualização de documento na fila.

### Vídeo Incremental

- Você pode marcar vídeos do YouTube com a etiqueta `Incremental` para assisti-los incrementalmente.
- Funcionará se você marcar o Rem do link em si, ou um Rem com o link do YouTube como fonte.
- O plugin salvará automaticamente seu progresso e velocidade de reprodução.
- Você pode abrir a seção de notas redimensionável à esquerda para fazer anotações enquanto assiste.

![Vídeo Incremental](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/inc-vid.png)

### Matemática Incremental

- Um exemplo rápido de interoperabilidade de plugins.
- Integra-se com meu [plugin de prova de teoremas Lean](https://github.com/bjsi/remnote-lean) para agendar conjuntos de problemas de provas matemáticas ao longo do tempo.
- O plugin Lean fornece o widget de fila e o plugin Incremental Everything fornece o agendamento.
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

Ao ler um PDF grande (como um livro) como um Rem incremental regular, o plugin pode não retornar de forma confiável ao seu último ponto de leitura incremental.

  * **O Problema**: Se você abrir e rolar o mesmo PDF em outra janela ou aba, sua posição de leitura incremental será perdida. O visualizador de PDF nativo do RemNote lembra apenas a posição mais recente de um documento, o que sobrescreve a posição da sua sessão de leitura incremental. Isso também significa que você não pode ter vários Rems incrementais para capítulos diferentes do mesmo arquivo PDF, pois todos compartilhariam a mesma posição de rolagem.
  * **A Causa**: Isso se deve a uma limitação no SDK de Plugins do RemNote atual. O plugin carece das ferramentas necessárias para salvar e restaurar programaticamente uma posição de rolagem específica para um PDF e deve depender do comportamento padrão do RemNote.
  * **Como Você Pode Ajudar**: Para corrigir isso, precisamos que os desenvolvedores do RemNote expandam as capacidades de sua API de Plugins. Enviamos uma Solicitação de Recurso pedindo essas ferramentas. Por favor, ajude-nos votando na solicitação na plataforma de feedback do RemNote. Mais votos aumentarão sua prioridade.

➡️ **[Vote na Solicitação de Recurso no Site de Feedback do RemNote](https://feedback.remnote.com/p/feature-request-programmatic-control-over-pdf-scroll-position-for-plugins?b=Plugin-Requests)**

### Conflito de Atalhos de Teclado:

Ao visualizar um cartão Rem regular na fila, o editor aparece corretamente. No entanto, os atalhos de teclado nativos da fila terão precedência sobre a digitação no editor. Isso parece ser devido a uma limitação na API atual do plugin que impede que um plugin capture completamente a entrada do teclado dentro do ambiente da fila. O botão "Pressione 'P' para Editar" foi adicionado como uma solução alternativa. Você também pode usar o botão recém-criado "Revisar no Editor".


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
