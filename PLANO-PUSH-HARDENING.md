# Plano: hardening do pipeline de Web Push

Documento autocontido. Foi escrito a partir de uma auditoria de leitura deste
repositório, motivada por um bug real diagnosticado em produção num projeto
irmão (DoseCerta-AI). Não presuma contexto de nenhuma conversa anterior.

## Contexto

O projeto irmão passou dias com o seguinte sintoma: as rotinas agendadas
registravam `notificados: 2`, o provedor de push aceitava o envio sem erro, os
logs ficavam limpos — e ninguém recebia notificação nenhuma. A causa foi um
registro de dispositivo obsoleto que o provedor continuava aceitando. Como
nada media *recebimento de fato*, a falha era invisível e permanente.

A lição que transfere para cá: **"o provedor aceitou" não é prova de entrega.**
Todo ponto onde o pipeline conclui sucesso sem evidência do lado do aparelho é
um lugar onde uma falha pode ficar invisível para sempre.

Esta auditoria encontrou **um bug concreto** (item 1), **um risco de escala**
(item 2) e **uma lacuna de diagnóstico** (item 3).

## IMPORTANTE — o que já está correto, não "conserte"

Esta base já resolve bem várias coisas que o projeto irmão errou. Confirme
antes de mexer, e **não regrida** nenhum destes pontos:

- **Inscrições em subcoleção** (`pushSubscriptions`), nunca em array no doc do
  usuário. É o modelo certo.
- **Idempotência por mensagem** em `pushToRecipients` (`server/app.ts`): um
  `dispatchRef.create()` atômico com `dedupeKey` por destinatário. `create()`
  falha se o doc já existe, então duas invocações concorrentes do cron não
  duplicam envio. Isto é **melhor** que um lock de execução grosso, porque a
  falha de um destinatário não bloqueia a rodada inteira. Mantenha.
- **Inscrição morta tratada corretamente**: `statusCode === 404 || 410` →
  `sub.ref.delete()`. O Web Push puro dá esse sinal definitivo (o FCM não dá),
  e é o que evita aqui o bug que derrubou o projeto irmão.
- **`CRON_SECRET` com `timingSafeEqual`** na rota de dispatch.
- **Sem PHI no corpo do push** (nome do paciente / medicamento / dosagem fora
  da tela de bloqueio). Mantenha essa política ao mexer no payload.

---

## Item 1 — BUG: `pushDispatches.expiresAt` é string, o TTL nativo nunca expurga

**Prioridade: alta.** É o único bug de verdade encontrado.

### Evidência

Em `server/app.ts`, dentro de `pushToRecipients`, o doc de dedupe é criado com:

```ts
expiresAt: new Date(nowMs + DISPATCH_TTL_MS).toISOString(),   // ← STRING
```

Mas o TTL nativo do Firestore **só age sobre campo do tipo `Timestamp`**. Um
campo string é ignorado pela política, silenciosamente.

O próprio código já documenta essa regra, no bloco de retenção de logs:

```
// Cada coleção de log carrega um `expiresAt` (Timestamp) para que o TTL NATIVO
// do Firestore as expurgue sozinho — sem isso elas crescem para sempre.
// ATENÇÃO: gravar o campo não basta. A política de TTL precisa ser criada UMA
// VEZ por coleção no console (Firestore > TTL) ou via gcloud.
```

E os logs fazem certo, via helper:

```ts
function expiresInDays(days: number): Timestamp {
  return Timestamp.fromDate(new Date(Date.now() + days * 24 * 60 * 60 * 1000));
}
```

`pushDispatches` é a exceção que escapou do padrão.

### Impacto

Um doc de dedupe é criado **por destinatário, por dose**. Com o cron rodando a
cada minuto (`vercel.json`: `"schedule": "* * * * *"`), isso cresce de forma
ilimitada e nunca é expurgado — nem hoje, nem depois de alguém habilitar a
política de TTL, porque a política não enxerga string.

### Correção

1. Trocar por `Timestamp`, reaproveitando o padrão já existente no arquivo:
   ```ts
   expiresAt: Timestamp.fromMillis(nowMs + DISPATCH_TTL_MS),
   ```
   (`createdAt` também é string hoje; converta junto por consistência, mas o
   que o TTL exige é só o `expiresAt`.)

2. Habilitar a política de TTL uma vez, como o comentário do próprio código
   instrui:
   ```
   gcloud firestore fields ttls update expiresAt \
     --collection-group=pushDispatches --enable-ttl --database=<DATABASE_ID>
   ```

3. **Limpeza dos docs antigos.** Os já gravados com string nunca expiram, mesmo
   após a correção. É preciso uma varredura única que apague os
   `pushDispatches` cujo `expiresAt` seja string (ou simplesmente todos os mais
   antigos que `DISPATCH_TTL_MS`, já que o dedupe só precisa valer dentro da
   janela da dose). Faça em batches de até 500 operações.

### ATENÇÃO — verifique antes de mexer no valor do TTL

`DISPATCH_TTL_MS` hoje é 15 minutos. O `dedupeKey` é `dose_${medId}_${doseMs}`.
Se o mesmo `doseMs` puder continuar sendo retornado como "vencido" por
`dueDoseMs()` por **mais** de 15 minutos, expirar o doc de dedupe reabre a
porta para reenvio duplicado da mesma dose.

Antes de fechar este item, leia `src/utils/doseSchedule.ts` (`dueDoseMs`) e a
constante `MISSED_DOSE_GRACE_MS`, e confirme que `DISPATCH_TTL_MS` é
confortavelmente maior que a janela em que a mesma dose permanece elegível —
nos dois jobs (`dispatchDueReminders` e `dispatchMissedDoseAlerts`, que usam
chaves de dedupe diferentes). Se não for, **aumente o TTL** em vez de aceitar o
risco de duplicidade.

