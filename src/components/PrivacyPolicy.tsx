import { ArrowLeft, Shield } from "lucide-react";

interface PrivacyPolicyProps {
  onBack: () => void;
}

interface Section {
  title: string;
  paragraphs: string[];
}

const LAST_UPDATED = "28 de julho de 2026";

const SECTIONS: Section[] = [
  {
    title: "1. Introdução",
    paragraphs: [
      "O Hora Certa AI ('nós', 'nosso aplicativo') é o controlador dos dados pessoais tratados através deste aplicativo, em conformidade com a Lei Geral de Proteção de Dados Pessoais (Lei nº 13.709/2018 — LGPD). Esta página explica quais dados coletamos, por que os coletamos, com quem compartilhamos e quais direitos você tem sobre eles.",
    ],
  },
  {
    title: "2. Dados que coletamos",
    paragraphs: [
      "Dados de identificação: nome, e-mail e foto de perfil (enviada por upload ou captura pela câmera).",
      "Dados sensíveis de saúde (Art. 5º, II da LGPD): medicamentos cadastrados, dosagens, horários, histórico de doses tomadas ou puladas, e receitas médicas associadas ao seu perfil e aos perfis de pessoas medicadas sob seus cuidados.",
      "Imagens enviadas para extração automática por Inteligência Artificial: fotos de receitas médicas e de comprovantes/cupons fiscais de farmácia, usadas para preencher os dados automaticamente.",
      "Token de notificação push: gerado apenas se você ativar os alertas de medicação, para permitir o envio de lembretes mesmo com o aplicativo fechado.",
      "Registros de acesso e de auditoria: a cada login registramos data/hora, endereço IP e identificação do navegador (user-agent), como exige o Art. 15 do Marco Civil da Internet (Lei nº 12.965/2014). Também registramos alterações e exclusões de registros feitas na sua conta, para fins de segurança e rastreabilidade — esse registro guarda o tipo e o identificador do item alterado, nunca o nome do paciente nem o conteúdo do dado de saúde.",
    ],
  },
  {
    title: "3. Finalidade do tratamento",
    paragraphs: [
      "Usamos esses dados exclusivamente para operar as funcionalidades do aplicativo: organizar seus medicamentos e horários, enviar lembretes de dose, armazenar suas receitas médicas, localizar farmácias e cupons, e preencher automaticamente formulários a partir de fotos que você mesmo envia.",
    ],
  },
  {
    title: "4. Base legal",
    paragraphs: [
      "O tratamento dos seus dados se baseia na execução do serviço solicitado por você (Art. 7º, V da LGPD) e, no caso dos dados sensíveis de saúde, no seu consentimento explícito ao cadastrar essas informações no aplicativo (Art. 11, I da LGPD). Você pode revogar esse consentimento a qualquer momento excluindo os dados correspondentes.",
    ],
  },
  {
    title: "5. Compartilhamento com terceiros",
    paragraphs: [
      "Seus dados são armazenados no Google Firebase/Firestore (autenticação e banco de dados) e as imagens de receitas/comprovantes são processadas pela API Google Gemini apenas para extração automática de texto — nenhuma imagem é usada para outro fim. Ambos os serviços são operados pela Google sob seus próprios acordos de proteção de dados.",
      "Não vendemos, alugamos ou compartilhamos seus dados com terceiros para fins de marketing ou publicidade.",
    ],
  },
  {
    title: "6. Armazenamento e segurança",
    paragraphs: [
      "Os dados ficam protegidos no Firestore por regras de acesso que restringem cada usuário aos seus próprios dados. O aplicativo também mantém uma cópia local no seu dispositivo (armazenamento do navegador) para funcionar mesmo sem conexão à internet, sincronizando com a nuvem quando a conexão está disponível.",
    ],
  },
  {
    title: "7. Seus direitos como titular dos dados",
    paragraphs: [
      "Conforme o Art. 18 da LGPD, você tem direito a: confirmação da existência de tratamento, acesso aos dados, correção de dados incompletos ou desatualizados, exclusão dos dados, portabilidade para outro fornecedor e revogação do consentimento.",
      "Você pode excluir medicamentos, receitas e o próprio perfil diretamente pelo aplicativo. Para outras solicitações, entre em contato pelo e-mail informado na seção 10.",
    ],
  },
  {
    title: "8. Retenção de dados",
    paragraphs: [
      "Seus dados são mantidos enquanto sua conta estiver ativa. Ao excluir uma receita médica, os medicamentos e o histórico de doses vinculados a ela também são removidos automaticamente.",
      "Ao solicitar a exclusão da conta, apagamos definitivamente o seu login e todos os dados de saúde: perfis de pessoas medicadas, medicamentos, receitas, histórico de doses, consultas, farmácias e cupons. O registro de auditoria das alterações feitas na sua conta também é apagado.",
      "Exceção prevista em lei: os registros de acesso (data/hora e endereço IP dos seus logins) são mantidos por 6 meses mesmo após a exclusão da conta, porque o Art. 15 do Marco Civil da Internet obriga sua guarda. Nesse caso removemos o seu nome e e-mail desses registros, preservando apenas o mínimo exigido, e eles são eliminados automaticamente ao fim do prazo.",
      "Registros técnicos de erro do sistema são mantidos por até 90 dias para diagnóstico e segurança, e o vínculo com a sua conta é removido caso você solicite a exclusão.",
    ],
  },
  {
    title: "9. Armazenamento local no dispositivo",
    paragraphs: [
      "O aplicativo usa o armazenamento local do navegador para funcionar offline e responder mais rápido. Esse armazenamento guarda apenas os seus próprios dados de uso do aplicativo — não é usado para rastreamento publicitário nem compartilhado com redes de anúncios.",
    ],
  },
  {
    title: "10. Contato do controlador / encarregado de dados (DPO)",
    paragraphs: [
      "Dúvidas, solicitações sobre seus dados ou exercício dos direitos previstos na LGPD podem ser enviadas para privacidade@horacerta.app.",
    ],
  },
  {
    title: "11. Atualizações desta política",
    paragraphs: [
      `Esta política pode ser atualizada periodicamente para refletir mudanças no aplicativo ou na legislação. Última atualização: ${LAST_UPDATED}.`,
    ],
  },
];

