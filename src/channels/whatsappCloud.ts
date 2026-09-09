import { createHmac, timingSafeEqual } from "node:crypto";
import { runAgent } from "../agent.js";
import { conversaAtendidaPorHumano, registrarRecebidoSemResposta } from "../inbox.js";
import { enviarPelaCloudApi } from "../notifications.js";
import { PlanoBloqueadoError } from "../pontos.js";

/**
 * Canal WhatsApp oficial — Cloud API da Meta.
 *
 * O Baileys (canal não oficial) precisa de um processo vivo com a sessão do
 * número; aqui não: a Meta entrega cada mensagem por webhook (HTTPS puro,
 * roda na Vercel) e a resposta sai pela Graph API com o token permanente.
 * Sem QR, sem computador ligado, sem risco de banimento.
 *
 * Configuração (variáveis na Vercel):
 *   WHATSAPP_TOKEN            — token permanente do usuário do sistema
 *   WHATSAPP_PHONE_NUMBER_ID  — o "ID do número de telefone" do painel da Meta
 *   WHATSAPP_VERIFY_TOKEN     — string que você inventa e cola no painel da Meta
 *   WHATSAPP_APP_SECRET       — App Secret do app (o mesmo do Instagram, é um
 *                               app só; cai em INSTAGRAM_APP_SECRET se vazio)
 *   WHATSAPP_CLOUD_AGENT      — slug do agente que atende (cai em INSTAGRAM_AGENT)
 *   WHATSAPP_CLOUD_VENUE      — slug da casa (cai em INSTAGRAM_VENUE, depois WHATSAPP_VENUE)
 *
 * A janela de 24h da Meta: mensagem livre só é aceita para quem escreveu nas
 * últimas 24 horas. Atendimento é exatamente isso.
 *
 * O externalId da conversa é o número em dígitos ("5565999990000"). O Baileys
 * usa o jid ("5565999990000@s.whatsapp.net"): são conversas diferentes na
 * inbox de propósito — o cliente que falou com o número não oficial e agora
 * fala com o oficial está em outro número da casa.
 */

interface MensagemRecebida {
  id?: string;
  from?: string;
  type?: string;
  timestamp?: string;
  text?: { body?: string };
  image?: unknown;
  video?: unknown;
  audio?: unknown;
  document?: unknown;
  sticker?: unknown;
  location?: unknown;
  contacts?: unknown;
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
}

interface Contato {
  wa_id?: string;
  profile?: { name?: string };
}

interface CorpoWebhook {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: { phone_number_id?: string; display_phone_number?: string };
        contacts?: Contato[];
        messages?: MensagemRecebida[];
        statuses?: unknown[];
      };
    }>;
  }>;
}

function config() {
  return {
    token: process.env.WHATSAPP_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
    appSecret: process.env.WHATSAPP_APP_SECRET || process.env.INSTAGRAM_APP_SECRET,
    agent: process.env.WHATSAPP_CLOUD_AGENT || process.env.INSTAGRAM_AGENT,
    venue: process.env.WHATSAPP_CLOUD_VENUE || process.env.INSTAGRAM_VENUE || process.env.WHATSAPP_VENUE,
  };
}

/** Para a aba Canais: o que está (ou não) configurado, sem expor segredos. */
export function estadoWhatsappCloud(): {
  configurado: boolean;
  faltando: string[];
  agente: string | null;
  venue: string | null;
  phone_number_id: string | null;
} {
  const cfg = config();
  const faltando = (
    [
      ["WHATSAPP_TOKEN", cfg.token],
      ["WHATSAPP_PHONE_NUMBER_ID", cfg.phoneNumberId],
      ["WHATSAPP_VERIFY_TOKEN", cfg.verifyToken],
      ["WHATSAPP_APP_SECRET", cfg.appSecret],
      ["WHATSAPP_CLOUD_AGENT", cfg.agent],
      ["WHATSAPP_CLOUD_VENUE", cfg.venue],
    ] as const
  )
    .filter(([, valor]) => !valor)
    .map(([nome]) => nome);

  return {
    configurado: faltando.length === 0,
    faltando,
    agente: cfg.agent ?? null,
    venue: cfg.venue ?? null,
    phone_number_id: cfg.phoneNumberId ?? null,
  };
}

