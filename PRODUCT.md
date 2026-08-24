# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Cuidadores familiares — normalmente um filho(a) adulto ou familiar próximo — responsáveis pela medicação de outra pessoa (ex: um idoso, "medicado"), e não apenas pela própria. Um mesmo titular de conta pode gerenciar vários "medicados" (pacientes). O cuidado pode ser compartilhado entre múltiplos cuidadores de um mesmo medicado, com papéis diferentes:
- **coadministrador**: registra doses, cria e edita medicamentos/receitas/consultas;
- **acompanhante**: só leitura + notificações de adesão.

## Product Purpose

Organizar a medicação da família "na hora certa": ler receitas médicas e notas fiscais por foto (IA) para estruturar medicamentos e doses automaticamente, lembrar horários de dose via push, e permitir que vários cuidadores acompanhem o mesmo paciente sem perder controle nem privacidade. Sucesso = doses tomadas no horário certo e nenhum cuidador "no escuro" sobre a adesão do medicado.

## Positioning

Diferenciais que um concorrente comum de "lembrete de remédio" não replica trivialmente:
1. **Leitura inteligente de receita/nota fiscal por IA** (Gemini) — foto vira medicamento/dose estruturado, sem digitação manual.
2. **Compartilhamento seguro entre cuidadores** — múltiplos cuidadores por paciente, com papéis granulares (coadministrador vs. acompanhante) e regras de privacidade rígidas por medicado (escopo por paciente, não pela conta inteira).
3. **PWA sem loja de aplicativo** — instala direto do navegador (Android/iOS/desktop), sem depender de App Store/Play Store.

## Operating Context

- App web/PWA instalável, usado no dia a dia para marcar doses tomadas/puladas/perdidas, cadastrar receitas e medicamentos, agendar consultas, e gerenciar farmácias favoritas.
- Fluxo típico: cuidador fotografa uma receita ou nota fiscal → IA extrai os dados → app agenda lembretes de dose (push) → cuidador(es) registram cada dose tomada → histórico de adesão fica visível para todos com acesso àquele medicado.
- Compartilhamento por convite (e-mail), aceito/revogado por medicado específico — o convidado só vê o paciente compartilhado com ele, nunca a conta inteira do titular.
- Monetização: assinatura via Mercado Pago (mensal/anual, BRL), com trial gratuito de 7 dias e limite de scans de IA durante o trial.
- Existe um Portal Admin separado (`/admin`), com login e permissões independentes do app do usuário final, para suporte/moderação (não é uma aba dentro do app do usuário).

## Capabilities and Constraints

- Extração por IA de receitas e notas fiscais depende de `GEMINI_API_KEY`; sem ela, a extração automática não funciona (scanners caem em amostra/mock apenas quando a chave está ausente — um erro real de API é mostrado ao usuário, não escondido).
- Notificações de dose são push (Web Push/VAPID) e dependem de o usuário ter instalado o PWA e concedido permissão.
- Autorização de admin é via custom claim no Firebase Auth (`admin: true`), não um campo editável no perfil — não há caminho de UI para "promover" alguém a admin.
- Dados de saúde (medicamentos, doses, receitas) são sensíveis (LGPD): minimização já aplicada em logs de auditoria (nomes de campos alterados, nunca valores, para entidades de saúde).
- Farmácias favoritas e notas fiscais/cupons ficam de propósito fora do compartilhamento entre cuidadores — não recebem `SharedAccess`.

## Brand Commitments

- Nome do produto: **Hora Certa AI**. Tagline da landing page: "Cuidar de quem você ama, na hora certa."
- Tokens de marca já em uso: `brand-teal`, `brand-coral`, `brand-cream`, `brand-peach` (com variantes `-light`/`-dark`/`-darker`); `font-display` para títulos e `font-sans` para corpo de texto.

## Evidence on Hand

- Landing page real em produção (`index.html`, root) com copy validada: eyebrows "LEITURA INTELIGENTE DE RECEITAS", "TODA A FAMÍLIA, UMA SÓ CONTA", "NUNCA MAIS NA HORA ERRADA", "PRIVACIDADE, NÃO SÓ PROMESSA", "SEM LOJA DE APLICATIVOS".
- Produto em produção real (não protótipo): cobrando assinaturas reais via Mercado Pago desde 2026-08-10, com domínio próprio (horacerta-ai.com).
- Sem depoimentos, cases ou métricas de uso publicados até o momento — não inventar prova social; qualquer testemunho futuro precisa ser real.

## Product Principles

1. Nenhuma feature de cuidado compartilhado pode vazar dados de um medicado para quem não tem acesso a ele — o escopo é sempre por paciente, nunca pela conta inteira.
2. IA remove digitação manual, mas nunca esconde falha real: erro de extração é mostrado, mock só substitui a ausência comprovada da funcionalidade (sem chave de API).
3. Instalação e uso não dependem de loja de aplicativo — o caminho PWA tem que continuar sendo o caminho principal, não um extra.
4. Dado de saúde é sensível por padrão: minimizar o que aparece em logs, exports e telas administrativas, mesmo quando isso reduz conveniência de depuração.
5. Confiança do cuidador vem de previsibilidade de horário — lembretes de dose e leitura de adesão são o núcleo do produto, não um recurso entre outros.