export default function PrivacyPolicy({ onBack }: PrivacyPolicyProps) {
  return (
    <div className="fixed inset-0 lg:left-24 z-[60] bg-brand-cream lg:bg-[#FAF6EC] overflow-y-auto font-sans animate-fade-in">
      <div className="max-w-md lg:max-w-2xl mx-auto px-4 py-6 lg:my-14 lg:bg-[#FDFBF5] lg:border lg:border-[#ECE6D8] lg:rounded-[28px] lg:p-10 lg:shadow-[0_2px_10px_rgba(0,0,0,0.03)]">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={onBack}
            className="w-9 h-9 flex items-center justify-center rounded-xl bg-white border border-brand-cream-darker text-brand-teal hover:bg-brand-peach transition-all shadow-sm active:scale-95 shrink-0"
            aria-label="Voltar"
          >
            <ArrowLeft className="w-4.5 h-4.5" />
          </button>
          <div className="flex items-center gap-2 min-w-0">
            <Shield className="w-5 h-5 text-brand-coral shrink-0" />
            <h1 className="text-xl font-display font-bold text-brand-teal leading-tight truncate">
              Privacidade e Proteção de Dados
            </h1>
          </div>
        </div>

        <div className="space-y-4 pb-12">
          <p className="text-[11px] text-gray-400 font-sans">
            Conformidade com a Lei Geral de Proteção de Dados (LGPD — Lei nº 13.709/2018).
          </p>

          {SECTIONS.map((section) => (
            <div
              key={section.title}
              className="bg-white border border-brand-cream-darker rounded-3xl p-5 shadow-xs space-y-2"
            >
              <h3 className="text-xs font-bold text-brand-teal uppercase tracking-wider font-display">
                {section.title}
              </h3>
              <div className="space-y-2">
                {section.paragraphs.map((paragraph, index) => (
                  <p key={index} className="text-[11px] text-gray-500 font-sans leading-relaxed">
                    {paragraph}
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