/**
 * Etapa de verificação do webhook (GET da Meta ao salvar a URL).
 * Devolve o challenge a ecoar, ou null para recusar.
 */
export function verificarWebhookWhatsapp(params: URLSearchParams): string | null {
  const cfg = config();
  if (!cfg.verifyToken) return null;
  if (params.get("hub.mode") !== "subscribe") return null;
  if (params.get("hub.verify_token") !== cfg.verifyToken) return null;
  return params.get("hub.challenge");
}

/** Assinatura HMAC-SHA256 do corpo cru, enviada em X-Hub-Signature-256. */
export function assinaturaWhatsappValida(corpoBruto: Buffer, cabecalho: string | undefined): boolean {
  const cfg = config();
  if (!cfg.appSecret || !cabecalho?.startsWith("sha256=")) return false;

  const esperada = createHmac("sha256", cfg.appSecret).update(corpoBruto).digest();
  const recebida = Buffer.from(cabecalho.slice("sha256=".length), "hex");
  return esperada.length === recebida.length && timingSafeEqual(esperada, recebida);
}

/** O texto que o cliente mandou, ou null quando não há texto (mídia, áudio…). */
export function textoDaMensagem(m: MensagemRecebida): string | null {
  const texto =
    m.text?.body ??
    m.button?.text ??
    m.interactive?.button_reply?.title ??
    m.interactive?.list_reply?.title ??
    null;
  const limpo = texto?.trim();
  return limpo ? limpo : null;
}

/** "[foto recebida]", "[áudio recebido]"… para a inbox e para a resposta de acolhida. */
export function descreverMidia(m: MensagemRecebida): { registro: string; acolhida: string } {
  if (m.image) return { registro: "[foto recebida]", acolhida: "Recebi sua foto! Consigo te ajudar melhor por texto — me conta o que você precisa?" };
  if (m.video) return { registro: "[vídeo recebido]", acolhida: "Recebi seu vídeo! Consigo te ajudar melhor por texto — me conta o que você precisa?" };
  if (m.audio) return { registro: "[áudio recebido]", acolhida: "Por aqui ainda não consigo ouvir áudio. Pode escrever? Respondo na hora." };
  if (m.document) return { registro: "[documento recebido]", acolhida: "Recebi seu arquivo! Me conta por texto o que você precisa?" };
  if (m.location) return { registro: "[localização recebida]", acolhida: "Recebi sua localização! Me conta o que você precisa?" };
  if (m.sticker) return { registro: "[figurinha recebida]", acolhida: "😄 Me conta por texto o que você precisa?" };
  return { registro: "[mensagem sem texto recebida]", acolhida: "Por enquanto consigo ler só mensagens de texto. Pode escrever?" };
}

/**
 * Mensagens já processadas nesta instância.
 *
 * A Meta reenvia o mesmo evento quando não recebe 200 a tempo, e "a tempo"
 * é apertado para uma resposta de agente. Sem isto, a segunda entrega faria
 * o agente responder duas vezes à mesma pergunta. Memória por instância:
 * na Vercel cada instância tem a sua, o que já cobre o caso comum (a
 * reentrega cai na mesma instância ainda quente).
 */
const vistas = new Set<string>();
function jaVista(id: string | undefined): boolean {
  if (!id) return false;
  if (vistas.has(id)) return true;
  vistas.add(id);
  if (vistas.size > 5000) {
    const [primeira] = vistas;
    if (primeira) vistas.delete(primeira);
  }
  return false;
}

