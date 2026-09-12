import { db } from "./supabase.js";

/**
 * A CASA AO VIVO — a planta do bar, com o que está acontecendo em cada setor.
 *
 * O painel conta a verdade repartida em dez telas: reserva numa, recebimento
 * noutra, ponto numa terceira. Quem abre de manhã quer uma coisa só — "o que
 * andou acontecendo na minha casa?" — e hoje isso custa dez cliques.
 *
 * Aqui a casa vira planta, e cada fato aparece NO SETOR onde ele acontece: a
 * mercadoria chega na doca, a reserva entra pela porta, o ponto bate no
 * escritório. Não é enfeite: é o mapa mental de quem toca o bar, e reconhecer
 * "a doca está parada há três dias" num relance é mais rápido do que ler
 * qualquer lista.
 *
 * DUAS REGRAS MANDAM AQUI:
 *
 * 1. Nenhum módulo depende do outro. Cada fonte só roda se a casa contratou
 *    o módulo dela, e o setor sem contrato aparece apagado — não some, para
 *    o dono ver o que existe e poder querer.
 *
 * 2. Fonte que falha não derruba a planta. Se a migração do RH não rodou, o
 *    escritório fica quieto e o resto da casa continua viva. Uma tela de
 *    panorama que quebra inteira por causa de um módulo é pior do que não
 *    ter panorama nenhum.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cliente = () => db() as any;

export interface Setor {
  id: string;
  nome: string;
  /** O que este setor faz, em quatro palavras. */
  legenda: string;
  /** O módulo que alimenta o setor. `null` = todo cliente tem. */
  modulo: string | null;
  /** Onde o setor fica na planta, em porcentagem da largura e da altura. */
  x: number;
  y: number;
  contratado: boolean;
  /** Fatos deste setor na janela lida. */
  quantos: number;
  /** O fato mais recente, para o cartão dizer algo sem ninguém clicar. */
  ultimo: Fato | null;
  /** Quanto tempo faz desde o último fato, em minutos. `null` = nada ainda. */
  minutos_parado: number | null;
}

export interface Fato {
  /** Estável: a tela usa para não desenhar o mesmo fato duas vezes. */
  id: string;
  quando: string;
  setor: string;
  tipo: string;
  titulo: string;
  detalhe: string | null;
  /** De quem é o fato — vira o nome do bonequinho que anda na planta. */
  quem: string | null;
  /** Precisa de alguém: reserva esperando, nota baixa, checklist com alerta. */
  atencao: boolean;
}

/**
 * A planta.
 *
 * As posições são as de um salão visto de cima: a porta embaixo à esquerda
 * (por onde o cliente entra), o salão no meio, a cozinha e a doca no fundo.
 * Quem conhece o próprio bar lê isto sem legenda.
 */
export const SETORES: Array<Omit<Setor, "contratado" | "quantos" | "ultimo" | "minutos_parado">> = [
  { id: "doca", nome: "Doca", legenda: "Mercadoria entrando e contagem", modulo: "cmv", x: 16, y: 18 },
  { id: "cozinha", nome: "Cozinha", legenda: "Produção das fichas técnicas", modulo: "cmv", x: 50, y: 14 },
  { id: "escritorio", nome: "Escritório", legenda: "Ponto, escala e gorjeta", modulo: "rh", x: 84, y: 18 },
  { id: "salao", nome: "Salão", legenda: "Mesas, garçons e cardápio", modulo: "cardapio-digital", x: 50, y: 48 },
  { id: "porta", nome: "Porta", legenda: "Reservas e o agente no WhatsApp", modulo: "agentes-ia", x: 16, y: 80 },
  { id: "operacao", nome: "Rotinas", legenda: "Checklists do turno", modulo: "checklist", x: 50, y: 84 },
  { id: "opiniao", nome: "Opinião", legenda: "Pesquisa e avaliações", modulo: "clientes", x: 84, y: 80 },
];

// ============================================================
// Contas puras — sem banco, testáveis
// ============================================================

/** Minutos entre dois instantes, arredondados para baixo. */
export function minutosEntre(de: string, ate: string): number {
  return Math.max(0, Math.floor((new Date(ate).getTime() - new Date(de).getTime()) / 60_000));
}

/**
 * Os fatos em ordem, sem repetição e sem passar do limite.
 *
 * A repetição não é hipótese: a tela pergunta de novo a cada quinze segundos
 * com `desde`, e a borda da janela devolve o mesmo fato duas vezes. Cortar
 * pelo id é mais barato e mais seguro do que confiar no relógio.
 */
