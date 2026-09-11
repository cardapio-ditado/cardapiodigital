import { db, ehMigracaoPendente } from "./supabase.js";
import { ErroDoRh } from "./rh.js";

/**
 * RH — Fase 4: férias.
 *
 * O que quebra casa de bar não é conceder férias: é PERDER a data. Cada
 * pessoa acumula um período aquisitivo de doze meses, e a casa tem os doze
 * meses seguintes para conceder. Passou disso, a CLT manda pagar em dobro —
 * e isso costuma se descobrir tarde, junto com o susto.
 *
 * Este arquivo cuida de DATAS e DIAS. Nenhum valor em reais é calculado aqui:
 * terço constitucional, abono e o que entra no recibo continuam com a
 * contabilidade. O que a casa ganha é enxergar o relógio correndo.
 *
 * Os períodos aquisitivos não viram linha no banco: são calculados a partir
 * da admissão, na hora da leitura. Assim nunca ficam desatualizados e não
 * dependem de rotina noturna para nascer.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cliente = () => db() as any;

function falhar(status: number, contexto: string, mensagem: string): never {
  if (ehMigracaoPendente(mensagem)) {
    throw new ErroDoRh(
      503,
      `${contexto}: o banco ainda não recebeu a migração das férias. Rode o SQL e tente de novo.`,
    );
  }
  throw new ErroDoRh(status, `${contexto}: ${mensagem}`);
}

export const SITUACOES_DE_FERIAS = [
  { id: "pedido", nome: "Pedido" },
  { id: "aprovado", nome: "Aprovado" },
  { id: "recusado", nome: "Recusado" },
  { id: "cancelado", nome: "Cancelado" },
] as const;

/** Quantos dias antes do vencimento a tela começa a insistir. */
export const DIAS_DE_ALERTA = 60;

// ============================================================
// Contas de calendário
// ============================================================

function comoData(iso: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso ?? ""))) {
    throw new ErroDoRh(400, `Data inválida: "${iso}".`);
  }
  return new Date(`${iso}T12:00:00Z`);
}

