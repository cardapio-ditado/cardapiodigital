import { db, ehMigracaoPendente } from "./supabase.js";
import { inserirAvisos, normalizarTelefone } from "./notifications.js";
import { ErroDoRh } from "./rh.js";
import type { Venue } from "./venues.js";

/**
 * RH — Fase 2: a escala da semana.
 *
 * A escala de bar vive num grupo de WhatsApp e num papel na cozinha. Todo mês
 * a mesma cena: alguém jura que não estava escalado, a troca combinada na
 * quinta sumiu até sábado, e ninguém sabe qual foto do grupo é a versão boa.
 *
 * Aqui a grade é a versão boa, e publicar é o ato que manda para cada um o
 * horário DELE — não a foto da grade inteira. A mensagem sai pela mesma fila
 * de avisos que já entrega lembrete de reserva, pelo número administrativo da
 * casa (nunca pelo número do agente de IA).
 *
 * Rascunho x publicado: enquanto não publica, o gestor mexe à vontade e
 * ninguém é incomodado. É o que permite montar a semana aos poucos.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cliente = () => db() as any;

function falhar(status: number, contexto: string, mensagem: string): never {
  if (ehMigracaoPendente(mensagem)) {
    throw new ErroDoRh(
      503,
      `${contexto}: o banco ainda não recebeu a migração da escala. Rode o SQL e tente de novo.`,
    );
  }
  throw new ErroDoRh(status, `${contexto}: ${mensagem}`);
}

export const SITUACOES = [
  { id: "trabalha", nome: "Trabalha" },
  { id: "folga", nome: "Folga" },
  { id: "ferias", nome: "Férias" },
  { id: "atestado", nome: "Atestado" },
  { id: "falta", nome: "Falta" },
] as const;

const IDS_DE_SITUACAO = new Set<string>(SITUACOES.map((s) => s.id));

/** Como cada situação aparece na mensagem do WhatsApp. */
const ROTULO_DA_SITUACAO: Record<string, string> = {
  folga: "Folga",
  ferias: "Férias",
  atestado: "Atestado",
  falta: "Falta",
};

const DIAS_CURTOS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

export interface Turno {
  id: string;
  nome: string;
  inicio: string;
  fim: string;
  ordem: number;
  ativo: boolean;
}

export interface LinhaDaEscala {
  id: string;
  data: string;
  atendente_id: string;
  turno_id: string | null;
  situacao: string;
  funcao: string | null;
  observacao: string | null;
}

// ============================================================
// Contas de calendário — sem banco, sem fuso, testáveis
// ============================================================

