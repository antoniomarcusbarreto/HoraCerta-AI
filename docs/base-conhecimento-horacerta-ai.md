# Base de Conhecimento — HoraCerta-AI

## 1. Visão Geral
O HoraCerta-AI é um PWA (Progressive Web App) de organização e lembrete de tratamentos medicamentosos, pensado especialmente para uso por cuidadores que acompanham familiares (idosos, dependentes) além de si mesmos. O aplicativo permite fotografar uma receita médica e ter os medicamentos, dosagens e horários extraídos automaticamente por IA, organiza o calendário de doses com lembretes (notificação in-app e push), guarda o histórico de consultas médicas, farmácias de preferência e notas fiscais de compra, e permite compartilhar o cuidado de um paciente específico com outros cuidadores/familiares.
O HoraCerta-AI não é um dispositivo médico e não prescreve nenhum tratamento.

## 2. Regras e Limitações
- O aplicativo NÃO prescreve medicamentos, doses ou horários — ele apenas organiza e agenda o que já consta na receita médica fornecida pelo usuário (ou que o próprio usuário cadastra manualmente).
- A leitura de receita por IA é uma **automação de digitação**, não uma validação clínica: ela transcreve o que está escrito na foto (nome, dosagem, intervalo entre doses, duração do tratamento, instruções). Ela não avalia se a receita é segura, se há interação medicamentosa, nem confirma a legibilidade/autenticidade do documento.
- Toda receita extraída por IA cai numa tela de revisão editável — nada é salvo/agendado automaticamente sem o usuário revisar e confirmar cada campo.
- Sempre que a IA não conseguir processar a imagem real (chave de API ausente no ambiente), o app mostra uma receita de **exemplo fictício**, com aviso explícito de que nada foi lido da imagem enviada e que os dados precisam ser revisados/preenchidos manualmente antes de salvar. Isso é diferente de uma falha real (sessão expirada, cota esgotada, erro de servidor), que é sempre exibida como erro — o app nunca finge sucesso quando a leitura de fato falhou.
- Confirmar uma dose como "tomada" é uma ação manual e deliberada do usuário/cuidador (com opção de ajustar o horário real da tomada); o app não marca doses como tomadas sozinho.

## 3. Funcionalidade do Scanner de Receitas Médicas
O fluxo de leitura de receita por IA segue estes passos:
1. O usuário envia (upload) a foto da receita médica.
2. A imagem é enviada para a IA (Gemini), que identifica: nome do médico, data da receita, e para cada medicamento — nome, dosagem (texto livre, ex. "1 comprimido"), intervalo entre doses em horas (ex. de 8/8h), duração do tratamento em dias (uso contínuo é estimado como 30 dias), instruções adicionais e a categoria do medicamento (comprimido, xarope, gota, pomada, injeção ou outro).
3. **A IA não define o horário do dia** de cada dose — ela extrai apenas o intervalo entre uma dose e outra. O horário exato da primeira dose (e, por consequência, de todas as seguintes) é definido pelo usuário na etapa de revisão.
4. O usuário cai numa tela de revisão onde pode editar qualquer campo extraído (nome, dosagem, categoria, intervalo, duração, instruções), e obrigatoriamente escolhe:
   - Para **qual paciente/medicado** aquela receita pertence (relevante quando a conta cuida de mais de uma pessoa — ver seção 5);
   - A **data e hora da primeira dose** (pré-preenchida com o momento atual);
   - A **antecedência do lembrete** (5 ou 10 minutos antes do horário da dose).
5. Só ao tocar em "Confirmar e Agendar Medicamentos" os medicamentos são de fato criados e entram no calendário de doses (seção 6). O usuário pode descartar a leitura sem salvar nada.

## 4. Scanner de Cupom Fiscal (Controle de Gastos)
De forma independente do agendamento de doses, o app também lê fotos de cupons fiscais de farmácia por IA, extraindo estabelecimento, data da compra, lista de itens com preços e valor total. O usuário revisa e pode corrigir cada item, adicionar itens manualmente ou removê-los antes de salvar. Essa funcionalidade serve exclusivamente para **controle de gastos com medicamentos** — não alimenta nem debita nenhum controle de estoque; não há, no app, gestão de quantidade restante de comprimidos/frascos.
Assim como as farmácias favoritas (seção 8), os cupons fiscais são dados **da conta que os escaneou**, e propositalmente não são compartilhados com outros cuidadores que tenham acesso ao(s) paciente(s) daquela conta — são informação financeira pessoal do titular, não do paciente.

## 5. Perfis de Pacientes ("Medicados") — Uma Conta, Vários Cuidados
Uma única conta (login) pode cadastrar **mais de um "medicado"** — o perfil de quem efetivamente toma os remédios (nome, data de nascimento, grau de parentesco/relação, foto). Isso cobre o caso típico de um cuidador que acompanha, por exemplo, a mãe e o pai ao mesmo tempo: cada um tem seu próprio perfil, com sua própria lista de medicamentos, receitas, histórico de doses e consultas — completamente separados entre si, mesmo estando na mesma conta.
Toda vez que o usuário registra uma receita, medicamento, dose tomada ou consulta, essa informação fica vinculada ao medicado selecionado no momento, nunca "solta" na conta.