/**
 * Processa um lote de eventos do webhook: roda o agente e responde.
 *
 * Sempre resolve — erros são logados, nunca propagados: devolver 5xx à Meta
 * dispara tempestade de reentregas, e a mensagem duplicada é pior que a
 * mensagem perdida (o cliente reenvia sozinho quando não é respondido).
 */
export async function processarWebhookWhatsapp(corpo: CorpoWebhook): Promise<{ mensagens: number }> {
  if (corpo.object !== "whatsapp_business_account") return { mensagens: 0 };
  const cfg = config();
  if (!cfg.agent || !cfg.venue || !cfg.token || !cfg.phoneNumberId) {
    console.error("[whatsapp-cloud] webhook recebido, mas o canal não está totalmente configurado.");
    return { mensagens: 0 };
  }

  let mensagens = 0;
  for (const entry of corpo.entry ?? []) {
    for (const mudanca of entry.changes ?? []) {
      if (mudanca.field !== "messages") continue;
      const valor = mudanca.value;
      if (!valor?.messages?.length) continue;
      // Só o número desta casa: um app da Meta pode ter vários números, e o
      // webhook é um só para todos eles.
      if (valor.metadata?.phone_number_id && valor.metadata.phone_number_id !== cfg.phoneNumberId) continue;

      const nomes = new Map((valor.contacts ?? []).map((c) => [c.wa_id, c.profile?.name?.trim() || null]));
      for (const m of valor.messages) {
        mensagens += 1;
        try {
          await processarMensagem(m, nomes.get(m.from) ?? null, cfg.agent, cfg.venue);
        } catch (e) {
          console.error("[whatsapp-cloud] falha ao processar mensagem:", e);
        }
      }
    }
  }
  return { mensagens };
}

async function processarMensagem(
  m: MensagemRecebida,
  nome: string | null,
  agentSlug: string,
  venueSlug: string,
): Promise<void> {
  const telefone = m.from?.replace(/\D/g, "");
  if (!telefone || jaVista(m.id)) return;

  const texto = textoDaMensagem(m);
  if (!texto) {
    const midia = descreverMidia(m);
    // Mesma regra do Baileys: com uma pessoa no comando, o robô não agradece
    // a foto — registra que chegou e fica quieto.
    const humana = await conversaAtendidaPorHumano({ agentSlug, channel: "whatsapp", externalId: telefone });
    if (humana) {
      await registrarRecebidoSemResposta(humana.id, midia.registro).catch(() => undefined);
      console.log(`[whatsapp-cloud] ${telefone}: mídia numa conversa com pessoa — não respondi.`);
      return;
    }
    await enviarPelaCloudApi(telefone, midia.acolhida);
    return;
  }

  console.log(`[whatsapp-cloud] ${nome ?? "?"} (${telefone}): ${texto.slice(0, 80)}`);

  let resultado;
  try {
    resultado = await runAgent({
      agentSlug,
      venueSlug,
      userMessage: texto,
      channel: "whatsapp",
      externalId: telefone,
      contato: { nome, telefone },
    });
  } catch (e) {
    // Plano travado não é falha técnica: o cliente do bar não pode ficar sem
    // resposta nenhuma, e a conversa já foi passada para atendimento humano.
    if (e instanceof PlanoBloqueadoError) {
      await enviarPelaCloudApi(telefone, "Recebi sua mensagem! Alguém da equipe vai te responder em instantes.");
      return;
    }
    throw e;
  }

  if (!resultado.respondeu) {
    console.log(`[whatsapp-cloud] ${telefone}: atendimento é humano, não respondi.`);
    return;
  }

  const envio = await enviarPelaCloudApi(telefone, resultado.text || "Desculpe, não consegui responder agora. Pode tentar de novo?");
  if (!envio.enviado) {
    console.error(`[whatsapp-cloud] falha ao responder ${telefone}: ${envio.erro}`);
  }
}