/** O dia da semana (0 = domingo) de uma data ISO, sem passar pelo fuso local. */
function diaDaSemana(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

export function somarDias(iso: string, dias: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * A segunda-feira da semana que contém esta data.
 *
 * Toda a Fase 2 gira em torno disto: a grade, a publicação e a cópia da
 * semana anterior usam a segunda como nome da semana. Domingo pertence à
 * semana que começou na segunda anterior — que é como a casa fala ("a semana
 * do dia 15"), e não como o JavaScript conta (domingo = 0).
 */
export function segundaDaSemana(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new ErroDoRh(400, "Data da semana inválida.");
  }
  const dow = diaDaSemana(iso);
  const recuo = dow === 0 ? 6 : dow - 1;
  return somarDias(iso, -recuo);
}

export function diasDaSemana(segunda: string): string[] {
  return Array.from({ length: 7 }, (_, i) => somarDias(segunda, i));
}

/** "18:00:00" vira "18h"; "18:30:00" vira "18h30". */
export function horaCurta(hora: string): string {
  const [h, m] = String(hora ?? "").split(":");
  const hh = Number(h);
  if (!Number.isFinite(hh)) return String(hora ?? "");
  return m && m !== "00" ? `${hh}h${m}` : `${hh}h`;
}

/** O turno atravessa a meia-noite? Em bar é o normal, não a exceção. */
export function viraODia(turno: { inicio: string; fim: string }): boolean {
  return turno.fim < turno.inicio;
}

/** "Noite · 18h → 2h (vira o dia)" */
export function descreverTurno(turno: { nome: string; inicio: string; fim: string }): string {
  const faixa = `${horaCurta(turno.inicio)} → ${horaCurta(turno.fim)}`;
  return `${turno.nome} · ${faixa}${viraODia(turno) ? " (vira o dia)" : ""}`;
}

/** "seg 15/09" */
export function diaCurto(iso: string): string {
  const [, mes, dia] = iso.split("-");
  return `${DIAS_CURTOS[diaDaSemana(iso)]} ${dia}/${mes}`;
}

/**
 * A mensagem que cada pessoa recebe no WhatsApp.
 *
 * Só os dias que estão na escala dela. Uma semana inteira com quatro linhas
 * de "sem escala" é mensagem que ninguém lê até o fim — e a última linha
 * explica o silêncio, para ninguém supor folga onde só falta lançamento.
 */
export function mensagemDaSemana(params: {
  nome: string;
  casa: string;
  segunda: string;
  linhas: LinhaDaEscala[];
  turnos: Turno[];
}): string {
  const porId = new Map(params.turnos.map((t) => [t.id, t]));
  const domingo = somarDias(params.segunda, 6);

  const ordenadas = [...params.linhas].sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  const corpo = ordenadas.map((linha) => {
    const turno = linha.turno_id ? porId.get(linha.turno_id) : null;
    if (linha.situacao !== "trabalha" || !turno) {
      return `${diaCurto(linha.data)} · ${ROTULO_DA_SITUACAO[linha.situacao] ?? "Sem turno"}`;
    }
    const extra = linha.funcao ? ` (${linha.funcao})` : "";
    return `${diaCurto(linha.data)} · ${turno.nome} ${horaCurta(turno.inicio)} → ${horaCurta(turno.fim)}${extra}`;
  });

  const partes = [
    `Olá, ${params.nome}! Sua escala de ${diaCurto(params.segunda)} a ${diaCurto(domingo)} — ${params.casa}:`,
    "",
    ...(corpo.length ? corpo : ["Nenhum turno lançado para você nesta semana."]),
    "",
    "Dias que não aparecem aqui não estão na sua escala. Qualquer troca, fale com a gerência.",
  ];
  return partes.join("\n");
}

// ============================================================
// Turnos da casa
// ============================================================

export async function listarTurnos(venueId: string, { incluirInativos = false } = {}): Promise<Turno[]> {
  let consulta = cliente()
    .from("rh_turnos")
    .select("id, nome, inicio, fim, ordem, ativo")
    .eq("venue_id", venueId)
    .order("ordem", { ascending: true })
    .order("inicio", { ascending: true });
  if (!incluirInativos) consulta = consulta.eq("ativo", true);

  const { data, error } = await consulta;
  if (error) falhar(500, "Falha ao listar os turnos", error.message);
  return (data ?? []) as Turno[];
}

function horaValida(valor: unknown, campo: string): string {
  const texto = String(valor ?? "").trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(texto)) {
    throw new ErroDoRh(400, `${campo}: informe a hora no formato 18:00.`);
  }
  return texto.length === 5 ? `${texto}:00` : texto;
}

export async function criarTurno(params: {
  venueId: string;
  nome: string;
  inicio: unknown;
  fim: unknown;
  ordem?: unknown;
}): Promise<Turno> {
  const nome = String(params.nome ?? "").trim();
  if (!nome) throw new ErroDoRh(400, "O turno precisa de um nome.");

  const { data, error } = await cliente()
    .from("rh_turnos")
    .insert({
      venue_id: params.venueId,
      nome,
      inicio: horaValida(params.inicio, "Início"),
      fim: horaValida(params.fim, "Fim"),
      ordem: Number(params.ordem) || 0,
    } as never)
    .select("id, nome, inicio, fim, ordem, ativo")
    .single();

  if (error) {
    if (/duplicate key|unique/i.test(error.message)) {
      throw new ErroDoRh(409, `Já existe um turno chamado "${nome}".`);
    }
    falhar(500, "Falha ao criar o turno", error.message);
  }
  return data as Turno;
}

export async function atualizarTurno(params: {
  venueId: string;
  id: string;
  nome?: unknown;
  inicio?: unknown;
  fim?: unknown;
  ordem?: unknown;
  ativo?: unknown;
}): Promise<Turno> {
  const mudancas: Record<string, unknown> = {};
  if (params.nome !== undefined) {
    const nome = String(params.nome).trim();
    if (!nome) throw new ErroDoRh(400, "O nome do turno não pode ficar vazio.");
    mudancas.nome = nome;
  }
  if (params.inicio !== undefined) mudancas.inicio = horaValida(params.inicio, "Início");
  if (params.fim !== undefined) mudancas.fim = horaValida(params.fim, "Fim");
  if (params.ordem !== undefined) mudancas.ordem = Number(params.ordem) || 0;
  if (params.ativo !== undefined) mudancas.ativo = Boolean(params.ativo);

  const { data, error } = await cliente()
    .from("rh_turnos")
    .update(mudancas as never)
    .eq("venue_id", params.venueId)
    .eq("id", params.id)
    .select("id, nome, inicio, fim, ordem, ativo")
    .maybeSingle();
  if (error) falhar(500, "Falha ao salvar o turno", error.message);
  if (!data) throw new ErroDoRh(404, "Turno não encontrado.");
  return data as Turno;
}

/**
 * Apagar turno leva a escala dele junto (cascade no banco).
 *
 * Por isso a tela desativa em vez de apagar quando já houve escala: o
 * histórico de quem trabalhou vale mais que a lista limpa.
 */
export async function apagarTurno(params: { venueId: string; id: string }): Promise<{ apagado: boolean }> {
  const { count, error: erroConta } = await cliente()
    .from("rh_escala")
    .select("id", { count: "exact", head: true })
    .eq("venue_id", params.venueId)
    .eq("turno_id", params.id);
  if (erroConta) falhar(500, "Falha ao conferir a escala do turno", erroConta.message);

  if ((count ?? 0) > 0) {
    await atualizarTurno({ venueId: params.venueId, id: params.id, ativo: false });
    return { apagado: false };
  }

  const { error } = await cliente()
    .from("rh_turnos")
    .delete()
    .eq("venue_id", params.venueId)
    .eq("id", params.id);
  if (error) falhar(500, "Falha ao apagar o turno", error.message);
  return { apagado: true };
}

// ============================================================
// A grade da semana
// ============================================================

export interface SemanaDaEscala {
  semana: string;
  dias: string[];
  turnos: Turno[];
  pessoas: Array<{ id: string; nome: string; apelido: string | null; funcao: string | null }>;
  linhas: LinhaDaEscala[];
  publicada_em: string | null;
  publicada_por: string | null;
  avisos_enviados: number;
  /** Mudou alguma coisa depois de publicar? A tela avisa para republicar. */
  mudou_depois_de_publicar: boolean;
}

export async function escalaDaSemana(venueId: string, qualquerDia: string): Promise<SemanaDaEscala> {
  const semana = segundaDaSemana(qualquerDia);
  const dias = diasDaSemana(semana);

  const [turnos, pessoas, linhas, publicacao] = await Promise.all([
    listarTurnos(venueId, { incluirInativos: true }),
    pessoasEscalaveis(venueId),
    linhasDaSemana(venueId, semana),
    publicacaoDaSemana(venueId, semana),
  ]);

  const ultimaMexida = linhas.reduce<string | null>((maior, l) => {
    const q = (l as LinhaDaEscala & { atualizada_em?: string }).atualizada_em ?? null;
    return q && (!maior || q > maior) ? q : maior;
  }, null);

  return {
    semana,
    dias,
    // Turno desativado continua na grade se ainda houver escala nele — some
    // só quando ninguém mais depende dele.
    turnos: turnos.filter((t) => t.ativo || linhas.some((l) => l.turno_id === t.id)),
    pessoas,
    linhas,
    publicada_em: publicacao?.publicada_em ?? null,
    publicada_por: publicacao?.publicada_por ?? null,
    avisos_enviados: publicacao?.avisos_enviados ?? 0,
    mudou_depois_de_publicar: Boolean(
      publicacao?.publicada_em && ultimaMexida && ultimaMexida > publicacao.publicada_em,
    ),
  };
}

/** Quem pode entrar na grade: gente ativa no cadastro da casa. */
async function pessoasEscalaveis(venueId: string) {
  const { data, error } = await cliente()
    .from("pesquisa_atendentes")
    .select("id, nome, apelido, funcao")
    .eq("venue_id", venueId)
    .eq("ativo", true)
    .order("nome", { ascending: true });
  if (error) falhar(500, "Falha ao listar a equipe", error.message);
  return (data ?? []) as Array<{ id: string; nome: string; apelido: string | null; funcao: string | null }>;
}

async function linhasDaSemana(venueId: string, semana: string): Promise<LinhaDaEscala[]> {
  const { data, error } = await cliente()
    .from("rh_escala")
    .select("id, data, atendente_id, turno_id, situacao, funcao, observacao, atualizada_em")
    .eq("venue_id", venueId)
    .gte("data", semana)
    .lte("data", somarDias(semana, 6));
  if (error) falhar(500, "Falha ao ler a escala", error.message);
  return (data ?? []) as LinhaDaEscala[];
}

async function publicacaoDaSemana(venueId: string, semana: string) {
  const { data, error } = await cliente()
    .from("rh_semanas")
    .select("publicada_em, publicada_por, avisos_enviados")
    .eq("venue_id", venueId)
    .eq("semana", semana)
    .maybeSingle();
  if (error) falhar(500, "Falha ao ler a publicação da semana", error.message);
  return (data ?? null) as { publicada_em: string; publicada_por: string | null; avisos_enviados: number } | null;
}

function dataValida(valor: unknown): string {
  const texto = String(valor ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) throw new ErroDoRh(400, "Data inválida na escala.");
  return texto;
}

/**
 * Põe alguém na grade — ou muda o que já estava lá.
 *
 * Um clique na célula chama isto. Situação diferente de "trabalha" zera o
 * turno no próprio banco (trigger), então "folga das 18h" não existe.
 */
export async function marcarNaEscala(params: {
  venueId: string;
  data: unknown;
  atendenteId: string;
  turnoId?: string | null;
  situacao?: unknown;
  funcao?: unknown;
  observacao?: unknown;
}): Promise<LinhaDaEscala> {
  const data = dataValida(params.data);
  const situacao = String(params.situacao ?? "trabalha");
  if (!IDS_DE_SITUACAO.has(situacao)) throw new ErroDoRh(400, "Situação desconhecida na escala.");

  const turnoId = situacao === "trabalha" ? (params.turnoId ?? null) : null;
  if (situacao === "trabalha" && !turnoId) {
    throw new ErroDoRh(400, "Escolha o turno de quem vai trabalhar.");
  }

  const linha = {
    venue_id: params.venueId,
    data,
    atendente_id: params.atendenteId,
    turno_id: turnoId,
    situacao,
    funcao: String(params.funcao ?? "").trim() || null,
    observacao: String(params.observacao ?? "").trim() || null,
  };

  // Sempre as quatro colunas, com turno ou sem: o índice é único e usa
  // `nulls not distinct`, então duas folgas no mesmo dia colidem como duas
  // linhas do mesmo turno colidiriam. Mirar em três colunas quando o turno é
  // nulo devolveria "no unique or exclusion constraint matching".
  const { data: gravada, error } = await cliente()
    .from("rh_escala")
    .upsert(linha as never, { onConflict: "venue_id,data,atendente_id,turno_id" })
    .select("id, data, atendente_id, turno_id, situacao, funcao, observacao")
    .single();

  if (error) falhar(500, "Falha ao salvar a escala", error.message);
  return gravada as LinhaDaEscala;
}

export async function tirarDaEscala(params: { venueId: string; id: string }): Promise<{ apagado: boolean }> {
  const { error } = await cliente()
    .from("rh_escala")
    .delete()
    .eq("venue_id", params.venueId)
    .eq("id", params.id);
  if (error) falhar(500, "Falha ao tirar da escala", error.message);
  return { apagado: true };
}

/**
 * Copia a semana anterior para a de agora.
 *
 * É o que faz a escala levar minutos: em bar a semana repete quase igual, e
 * o gestor só ajusta as exceções. Não sobrescreve o que já foi lançado na
 * semana destino — quem já mexeu lá tinha um motivo.
 */
export async function copiarSemana(params: {
  venueId: string;
  de: string;
  para: string;
}): Promise<{ copiadas: number; ignoradas: number }> {
  const origem = segundaDaSemana(dataValida(params.de));
  const destino = segundaDaSemana(dataValida(params.para));
  if (origem === destino) throw new ErroDoRh(400, "Escolha uma semana diferente para copiar.");

  const [linhasOrigem, linhasDestino] = await Promise.all([
    linhasDaSemana(params.venueId, origem),
    linhasDaSemana(params.venueId, destino),
  ]);
  if (linhasOrigem.length === 0) throw new ErroDoRh(404, "A semana escolhida não tem escala para copiar.");

  const deslocamento = Math.round(
    (new Date(`${destino}T12:00:00Z`).getTime() - new Date(`${origem}T12:00:00Z`).getTime()) / 86_400_000,
  );

  const jaTem = new Set(linhasDestino.map((l) => `${l.data}|${l.atendente_id}|${l.turno_id ?? "-"}`));
  const novas = linhasOrigem
    .map((l) => ({
      venue_id: params.venueId,
      data: somarDias(l.data, deslocamento),
      atendente_id: l.atendente_id,
      turno_id: l.turno_id,
      situacao: l.situacao,
      funcao: l.funcao,
      observacao: l.observacao,
    }))
    .filter((l) => !jaTem.has(`${l.data}|${l.atendente_id}|${l.turno_id ?? "-"}`));

  if (novas.length === 0) return { copiadas: 0, ignoradas: linhasOrigem.length };

  const { error } = await cliente().from("rh_escala").insert(novas as never);
  if (error) falhar(500, "Falha ao copiar a semana", error.message);
  return { copiadas: novas.length, ignoradas: linhasOrigem.length - novas.length };
}

// ============================================================
// Publicar: a semana vira mensagem no WhatsApp de cada um
// ============================================================

export interface ResultadoDaPublicacao {
  semana: string;
  avisados: number;
  sem_telefone: string[];
  sem_escala: number;
}

export async function publicarSemana(params: {
  venue: Venue;
  semana: string;
  quem?: string | null;
}): Promise<ResultadoDaPublicacao> {
  const semana = segundaDaSemana(dataValida(params.semana));
  const [turnos, linhas, pessoas] = await Promise.all([
    listarTurnos(params.venue.id, { incluirInativos: true }),
    linhasDaSemana(params.venue.id, semana),
    pessoasEscalaveis(params.venue.id),
  ]);

  if (linhas.length === 0) {
    throw new ErroDoRh(400, "Esta semana ainda não tem ninguém escalado.");
  }

  // O telefone mora na ficha do RH (Fase 1). Quem ainda não tem ficha não
  // recebe — e a tela diz quem são, em vez de fingir que todos foram avisados.
  const { data: fichas, error } = await cliente()
    .from("rh_fichas")
    .select("atendente_id, telefone")
    .eq("venue_id", params.venue.id);
  if (error) falhar(500, "Falha ao ler os telefones da equipe", error.message);

  const telefoneDe = new Map(
    ((fichas ?? []) as Array<{ atendente_id: string; telefone: string | null }>).map((f) => [f.atendente_id, f.telefone]),
  );
  const nomeDe = new Map(pessoas.map((p) => [p.id, p.apelido || p.nome]));

  const porPessoa = new Map<string, LinhaDaEscala[]>();
  for (const linha of linhas) {
    const lista = porPessoa.get(linha.atendente_id) ?? [];
    lista.push(linha);
    porPessoa.set(linha.atendente_id, lista);
  }

  const avisos: Record<string, unknown>[] = [];
  const semTelefone: string[] = [];

  for (const [atendenteId, minhas] of porPessoa) {
    const nome = nomeDe.get(atendenteId);
    // Escala de quem saiu do cadastro no meio da semana: fica na grade como
    // histórico, mas não vira mensagem.
    if (!nome) continue;

    const destino = normalizarTelefone(telefoneDe.get(atendenteId) ?? "");
    if (!destino) {
      semTelefone.push(nome);
      continue;
    }

    avisos.push({
      venue_id: params.venue.id,
      channel: "whatsapp",
      destination: destino,
      template: "rh_escala_semana",
      // Sai pelo número administrativo da casa, nunca pelo do agente de IA:
      // escala é recado da gerência, e resposta vai para uma pessoa.
      papel: "administrativo",
      body: mensagemDaSemana({
        nome,
        casa: params.venue.name,
        segunda: semana,
        linhas: minhas,
        turnos,
      }),
    });
  }

  if (avisos.length > 0) {
    const { error: erroAviso } = await inserirAvisos(avisos);
    if (erroAviso) falhar(500, "Falha ao enfileirar os avisos da escala", erroAviso.message);
  }

  const { error: erroSemana } = await cliente()
    .from("rh_semanas")
    .upsert(
      {
        venue_id: params.venue.id,
        semana,
        publicada_em: new Date().toISOString(),
        publicada_por: params.quem ?? null,
        avisos_enviados: avisos.length,
      } as never,
      { onConflict: "venue_id,semana" },
    );
  if (erroSemana) falhar(500, "Falha ao registrar a publicação", erroSemana.message);

  return {
    semana,
    avisados: avisos.length,
    sem_telefone: semTelefone,
    sem_escala: pessoas.length - porPessoa.size,
  };
}