export function arrumarFatos(fatos: Fato[], limite = 60): Fato[] {
  const vistos = new Set<string>();
  return fatos
    .filter((f) => {
      if (vistos.has(f.id)) return false;
      vistos.add(f.id);
      return true;
    })
    .sort((a, b) => b.quando.localeCompare(a.quando))
    .slice(0, limite);
}

/**
 * O estado de cada setor a partir dos fatos.
 *
 * Setor sem contrato não conta nada e não fica "parado há muito tempo": ele
 * está apagado porque a casa não comprou, e dizer "parado há 40 dias" seria
 * cobrar de alguém uma coisa que ele não tem.
 */
export function montarSetores(params: {
  fatos: Fato[];
  contratados: string[];
  agora: string;
}): Setor[] {
  const temModulo = new Set(params.contratados);
  return SETORES.map((base) => {
    const contratado = base.modulo === null || temModulo.has(base.modulo);
    const meus = contratado ? params.fatos.filter((f) => f.setor === base.id) : [];
    const ultimo = meus[0] ?? null;
    return {
      ...base,
      contratado,
      quantos: meus.length,
      ultimo,
      minutos_parado: ultimo ? minutosEntre(ultimo.quando, params.agora) : null,
    };
  });
}

/** "agora mesmo", "há 12 min", "há 3 h", "há 2 dias". */
export function comoFazTempo(minutos: number | null): string {
  if (minutos === null) return "nada ainda";
  if (minutos < 1) return "agora mesmo";
  if (minutos < 60) return `há ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `há ${horas} h`;
  const dias = Math.floor(horas / 24);
  return dias === 1 ? "ontem" : `há ${dias} dias`;
}

/** O primeiro nome, que é o que cabe embaixo do bonequinho. */
export function primeiroNome(nome: string | null): string | null {
  const limpo = String(nome ?? "").trim();
  if (!limpo) return null;
  return limpo.split(/\s+/)[0]!;
}

// ============================================================
// As fontes — uma por assunto, cada uma sozinha
// ============================================================

interface Janela {
  venueId: string;
  desde: string;
  limite: number;
}

type Fonte = (j: Janela) => Promise<Fato[]>;

const texto = (v: unknown) => (v === null || v === undefined ? null : String(v));

async function reservas(j: Janela): Promise<Fato[]> {
  const { data } = await cliente()
    .from("reservations")
    .select("id, customer_name, party_size, reserved_for, status, source_channel, created_at")
    .eq("venue_id", j.venueId)
    .gte("created_at", j.desde)
    .order("created_at", { ascending: false })
    .limit(j.limite);

  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: `reserva:${r.id}`,
    quando: String(r.created_at),
    setor: "porta",
    tipo: "reserva",
    titulo: `Reserva para ${Number(r.party_size) || 1} pessoa(s)`,
    // Sem o nome aqui: ele já vai em `quem`, e a tela junta os dois na mesma
    // linha — repetido, ficava "Renata Prado · Renata Prado".
    detalhe: r.reserved_for ? `para ${quando(String(r.reserved_for))}` : null,
    quem: texto(r.customer_name),
    atencao: r.status === "pending",
  }));
}

/**
 * O agente respondendo.
 *
 * Duas consultas de propósito: as mensagens não têm venue_id, e trazer por
 * junção do PostgREST custaria uma view só para isto. As conversas da casa
 * são poucas e a lista de ids é curta.
 */
async function agenteNoWhatsapp(j: Janela): Promise<Fato[]> {
  const { data: conversas } = await cliente()
    .from("conversations")
    .select("id, title, external_id, channel, updated_at")
    .eq("venue_id", j.venueId)
    .gte("updated_at", j.desde)
    .order("updated_at", { ascending: false })
    .limit(30);

  const lista = (conversas ?? []) as Array<Record<string, unknown>>;
  if (lista.length === 0) return [];

  const nomeDa = new Map(lista.map((c) => [String(c.id), texto(c.title) || texto(c.external_id)]));
  const { data: mensagens } = await cliente()
    .from("messages")
    .select("id, conversation_id, role, content, created_at")
    .in("conversation_id", lista.map((c) => c.id))
    .gte("created_at", j.desde)
    .order("created_at", { ascending: false })
    .limit(j.limite);

  return ((mensagens ?? []) as Array<Record<string, unknown>>).map((m) => {
    const doAgente = m.role === "assistant";
    const nome = nomeDa.get(String(m.conversation_id)) ?? null;
    return {
      id: `msg:${m.id}`,
      quando: String(m.created_at),
      setor: "porta",
      tipo: doAgente ? "agente-respondeu" : "cliente-falou",
      titulo: doAgente ? "O agente respondeu" : "Cliente falou no WhatsApp",
      detalhe: resumir(texto(m.content)),
      quem: nome,
      atencao: false,
    };
  });
}

async function docaRecebendo(j: Janela): Promise<Fato[]> {
  const [{ data: compras }, { data: contagens }] = await Promise.all([
    cliente()
      .from("compras")
      .select("id, fornecedor, valor_total, status, created_at, recebida_em")
      .eq("venue_id", j.venueId)
      .gte("created_at", j.desde)
      .order("created_at", { ascending: false })
      .limit(j.limite),
    cliente()
      .from("contagens")
      .select("id, status, created_at, processada_em")
      .eq("venue_id", j.venueId)
      .gte("created_at", j.desde)
      .order("created_at", { ascending: false })
      .limit(j.limite),
  ]);

  const deCompra = ((compras ?? []) as Array<Record<string, unknown>>).map((c) => ({
    id: `compra:${c.id}`,
    quando: String(c.recebida_em ?? c.created_at),
    setor: "doca",
    tipo: c.recebida_em ? "recebimento" : "pedido",
    titulo: c.recebida_em ? "Mercadoria recebida" : "Pedido de compra lançado",
    detalhe: [texto(c.fornecedor), c.valor_total ? dinheiro(Number(c.valor_total)) : null]
      .filter(Boolean)
      .join(" · ") || null,
    quem: texto(c.fornecedor),
    // Pedido que ainda não chegou é cobrança: alguém precisa conferir.
    atencao: !c.recebida_em && c.status !== "cancelada",
  }));

  const deContagem = ((contagens ?? []) as Array<Record<string, unknown>>).map((c) => ({
    id: `contagem:${c.id}`,
    quando: String(c.processada_em ?? c.created_at),
    setor: "doca",
    tipo: "contagem",
    titulo: c.processada_em ? "Contagem de estoque fechada" : "Contagem aberta",
    detalhe: null,
    quem: null,
    atencao: !c.processada_em,
  }));

  return [...deCompra, ...deContagem];
}

async function cozinhaProduzindo(j: Janela): Promise<Fato[]> {
  const { data } = await cliente()
    .from("producoes")
    .select("id, lotes, status, created_at, ficha_id")
    .eq("venue_id", j.venueId)
    .gte("created_at", j.desde)
    .order("created_at", { ascending: false })
    .limit(j.limite);

  const linhas = (data ?? []) as Array<Record<string, unknown>>;
  if (linhas.length === 0) return [];

  const { data: fichas } = await cliente()
    .from("fichas_tecnicas")
    .select("id, nome")
    .in("id", [...new Set(linhas.map((p) => p.ficha_id).filter(Boolean))]);
  const nomeDa = new Map(
    ((fichas ?? []) as Array<{ id: string; nome: string }>).map((f) => [f.id, f.nome]),
  );

  return linhas.map((p) => ({
    id: `producao:${p.id}`,
    quando: String(p.created_at),
    setor: "cozinha",
    tipo: "producao",
    titulo: `Produziu ${Number(p.lotes) || 1} lote(s)`,
    detalhe: nomeDa.get(String(p.ficha_id)) ?? null,
    quem: null,
    atencao: false,
  }));
}

async function escritorioDoRh(j: Janela): Promise<Fato[]> {
  const [{ data: pontos }, { data: ferias }] = await Promise.all([
    cliente()
      .from("rh_pontos")
      .select("id, atendente_id, tipo, momento, origem")
      .eq("venue_id", j.venueId)
      .gte("momento", j.desde)
      .order("momento", { ascending: false })
      .limit(j.limite),
    cliente()
      .from("rh_ferias")
      .select("id, atendente_id, inicio, fim, dias, situacao, criado_em")
      .eq("venue_id", j.venueId)
      .gte("criado_em", j.desde)
      .order("criado_em", { ascending: false })
      .limit(j.limite),
  ]);

  const linhas = [...((pontos ?? []) as Array<Record<string, unknown>>), ...((ferias ?? []) as Array<Record<string, unknown>>)];
  const nomeDa = await nomesDaEquipe(j.venueId, linhas.map((l) => String(l.atendente_id)));

  const NOME_DA_BATIDA: Record<string, string> = {
    entrada: "Bateu entrada",
    saida: "Bateu saída",
    pausa: "Saiu para a pausa",
    volta: "Voltou da pausa",
  };

  const deBatida = ((pontos ?? []) as Array<Record<string, unknown>>).map((p) => ({
    id: `ponto:${p.id}`,
    quando: String(p.momento),
    setor: "escritorio",
    tipo: "ponto",
    titulo: NOME_DA_BATIDA[String(p.tipo)] ?? "Bateu ponto",
    detalhe: p.origem === "gestor" ? "lançado pelo gestor" : null,
    quem: nomeDa.get(String(p.atendente_id)) ?? null,
    atencao: false,
  }));

  const deFerias = ((ferias ?? []) as Array<Record<string, unknown>>).map((f) => ({
    id: `ferias:${f.id}`,
    quando: String(f.criado_em),
    setor: "escritorio",
    tipo: "ferias",
    titulo: f.situacao === "aprovado" ? "Férias registradas" : "Férias pedidas",
    detalhe: `${Number(f.dias)} dia(s) a partir de ${quando(String(f.inicio))}`,
    quem: nomeDa.get(String(f.atendente_id)) ?? null,
    atencao: f.situacao === "pedido",
  }));

  return [...deBatida, ...deFerias];
}

async function salaoDoCardapio(j: Janela): Promise<Fato[]> {
  const { data } = await cliente()
    .from("mesa_eventos")
    .select("id, mesa_numero, cliente_nome, item_nome, tipo, criado_em")
    .eq("venue_id", j.venueId)
    .gte("criado_em", j.desde)
    .order("criado_em", { ascending: false })
    .limit(j.limite);

  const NOME_DO_EVENTO: Record<string, string> = {
    abriu: "Abriu o cardápio na mesa",
    curtiu: "Curtiu um item",
    chamou: "Chamou o garçom",
    viu: "Olhou um item",
  };

  return ((data ?? []) as Array<Record<string, unknown>>).map((e) => ({
    id: `mesa:${e.id}`,
    quando: String(e.criado_em),
    setor: "salao",
    tipo: String(e.tipo),
    titulo: `Mesa ${e.mesa_numero}: ${NOME_DO_EVENTO[String(e.tipo)] ?? String(e.tipo)}`,
    detalhe: texto(e.item_nome),
    quem: texto(e.cliente_nome),
    atencao: e.tipo === "chamou",
  }));
}

async function rotinasDoTurno(j: Janela): Promise<Fato[]> {
  const { data } = await cliente()
    .from("checklist_runs")
    .select("id, executor_nome, status, scheduled_for, completed_at, created_at, alertas_ia")
    .eq("venue_id", j.venueId)
    .gte("created_at", j.desde)
    .order("created_at", { ascending: false })
    .limit(j.limite);

  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const alertas = Array.isArray(r.alertas_ia) ? r.alertas_ia.length : 0;
    return {
      id: `checklist:${r.id}`,
      quando: String(r.completed_at ?? r.created_at),
      setor: "operacao",
      tipo: "checklist",
      titulo: r.completed_at ? "Checklist concluído" : "Checklist aberto",
      detalhe: alertas > 0 ? `${alertas} ponto(s) de atenção` : null,
      quem: texto(r.executor_nome),
      atencao: alertas > 0,
    };
  });
}

async function opiniaoDoCliente(j: Janela): Promise<Fato[]> {
  const [{ data: respostas }, { data: avaliacoes }] = await Promise.all([
    cliente()
      .from("pesquisa_respostas")
      .select("id, nota, comentario, cliente_nome, mesa, created_at")
      .eq("venue_id", j.venueId)
      .gte("created_at", j.desde)
      .order("created_at", { ascending: false })
      .limit(j.limite),
    cliente()
      .from("google_avaliacoes")
      .select("id, nota, comentario, autor, created_at")
      .eq("venue_id", j.venueId)
      .gte("created_at", j.desde)
      .order("created_at", { ascending: false })
      .limit(j.limite),
  ]);

  const daPesquisa = ((respostas ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: `resposta:${r.id}`,
    quando: String(r.created_at),
    setor: "opiniao",
    tipo: "pesquisa",
    titulo: `Respondeu a pesquisa: nota ${r.nota}`,
    detalhe: resumir(texto(r.comentario)),
    quem: texto(r.cliente_nome),
    // Detrator na régua do NPS: é o telefonema de hoje.
    atencao: Number(r.nota) <= 6,
  }));

  const doGoogle = ((avaliacoes ?? []) as Array<Record<string, unknown>>).map((a) => ({
    id: `google:${a.id}`,
    quando: String(a.created_at),
    setor: "opiniao",
    tipo: "google",
    titulo: `Avaliação no Google: ${a.nota} estrela(s)`,
    detalhe: resumir(texto(a.comentario)),
    quem: texto(a.autor),
    atencao: Number(a.nota) <= 3,
  }));

  return [...daPesquisa, ...doGoogle];
}

/** Qual fonte alimenta qual setor, e de qual módulo ela depende. */
const FONTES: Array<{ modulo: string; fonte: Fonte }> = [
  { modulo: "agentes-ia", fonte: reservas },
  { modulo: "agentes-ia", fonte: agenteNoWhatsapp },
  { modulo: "cmv", fonte: docaRecebendo },
  { modulo: "cmv", fonte: cozinhaProduzindo },
  { modulo: "rh", fonte: escritorioDoRh },
  { modulo: "cardapio-digital", fonte: salaoDoCardapio },
  { modulo: "checklist", fonte: rotinasDoTurno },
  { modulo: "clientes", fonte: opiniaoDoCliente },
];

// ============================================================
// A leitura
// ============================================================

export async function oQueEstaAcontecendo(params: {
  venueId: string;
  /** Os módulos que a casa contratou. */
  contratados: string[];
  /** Ler o que aconteceu a partir daqui. Padrão: as últimas 24 horas. */
  desde?: string;
  limite?: number;
}): Promise<{ agora: string; desde: string; setores: Setor[]; fatos: Fato[]; setoresMudos: string[] }> {
  const agora = new Date().toISOString();
  const desde = params.desde ?? new Date(Date.now() - 24 * 3600_000).toISOString();
  const janela: Janela = { venueId: params.venueId, desde, limite: params.limite ?? 40 };

  const temModulo = new Set(params.contratados);
  const aRodar = FONTES.filter((f) => temModulo.has(f.modulo));

  // `allSettled`, e não `all`: uma fonte que falha (migração que não rodou,
  // tabela de um módulo antigo) não pode apagar a casa inteira.
  const resultados = await Promise.allSettled(aRodar.map((f) => f.fonte(janela)));

  const fatos: Fato[] = [];
  const setoresMudos: string[] = [];
  resultados.forEach((r, i) => {
    if (r.status === "fulfilled") {
      fatos.push(...r.value);
      return;
    }
    const modulo = aRodar[i]!.modulo;
    setoresMudos.push(modulo);
    console.error(`[a-casa] a fonte de ${modulo} não respondeu: ${(r.reason as Error)?.message}`);
  });

  const arrumados = arrumarFatos(fatos, params.limite ?? 60);
  return {
    agora,
    desde,
    setores: montarSetores({ fatos: arrumados, contratados: params.contratados, agora }),
    fatos: arrumados,
    setoresMudos: [...new Set(setoresMudos)],
  };
}

// ============================================================
// Miudezas de texto
// ============================================================

async function nomesDaEquipe(venueId: string, ids: string[]): Promise<Map<string, string>> {
  const limpos = [...new Set(ids.filter((id) => id && id !== "undefined"))];
  if (limpos.length === 0) return new Map();
  const { data } = await cliente()
    .from("pesquisa_atendentes")
    .select("id, nome, apelido")
    .eq("venue_id", venueId)
    .in("id", limpos);
  return new Map(
    ((data ?? []) as Array<{ id: string; nome: string; apelido: string | null }>).map((p) => [
      p.id,
      p.apelido || p.nome,
    ]),
  );
}

/** Comentário inteiro não cabe no balão do bonequinho. */
function resumir(txt: string | null, tamanho = 90): string | null {
  if (!txt) return null;
  const limpo = txt.replace(/\s+/g, " ").trim();
  if (!limpo) return null;
  return limpo.length <= tamanho ? limpo : `${limpo.slice(0, tamanho - 1)}…`;
}

function quando(iso: string): string {
  const [ano, mes, dia] = iso.slice(0, 10).split("-");
  const hora = iso.length > 10 ? ` ${iso.slice(11, 16)}` : "";
  return `${dia}/${mes}/${ano}${hora}`;
}

function dinheiro(valor: number): string {
  return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