## 6. Central de Medicamentos e Agendamento de Doses
- **Cálculo dos horários:** a partir da data/hora da primeira dose e do intervalo em horas definidos na revisão da receita (ou no cadastro manual), o app calcula matematicamente todos os horários de dose subsequentes (primeira dose + intervalo, + intervalo, e assim por diante) até o fim da duração do tratamento em dias. Não há ajuste automático para "período da manhã/tarde/noite" — se a primeira dose foi marcada às 14h32, as seguintes caem sempre em torno desse mesmo minuto, respeitando o intervalo.
- **Confirmar uma dose:** ao tocar numa dose pendente no calendário, o app abre uma confirmação onde o usuário pode ajustar o horário real em que a dose foi de fato administrada (pré-preenchido com o horário atual) antes de confirmar. Isso grava um registro de dose tomada, junto com qual usuário/cuidador fez o registro — útil quando mais de um cuidador tem acesso ao mesmo paciente, para saber quem administrou.
- **Doses não tomadas:** o app não tem um botão de "pular dose" — uma dose que passa do horário sem ser confirmada simplesmente aparece como pendente/atrasada visualmente, mas não vira um registro formal de "dose perdida".
- **Lembretes automáticos:** enquanto o app está aberto, ele verifica a cada ~20 segundos se alguma dose está prestes a vencer (considerando a antecedência escolhida na receita) e dispara uma notificação. Por privacidade, o texto da notificação não expõe nome do paciente nem do medicamento. O mesmo cálculo de horário é usado para as notificações push (que chegam mesmo com o app fechado, desde que o usuário tenha permitido notificações e esteja com internet no momento do envio).

## 7. Compartilhamento de Cuidado entre Cuidadores/Família
O HoraCerta-AI permite compartilhar o acesso a **um paciente específico** (não a conta inteira) com outra pessoa, por convite via e-mail. Existem dois níveis de acesso:
- **Coadministrador:** pode registrar doses tomadas, e criar/editar medicamentos, receitas e consultas daquele paciente.
- **Acompanhante:** acesso somente leitura — vê o histórico e recebe notificações de adesão ao tratamento, mas não pode registrar nem editar nada.
O convite é enviado por link (aberto na aba "Perfil" do convidado) e precisa ser explicitamente aceito ou recusado — não há aceite automático. Farmácias favoritas e cupons fiscais **nunca** entram nesse compartilhamento, mesmo entre coadministradores: são dados financeiros/pessoais da conta do titular, não do paciente cuidado.

## 8. Consultas Médicas e Farmácias Favoritas
- **Consultas:** o usuário registra consultas médicas (passadas ou futuras) de um paciente específico — médico, especialidade, data/hora, local e observações. Essa informação é compartilhada normalmente entre os cuidadores daquele paciente (coadministrador e acompanhante), assim como receitas e medicamentos.
- **Farmácias favoritas:** uma agenda simples de farmácias (nome, endereço, telefone, marcação de favorita) pertencente à **conta**, não ao paciente — não é compartilhada entre cuidadores. Um medicamento pode referenciar uma farmácia, indicando onde ele costuma ser comprado.

## 9. Assinatura e Planos (Mercado Pago)
- **Período de teste gratuito:** 7 dias a partir do cadastro, com acesso completo ao app.
- **Cota de leitura por IA durante o teste gratuito:** 3 leituras de receita médica **e** 3 leituras de cupom fiscal (contadores separados) — depois de usadas as 3 de cada tipo, o app pede assinatura para continuar escaneando (a mensagem exibida é diferente de "assinatura vencida": é especificamente "cota de teste esgotada").
- **Planos pagos:** Mensal (R$ 19,90) e Anual (R$ 179,90), com leituras de IA **ilimitadas** enquanto a assinatura estiver ativa.
- **Carência:** após o vencimento da assinatura paga, o usuário ainda tem 2 dias de tolerância antes do acesso ser bloqueado — útil para casos de atraso na confirmação do pagamento pelo Mercado Pago.
- Pagamentos são confirmados via webhook do Mercado Pago; se por algum motivo o webhook não chegar, o app tenta confirmar novamente ao voltar do checkout, então uma demora de poucos minutos para liberar o acesso após o pagamento é esperada em casos raros.

## 10. Sincronização entre Dispositivos e Modo Offline
O app funciona com os dados salvos localmente no aparelho (para abrir instantaneamente, mesmo sem internet), e sincroniza esses dados com a nuvem sempre que há conexão — por isso, ao logar em um novo aparelho ou reabrir o app depois de um tempo, os dados são recuperados automaticamente da nuvem.
**O que funciona sem internet:** reabrir o app e consultar dados que já haviam sido carregados antes (medicamentos, histórico, consultas já vistas).
**O que exige internet:** login, leitura de receita/cupom por IA, qualquer novo compartilhamento de paciente com outro cuidador, pagamento/assinatura, e o recebimento de notificações push no momento exato em que elas são disparadas (uma notificação não chega "atrasada" quando a internet volta).
O app se atualiza sozinho para a versão mais nova sempre que há conexão — se um usuário relatar estar vendo uma tela ou comportamento antigo mesmo após uma correção ter sido publicada, a orientação é fechar e reabrir o app com internet ativa (o processo de atualização é automático, mas pode levar até a próxima vez que o app for reaberto em primeiro plano).

## 11. Acessibilidade
Atualmente o HoraCerta-AI **não possui uma tela de configurações de acessibilidade** voltada ao usuário final (não há ajuste de tamanho de fonte, modo de alto contraste ou leitura em voz alta configuráveis pelo usuário). Caso o suporte receba esse tipo de pedido, deve ser registrado como sugestão de melhoria futura, e não respondido como se a funcionalidade já existisse.