---

## Item 2 — Escala: quatro varreduras completas por minuto

**Prioridade: média.** Não dói hoje; é dívida que cresce com a base.

### Evidência

`vercel.json` agenda `/api/push/dispatch` a cada minuto. A rota chama
`dispatchDueReminders()` e depois `dispatchMissedDoseAlerts()`. **Cada um dos
dois** faz:

```ts
await loadSubscriptionsByUser(db);                    // collectionGroup("pushSubscriptions").get()
await db.collectionGroup("medicamentos").where("status", "==", "active").get();
```

São 4 varreduras completas por minuto — ~5.760 por dia — e o custo é
proporcional ao **total** da base, não ao que é relevante naquele minuto. É o
mesmo problema que o projeto irmão teve, só que ali eram 7 varreduras por dia.
Além do custo, é risco de timeout da function conforme a base crescer.

### Correção, em duas etapas

**(a) Barata, e o próprio código já a antecipa.** O comentário de
`loadSubscriptionsByUser` diz:

```
// Cada job faz a sua própria varredura (são duas por minuto de cron); se isso
// pesar, o passo seguinte é receber o mapa por parâmetro em vez de recarregá-lo.
```

Faça exatamente isso: carregue `subsByUser` **e** o snapshot de medicamentos
ativos uma vez na rota `/api/push/dispatch`, e passe ambos por parâmetro para
os dois jobs. Corta as varreduras pela metade sem mudar nenhuma regra de
negócio. Preserve o `try/catch` separado que já existe ali (uma falha no alerta
de dose perdida não pode derrubar o lembrete comum).

**(b) A correção real de escala.** Estreitar a query de medicamentos para ler
só o que pode disparar neste minuto, em vez de todos os ativos. O caminho é
denormalizar um campo com o instante da próxima dose (ex.: `proximaDoseEm`,
mantido na escrita do medicamento) e consultar por intervalo:

```ts
.where("status", "==", "active")
.where("proximaDoseEm", ">=", inicioJanela)
.where("proximaDoseEm", "<=", fimJanela)
```

Isso exige índice composto em `firestore.indexes.json` e uma decisão sobre quem
mantém o campo atualizado. **Avalie o custo/benefício antes de implementar** —
se a base ainda é pequena, (a) sozinho pode bastar por um bom tempo. Não faça
(b) por completude; faça se os números justificarem.

---

## Item 3 — Diagnóstico: não há confirmação de recebimento

**Prioridade: baixa. Avalie se vale — é um trade-off legítimo, não um bug.**

Não existe nada que registre que o Service Worker realmente acordou e exibiu a
notificação. Consequência: se o push for aceito (`201`) mas o Service Worker
nunca acordar do outro lado — cenário real em PWA no iOS —, isso é
**invisível** aqui, e não há como diagnosticar depois.

**Por que a prioridade é baixa mesmo assim:** o tratamento de `404/410` já
cobre a maior parte dos casos de inscrição morta de verdade, e o Web Push puro
dá esse sinal de forma confiável (foi a ausência dele no FCM que criou o
problema no projeto irmão). O risco residual é menor aqui.

Se decidir implementar, o padrão que funcionou no projeto irmão foi:

- Um endpoint público sem auth (o evento `push` no Service Worker não tem
  sessão) que recebe `{ uid, dispositivoId }` e grava `ultimoRecebimentoEm` +
  zera um contador `enviosSemConfirmacao` no doc da inscrição.
- No Service Worker, chamar esse endpoint junto com o `showNotification`.
- No envio, incrementar `enviosSemConfirmacao` por inscrição.

**Duas armadilhas aprendidas na marra, se for por esse caminho:**

1. **Não bloqueie o `waitUntil` na confirmação.** Se o `waitUntil` só resolver
   quando o `fetch` de confirmação resolver, e esse endpoint tiver cold start
   de alguns segundos, o Service Worker fica vivo esperando — consumindo
   orçamento de execução que o iOS pode cobrar do próximo push da sequência.
   Dê um timeout curto (~1s) à confirmação.

2. **Poda por silêncio acumulado, nunca por "nunca confirmou".** O bug do
   projeto irmão foi exatamente esse: só podava quem jamais tinha confirmado,
   então um registro que confirmou **uma vez** e depois morreu ficava marcado
   como saudável para sempre, imune à poda. Se implementar contador, o critério
   de descarte tem que ser o silêncio acumulado atual, independente do
   histórico.

---

## Ordem sugerida

1. Item 1 (bug real, escopo pequeno, alto valor).
2. Item 2(a) (trivial, o código já pede).
3. Reavaliar 2(b) e 3 com números na mão, sem compromisso de fazer.

## Verificação

- `npx tsc --noEmit` (ou o script de build do projeto) limpo.
- **Item 1:** criar um dispatch em ambiente de teste e conferir no console do
  Firestore que `expiresAt` aparece como *timestamp*, não string. Confirmar a
  política com `gcloud firestore fields ttls list --database=<DATABASE_ID>`.
  Rodar a limpeza e conferir que a contagem de `pushDispatches` cai.
- **Item 1 (regressão crítica):** garantir que a dose **não** é reenviada.
  Force duas execuções seguidas de `/api/push/dispatch` com uma dose vencida e
  confirme que a segunda não dispara nada (`sent: 0` para aquele destinatário).
  Esse é o comportamento que o `create()` protege — não pode quebrar.
- **Item 2(a):** conferir nos logs que a contagem de leituras por execução do
  cron caiu pela metade, e que os dois jobs continuam disparando normalmente.
- Ponta a ponta: com uma dose próxima, confirmar que o push chega num aparelho
  real, e que uma inscrição inválida (endpoint adulterado) é removida via 410.