export function somarDias(iso: string, dias: number): string {
  const d = comoData(iso);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * Somar anos sem cair no buraco do 29 de fevereiro.
 *
 * Admissão em 29/02 num ano bissexto: o aniversário do contrato em ano comum
 * não existe, e o JavaScript empurraria para 1º de março sozinho. Fixar em 28
 * mantém o período dentro do mês certo.
 */
export function somarAnos(iso: string, anos: number): string {
  const d = comoData(iso);
  const dia = d.getUTCDate();
  const mes = d.getUTCMonth();
  const alvo = new Date(Date.UTC(d.getUTCFullYear() + anos, mes, dia, 12));
  if (alvo.getUTCMonth() !== mes) alvo.setUTCDate(0);
  return alvo.toISOString().slice(0, 10);
}

/** Dias entre duas datas, contando as duas pontas — como se conta férias. */
export function diasEntre(inicio: string, fim: string): number {
  const a = comoData(inicio).getTime();
  const b = comoData(fim).getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

export type SituacaoDoPeriodo = "em_curso" | "a_conceder" | "a_vencer" | "vencido";

export interface PeriodoAquisitivo {
  numero: number;
  inicio: string;
  fim: string;
  /** Último dia para conceder sem risco de pagar em dobro. */
  limite: string;
  situacao: SituacaoDoPeriodo;
  /** Dias até o limite. Negativo = já passou. */
  dias_para_vencer: number;
}

/**
 * Os períodos aquisitivos de quem foi admitido em tal dia.
 *
 * Um período por ano de contrato. O primeiro fecha doze meses depois da
 * admissão; a casa tem os doze meses seguintes para conceder as férias dele.
 */
export function periodosAquisitivos(admissao: string, hoje: string): PeriodoAquisitivo[] {
  const periodos: PeriodoAquisitivo[] = [];
  const agora = comoData(hoje).getTime();

  for (let numero = 1; numero <= 40; numero += 1) {
    const inicio = somarAnos(admissao, numero - 1);
    if (comoData(inicio).getTime() > agora) break;

    const fim = somarDias(somarAnos(admissao, numero), -1);
    const limite = somarDias(somarAnos(admissao, numero + 1), -1);
    const paraVencer = Math.round((comoData(limite).getTime() - agora) / 86_400_000);

    let situacao: SituacaoDoPeriodo;
    if (comoData(fim).getTime() >= agora) situacao = "em_curso";
    else if (paraVencer < 0) situacao = "vencido";
    else if (paraVencer <= DIAS_DE_ALERTA) situacao = "a_vencer";
    else situacao = "a_conceder";

    periodos.push({ numero, inicio, fim, limite, situacao, dias_para_vencer: paraVencer });
  }
  return periodos;
}

/**
 * Dias de direito conforme as faltas do período (CLT art. 130).
 *
 * Isto é ORIENTAÇÃO, não fechamento: quem confirma a contagem, e o que conta
 * como falta justificada, é a contabilidade. A tela mostra para o gestor não
 * ser pego de surpresa, e deixa o número editável.
 */
export function diasPorFaltas(faltas: number): number {
  const f = Math.max(0, Math.floor(Number(faltas) || 0));
  if (f <= 5) return 30;
  if (f <= 14) return 24;
  if (f <= 23) return 18;
  if (f <= 32) return 12;
  return 0;
}

const DIAS_DA_SEMANA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

export interface Conferencia {
  erros: string[];
  avisos: string[];
}

/**
 * O pedido cabe nas regras?
 *
 * Erro barra; aviso só alerta. A separação é de propósito: o bar tem casos
 * que a lei permite com acordo, e travar tudo faria o gestor lançar as férias
 * fora do sistema — que é exatamente o problema que este módulo veio
 * resolver.
 */
export function conferirPedido(params: {
  inicio: string;
  fim: string;
  abonoDias?: number;
  diasDeDireito: number;
  /** Períodos já pedidos/aprovados dentro do mesmo período aquisitivo. */
  jaTirados: Array<{ inicio: string; fim: string; dias: number; abono_dias?: number }>;
  hoje: string;
}): Conferencia {
  const erros: string[] = [];
  const avisos: string[] = [];

  const dias = diasEntre(params.inicio, params.fim);
  const abono = Math.max(0, Math.floor(Number(params.abonoDias) || 0));

  if (dias < 5) {
    erros.push("Nenhum período de férias pode ter menos de 5 dias corridos.");
  }

  const usados = params.jaTirados.reduce((soma, f) => soma + f.dias + (f.abono_dias ?? 0), 0);
  const saldo = params.diasDeDireito - usados;
  if (dias + abono > saldo) {
    erros.push(
      `Saldo insuficiente: restam ${saldo} dia(s) deste período aquisitivo, e o pedido usa ${dias + abono}.`,
    );
  }

  // Fracionamento: no máximo três períodos, e um deles com 14 dias ou mais.
  const pedacos = [...params.jaTirados.map((f) => f.dias), dias];
  if (pedacos.length > 3) {
    erros.push("As férias podem ser divididas em no máximo 3 períodos.");
  }
  if (pedacos.length > 1 && !pedacos.some((d) => d >= 14)) {
    avisos.push("Quando as férias são divididas, um dos períodos precisa ter pelo menos 14 dias corridos.");
  }

  if (abono > Math.floor(params.diasDeDireito / 3)) {
    erros.push(`O abono (venda) vai até um terço do direito — no máximo ${Math.floor(params.diasDeDireito / 3)} dia(s).`);
  }

  // Aviso prévio de 30 dias (art. 135).
  const antecedencia = Math.round(
    (comoData(params.inicio).getTime() - comoData(params.hoje).getTime()) / 86_400_000,
  );
  if (antecedencia < 0) {
    avisos.push("Este pedido começa numa data que já passou — confira se é lançamento retroativo.");
  } else if (antecedencia < 30) {
    avisos.push(`A lei pede aviso com 30 dias; este pedido começa em ${antecedencia} dia(s).`);
  }

  // As férias não podem começar nos dois dias antes do descanso semanal ou de
  // feriado. Em bar o descanso quase nunca é domingo, então isto é aviso.
  const diaDaSemana = comoData(params.inicio).getUTCDay();
  if (diaDaSemana === 5 || diaDaSemana === 6 || diaDaSemana === 0) {
    avisos.push(
      `As férias começam num ${DIAS_DA_SEMANA[diaDaSemana]}. A lei evita início nos dois dias anteriores ao descanso semanal — confira o descanso desta pessoa.`,
    );
  }

  return { erros, avisos };
}

// ============================================================
// Leitura
// ============================================================

export interface FeriasGravadas {
  id: string;
  atendente_id: string;
  inicio: string;
  fim: string;
  dias: number;
  abono_dias: number;
  periodo_inicio: string | null;
  situacao: string;
  observacao: string | null;
  pedido_por: string | null;
  decidido_por: string | null;
}

export interface PessoaNasFerias {
  atendente_id: string;
  nome: string;
  admissao: string | null;
  periodos: PeriodoAquisitivo[];
  ferias: FeriasGravadas[];
  /** Dias já usados (concedidos ou pedidos) do período mais antigo em aberto. */
  saldo: number | null;
  /** O período que está correndo risco, se houver. */
  alerta: { periodo: number; limite: string; dias_para_vencer: number; vencido: boolean } | null;
}

export async function situacaoDaEquipe(params: {
  venueId: string;
  hoje: string;
}): Promise<{ hoje: string; pessoas: PessoaNasFerias[] }> {
  const [{ data: pessoas, error }, { data: fichas }, { data: ferias }] = await Promise.all([
    cliente()
      .from("pesquisa_atendentes")
      .select("id, nome, apelido")
      .eq("venue_id", params.venueId)
      .eq("ativo", true)
      .order("nome", { ascending: true }),
    cliente().from("rh_fichas").select("atendente_id, admissao, desligamento").eq("venue_id", params.venueId),
    cliente()
      .from("rh_ferias")
      .select("id, atendente_id, inicio, fim, dias, abono_dias, periodo_inicio, situacao, observacao, pedido_por, decidido_por")
      .eq("venue_id", params.venueId)
      .order("inicio", { ascending: false }),
  ]);
  if (error) falhar(500, "Falha ao listar a equipe", error.message);

  const admissoes = new Map(
    ((fichas ?? []) as Array<{ atendente_id: string; admissao: string | null; desligamento: string | null }>)
      .filter((f) => !f.desligamento)
      .map((f) => [f.atendente_id, f.admissao]),
  );

  const porPessoa = new Map<string, FeriasGravadas[]>();
  for (const f of (ferias ?? []) as FeriasGravadas[]) {
    const lista = porPessoa.get(f.atendente_id) ?? [];
    lista.push(f);
    porPessoa.set(f.atendente_id, lista);
  }

  const lista = ((pessoas ?? []) as Array<{ id: string; nome: string; apelido: string | null }>).map((p) => {
    const admissao = admissoes.get(p.id) ?? null;
    const minhas = porPessoa.get(p.id) ?? [];
    const periodos = admissao ? periodosAquisitivos(admissao, params.hoje) : [];

    // O período mais velho que ainda pode ser concedido é o que corre risco.
    const emRisco = periodos.find((per) => per.situacao === "vencido" || per.situacao === "a_vencer") ?? null;

    // Saldo do período mais antigo fechado e ainda não totalmente usado.
    const fechado = periodos.filter((per) => per.situacao !== "em_curso");
    const alvo = fechado[0] ?? null;
    const usados = alvo
      ? minhas
          .filter((f) => f.periodo_inicio === alvo.inicio && (f.situacao === "aprovado" || f.situacao === "pedido"))
          .reduce((soma, f) => soma + f.dias + (f.abono_dias ?? 0), 0)
      : 0;

    return {
      atendente_id: p.id,
      nome: p.apelido || p.nome,
      admissao,
      periodos,
      ferias: minhas,
      saldo: alvo ? 30 - usados : null,
      alerta: emRisco
        ? {
            periodo: emRisco.numero,
            limite: emRisco.limite,
            dias_para_vencer: emRisco.dias_para_vencer,
            vencido: emRisco.situacao === "vencido",
          }
        : null,
    };
  });

  return { hoje: params.hoje, pessoas: lista };
}

/** Quem está de férias dentro de uma janela — o calendário da tela. */
export async function calendario(params: {
  venueId: string;
  de: string;
  ate: string;
}): Promise<FeriasGravadas[]> {
  const { data, error } = await cliente()
    .from("rh_ferias")
    .select("id, atendente_id, inicio, fim, dias, abono_dias, periodo_inicio, situacao, observacao, pedido_por, decidido_por")
    .eq("venue_id", params.venueId)
    .in("situacao", ["pedido", "aprovado"])
    .lte("inicio", params.ate)
    .gte("fim", params.de)
    .order("inicio", { ascending: true });
  if (error) falhar(500, "Falha ao ler o calendário de férias", error.message);
  return (data ?? []) as FeriasGravadas[];
}

// ============================================================
// Escrita
// ============================================================

/** A qual período aquisitivo estas férias pertencem. */
export function periodoDoPedido(periodos: PeriodoAquisitivo[]): string | null {
  const fechado = periodos.filter((p) => p.situacao !== "em_curso");
  return fechado[0]?.inicio ?? periodos[0]?.inicio ?? null;
}

export async function pedirFerias(params: {
  venueId: string;
  atendenteId: string;
  inicio: string;
  fim: string;
  abonoDias?: unknown;
  observacao?: unknown;
  quem: string;
  hoje: string;
}): Promise<{ ferias: FeriasGravadas; avisos: string[] }> {
  const { data: ficha, error: erroFicha } = await cliente()
    .from("rh_fichas")
    .select("admissao")
    .eq("venue_id", params.venueId)
    .eq("atendente_id", params.atendenteId)
    .maybeSingle();
  if (erroFicha) falhar(500, "Falha ao ler a ficha", erroFicha.message);

  const admissao = (ficha as { admissao: string | null } | null)?.admissao ?? null;
  if (!admissao) {
    throw new ErroDoRh(400, "Preencha a data de admissão na ficha antes de lançar férias — é dela que sai o período aquisitivo.");
  }

  const periodos = periodosAquisitivos(admissao, params.hoje);
  const periodoInicio = periodoDoPedido(periodos);

  const { data: jaTem, error: erroJa } = await cliente()
    .from("rh_ferias")
    .select("inicio, fim, dias, abono_dias, situacao, periodo_inicio")
    .eq("venue_id", params.venueId)
    .eq("atendente_id", params.atendenteId)
    .in("situacao", ["pedido", "aprovado"]);
  if (erroJa) falhar(500, "Falha ao ler as férias já lançadas", erroJa.message);

  const doMesmoPeriodo = ((jaTem ?? []) as Array<{
    inicio: string;
    fim: string;
    dias: number;
    abono_dias: number;
    periodo_inicio: string | null;
  }>).filter((f) => f.periodo_inicio === periodoInicio);

  const abono = Math.max(0, Math.floor(Number(params.abonoDias) || 0));
  const conferencia = conferirPedido({
    inicio: params.inicio,
    fim: params.fim,
    abonoDias: abono,
    diasDeDireito: 30,
    jaTirados: doMesmoPeriodo,
    hoje: params.hoje,
  });
  if (conferencia.erros.length > 0) throw new ErroDoRh(400, conferencia.erros.join(" "));

  // Duas férias sobrepostas para a mesma pessoa é sempre erro de lançamento.
  const encavalou = ((jaTem ?? []) as Array<{ inicio: string; fim: string }>).some(
    (f) => f.inicio <= params.fim && f.fim >= params.inicio,
  );
  if (encavalou) throw new ErroDoRh(409, "Esta pessoa já tem férias lançadas que encostam nestas datas.");

  const { data, error } = await cliente()
    .from("rh_ferias")
    .insert({
      venue_id: params.venueId,
      atendente_id: params.atendenteId,
      inicio: params.inicio,
      fim: params.fim,
      dias: diasEntre(params.inicio, params.fim),
      abono_dias: abono,
      periodo_inicio: periodoInicio,
      situacao: "pedido",
      observacao: String(params.observacao ?? "").trim() || null,
      pedido_por: params.quem,
    } as never)
    .select("id, atendente_id, inicio, fim, dias, abono_dias, periodo_inicio, situacao, observacao, pedido_por, decidido_por")
    .single();
  if (error) falhar(500, "Falha ao lançar as férias", error.message);

  return { ferias: data as FeriasGravadas, avisos: conferencia.avisos };
}

/**
 * Aprovar, recusar ou cancelar.
 *
 * Aprovar também marca os dias na escala, se o módulo já tiver a grade: sem
 * isso, a pessoa apareceria escalada durante as próprias férias e alguém
 * cobraria presença dela.
 */
export async function decidirFerias(params: {
  venueId: string;
  id: string;
  situacao: "aprovado" | "recusado" | "cancelado";
  quem: string;
}): Promise<FeriasGravadas> {
  const { data, error } = await cliente()
    .from("rh_ferias")
    .update({
      situacao: params.situacao,
      decidido_por: params.quem,
      decidido_em: new Date().toISOString(),
    } as never)
    .eq("venue_id", params.venueId)
    .eq("id", params.id)
    .select("id, atendente_id, inicio, fim, dias, abono_dias, periodo_inicio, situacao, observacao, pedido_por, decidido_por")
    .maybeSingle();
  if (error) falhar(500, "Falha ao decidir as férias", error.message);
  if (!data) throw new ErroDoRh(404, "Férias não encontradas.");

  const ferias = data as FeriasGravadas;
  if (params.situacao === "aprovado") await marcarNaEscala(params.venueId, ferias);
  if (params.situacao === "cancelado" || params.situacao === "recusado") {
    await limparDaEscala(params.venueId, ferias);
  }
  return ferias;
}

/** Cada dia das férias vira uma linha "férias" na grade da semana. */
async function marcarNaEscala(venueId: string, ferias: FeriasGravadas): Promise<void> {
  const linhas: Record<string, unknown>[] = [];
  for (let dia = ferias.inicio; dia <= ferias.fim; dia = somarDias(dia, 1)) {
    linhas.push({
      venue_id: venueId,
      data: dia,
      atendente_id: ferias.atendente_id,
      turno_id: null,
      situacao: "ferias",
      observacao: "Férias aprovadas",
    });
  }
  if (linhas.length === 0) return;

  const { error } = await cliente()
    .from("rh_escala")
    .upsert(linhas as never, { onConflict: "venue_id,data,atendente_id,turno_id" });
  // A escala é conveniência: se a migração dela não rodou, as férias não
  // podem deixar de ser aprovadas por causa disso.
  if (error) console.error(`[rh-ferias] não deu para marcar na escala: ${error.message}`);
}

async function limparDaEscala(venueId: string, ferias: FeriasGravadas): Promise<void> {
  const { error } = await cliente()
    .from("rh_escala")
    .delete()
    .eq("venue_id", venueId)
    .eq("atendente_id", ferias.atendente_id)
    .eq("situacao", "ferias")
    .gte("data", ferias.inicio)
    .lte("data", ferias.fim);
  if (error) console.error(`[rh-ferias] não deu para limpar a escala: ${error.message}`);
}

export async function apagarFerias(params: { venueId: string; id: string }): Promise<{ apagado: boolean }> {
  const { data } = await cliente()
    .from("rh_ferias")
    .select("id, atendente_id, inicio, fim, dias, abono_dias, periodo_inicio, situacao, observacao, pedido_por, decidido_por")
    .eq("venue_id", params.venueId)
    .eq("id", params.id)
    .maybeSingle();

  const { error } = await cliente()
    .from("rh_ferias")
    .delete()
    .eq("venue_id", params.venueId)
    .eq("id", params.id);
  if (error) falhar(500, "Falha ao apagar as férias", error.message);

  if (data) await limparDaEscala(params.venueId, data as FeriasGravadas);
  return { apagado: true };
}
