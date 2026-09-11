import { db, ehMigracaoPendente } from "./supabase.js";
import { ErroDoRh } from "./rh.js";
import { resumoDoDia } from "./rhPonto.js";

/**
 * RH — Fase 5: a gorjeta do turno, rateada e guardada.
 *
 * O fim da noite num bar é sempre a mesma cena: alguém soma o serviço na
 * calculadora do celular, divide de cabeça e anota num papel. No dia
 * seguinte ninguém lembra quanto foi nem quem estava — e discussão sobre
 * gorjeta é das que mais azedam equipe.
 *
 * O valor total é DIGITADO À MÃO de propósito: assim a casa que não tem o
 * CMV contratado usa a gorjeta do mesmo jeito. Nenhum módulo depende do
 * outro.
 *
 * O que este arquivo entrega de verdade é a conta fechando: a soma das
 * cotas é exatamente o valor lançado, sem centavo sumindo nem sobrando.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cliente = () => db() as any;

function falhar(status: number, contexto: string, mensagem: string): never {
  if (ehMigracaoPendente(mensagem)) {
    throw new ErroDoRh(
      503,
      `${contexto}: o banco ainda não recebeu a migração da gorjeta. Rode o SQL e tente de novo.`,
    );
  }
  throw new ErroDoRh(status, `${contexto}: ${mensagem}`);
}

export const CRITERIOS = [
  { id: "igual", nome: "Igual para todos" },
  { id: "peso", nome: "Por peso da função" },
  { id: "horas", nome: "Pelas horas trabalhadas" },
] as const;

const IDS_DE_CRITERIO = new Set<string>(CRITERIOS.map((c) => c.id));

export interface Participante {
  atendente_id: string;
  nome: string;
  funcao: string | null;
  peso: number;
  minutos: number;
}

export interface Cota extends Participante {
  valor: number;
}

// ============================================================
// O rateio — conta pura, sem banco
// ============================================================

/**
 * Reparte um valor entre participantes, em centavos, sem perder nada.
 *
 * Dividir 100 por 3 dá 33,333… e três pagamentos de 33,33 somam 99,99. O
 * centavo que falta não pode sumir nem ser dado a quem o código listar
 * primeiro: vai para quem ficou com a maior sobra na divisão (método da
 * maior sobra), e o desempate é pelo nome, para a conta ser a mesma toda vez
 * que for refeita.
 *
 * Quem tem peso zero ou não trabalhou minuto nenhum não entra na divisão —
 * mas continua na lista, com zero, para a tela poder mostrar que ele estava
 * lá e por que não recebeu.
 */
export function ratear(params: {
  valor: number;
  criterio: string;
  participantes: Participante[];
}): Cota[] {
  const centavosTotais = Math.round((Number(params.valor) || 0) * 100);
  if (centavosTotais < 0) throw new ErroDoRh(400, "O valor da gorjeta não pode ser negativo.");

  const fatia = (p: Participante): number => {
    if (params.criterio === "peso") return Math.max(0, Number(p.peso) || 0);
    if (params.criterio === "horas") return Math.max(0, Number(p.minutos) || 0);
    return 1;
  };

  const soma = params.participantes.reduce((t, p) => t + fatia(p), 0);
  if (soma <= 0 || centavosTotais === 0) {
    return params.participantes.map((p) => ({ ...p, valor: 0 }));
  }

  const exatos = params.participantes.map((p) => ({
    pessoa: p,
    exato: (centavosTotais * fatia(p)) / soma,
  }));

  const cotas = exatos.map((e) => ({ ...e, centavos: Math.floor(e.exato) }));
  let sobra = centavosTotais - cotas.reduce((t, c) => t + c.centavos, 0);

  // A sobra vai para as maiores frações; empate decide pelo nome, para o
  // mesmo lançamento dar sempre o mesmo resultado.
  const fila = [...cotas]
    .filter((c) => c.exato > 0)
    .sort((a, b) => {
      const fracaoA = a.exato - Math.floor(a.exato);
      const fracaoB = b.exato - Math.floor(b.exato);
      if (fracaoB !== fracaoA) return fracaoB - fracaoA;
      return a.pessoa.nome.localeCompare(b.pessoa.nome, "pt-BR");
    });

  for (let i = 0; sobra > 0 && fila.length > 0; i += 1, sobra -= 1) {
    fila[i % fila.length]!.centavos += 1;
  }

  return cotas.map((c) => ({ ...c.pessoa, valor: c.centavos / 100 }));
}

// ============================================================
// Peso por função
// ============================================================

export async function listarPesos(venueId: string): Promise<Array<{ id: string; funcao: string; peso: number }>> {
  const { data, error } = await cliente()
    .from("rh_pesos")
    .select("id, funcao, peso")
    .eq("venue_id", venueId)
    .order("funcao", { ascending: true });
  if (error) falhar(500, "Falha ao listar os pesos", error.message);
  return ((data ?? []) as Array<{ id: string; funcao: string; peso: string | number }>).map((p) => ({
    ...p,
    peso: Number(p.peso),
  }));
}

export async function definirPeso(params: {
  venueId: string;
  funcao: string;
  peso: unknown;
}): Promise<{ funcao: string; peso: number }> {
  const funcao = String(params.funcao ?? "").trim();
  if (!funcao) throw new ErroDoRh(400, "Diga a função que vai ter peso próprio.");
  const peso = Number(params.peso);
  if (!Number.isFinite(peso) || peso < 0) throw new ErroDoRh(400, "O peso precisa ser um número maior ou igual a zero.");

  const { error } = await cliente()
    .from("rh_pesos")
    .upsert({ venue_id: params.venueId, funcao, peso } as never, { onConflict: "venue_id,funcao" });
  if (error) falhar(500, "Falha ao salvar o peso", error.message);
  return { funcao, peso };
}

export async function apagarPeso(params: { venueId: string; id: string }): Promise<{ apagado: boolean }> {
  const { error } = await cliente().from("rh_pesos").delete().eq("venue_id", params.venueId).eq("id", params.id);
  if (error) falhar(500, "Falha ao apagar o peso", error.message);
  return { apagado: true };
}

// ============================================================
// Quem estava no turno
// ============================================================

/**
 * Quem entra no rateio de um turno.
 *
 * A lista sai da escala (quem estava previsto para trabalhar) somada a quem
 * bateu ponto naquele dia — porque em bar entra gente de última hora, e
 * quem trabalhou tem direito mesmo sem estar na grade.
 */
export async function participantesDoTurno(params: {
  venueId: string;
  dia: string;
  turnoId?: string | null;
  timezone: string;
}): Promise<Participante[]> {
  const [{ data: escala, error }, { data: pontos }, { data: pessoas }, pesos] = await Promise.all([
    cliente()
      .from("rh_escala")
      .select("atendente_id, turno_id, situacao, funcao")
      .eq("venue_id", params.venueId)
      .eq("data", params.dia),
    cliente()
      .from("rh_pontos")
      .select("atendente_id, tipo, momento")
      .eq("venue_id", params.venueId)
      .eq("dia", params.dia)
      .order("momento", { ascending: true }),
    cliente().from("pesquisa_atendentes").select("id, nome, apelido, funcao").eq("venue_id", params.venueId),
    listarPesos(params.venueId),
  ]);
  if (error) falhar(500, "Falha ao ler a escala do turno", error.message);

  const pesoDa = new Map(pesos.map((p) => [p.funcao.toLowerCase(), p.peso]));
  const cadastro = new Map(
    ((pessoas ?? []) as Array<{ id: string; nome: string; apelido: string | null; funcao: string | null }>).map((p) => [
      p.id,
      p,
    ]),
  );

  const batidasDe = new Map<string, Array<{ tipo: string; momento: string }>>();
  for (const b of (pontos ?? []) as Array<{ atendente_id: string; tipo: string; momento: string }>) {
    const lista = batidasDe.get(b.atendente_id) ?? [];
    lista.push({ tipo: b.tipo, momento: b.momento });
    batidasDe.set(b.atendente_id, lista);
  }

  const doTurno = ((escala ?? []) as Array<{
    atendente_id: string;
    turno_id: string | null;
    situacao: string;
    funcao: string | null;
  }>).filter((e) => e.situacao === "trabalha" && (!params.turnoId || e.turno_id === params.turnoId));

  const ids = new Set([...doTurno.map((e) => e.atendente_id), ...batidasDe.keys()]);
  const funcaoNaEscala = new Map(doTurno.map((e) => [e.atendente_id, e.funcao]));

  const lista: Participante[] = [...ids].map((id) => {
    const pessoa = cadastro.get(id);
    const funcao = funcaoNaEscala.get(id) || pessoa?.funcao || null;
    const minhas = batidasDe.get(id) ?? [];
    return {
      atendente_id: id,
      nome: pessoa?.apelido || pessoa?.nome || "—",
      funcao,
      peso: funcao ? (pesoDa.get(funcao.toLowerCase()) ?? 1) : 1,
      minutos: minhas.length ? resumoDoDia(minhas, params.timezone).minutos_trabalhados : 0,
    };
  });

  lista.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  return lista;
}

// ============================================================
// Lançar, listar e apagar
// ============================================================

export interface GorjetaGravada {
  id: string;
  dia: string;
  turno_id: string | null;
  valor: number;
  criterio: string;
  observacao: string | null;
  criado_por: string | null;
  cotas: Cota[];
}

export async function lancarGorjeta(params: {
  venueId: string;
  dia: string;
  turnoId?: string | null;
  valor: unknown;
  criterio: string;
  observacao?: unknown;
  timezone: string;
  quem: string;
  /** Quando a tela manda a lista já ajustada à mão. */
  participantes?: Participante[];
}): Promise<GorjetaGravada> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(params.dia))) throw new ErroDoRh(400, "Data inválida.");
  if (!IDS_DE_CRITERIO.has(params.criterio)) throw new ErroDoRh(400, "Critério de rateio desconhecido.");

  const valor = Number(params.valor);
  if (!Number.isFinite(valor) || valor <= 0) throw new ErroDoRh(400, "Informe o valor arrecadado no turno.");

  const participantes =
    params.participantes && params.participantes.length > 0
      ? params.participantes
      : await participantesDoTurno({
          venueId: params.venueId,
          dia: params.dia,
          turnoId: params.turnoId ?? null,
          timezone: params.timezone,
        });

  if (participantes.length === 0) {
    throw new ErroDoRh(400, "Ninguém escalado nem com ponto batido neste turno — não há entre quem dividir.");
  }

  const cotas = ratear({ valor, criterio: params.criterio, participantes });

  const { data, error } = await cliente()
    .from("rh_gorjetas")
    .upsert(
      {
        venue_id: params.venueId,
        dia: params.dia,
        turno_id: params.turnoId ?? null,
        valor,
        criterio: params.criterio,
        observacao: String(params.observacao ?? "").trim() || null,
        criado_por: params.quem,
      } as never,
      { onConflict: "venue_id,dia,turno_id" },
    )
    .select("id, dia, turno_id, valor, criterio, observacao, criado_por")
    .single();
  if (error) falhar(500, "Falha ao lançar a gorjeta", error.message);

  const gorjeta = data as { id: string; dia: string; turno_id: string | null; valor: string | number; criterio: string; observacao: string | null; criado_por: string | null };

  // Relançar o mesmo turno refaz a divisão: as cotas velhas saem antes.
  await cliente().from("rh_gorjeta_cotas").delete().eq("venue_id", params.venueId).eq("gorjeta_id", gorjeta.id);

  const { error: erroCotas } = await cliente()
    .from("rh_gorjeta_cotas")
    .insert(
      cotas.map((c) => ({
        venue_id: params.venueId,
        gorjeta_id: gorjeta.id,
        atendente_id: c.atendente_id,
        peso: c.peso,
        minutos: c.minutos,
        valor: c.valor,
      })) as never,
    );
  if (erroCotas) falhar(500, "Falha ao gravar o rateio", erroCotas.message);

  return { ...gorjeta, valor: Number(gorjeta.valor), cotas };
}

export async function listarGorjetas(params: {
  venueId: string;
  de: string;
  ate: string;
}): Promise<GorjetaGravada[]> {
  const { data, error } = await cliente()
    .from("rh_gorjetas")
    .select("id, dia, turno_id, valor, criterio, observacao, criado_por")
    .eq("venue_id", params.venueId)
    .gte("dia", params.de)
    .lte("dia", params.ate)
    .order("dia", { ascending: false });
  if (error) falhar(500, "Falha ao listar as gorjetas", error.message);

  const gorjetas = (data ?? []) as Array<{
    id: string;
    dia: string;
    turno_id: string | null;
    valor: string | number;
    criterio: string;
    observacao: string | null;
    criado_por: string | null;
  }>;
  if (gorjetas.length === 0) return [];

  const [{ data: cotas }, { data: pessoas }] = await Promise.all([
    cliente()
      .from("rh_gorjeta_cotas")
      .select("gorjeta_id, atendente_id, peso, minutos, valor")
      .in("gorjeta_id", gorjetas.map((g) => g.id)),
    cliente().from("pesquisa_atendentes").select("id, nome, apelido, funcao").eq("venue_id", params.venueId),
  ]);

  const nomes = new Map(
    ((pessoas ?? []) as Array<{ id: string; nome: string; apelido: string | null; funcao: string | null }>).map((p) => [
      p.id,
      p,
    ]),
  );

  const porGorjeta = new Map<string, Cota[]>();
  for (const c of (cotas ?? []) as Array<{
    gorjeta_id: string;
    atendente_id: string;
    peso: string | number;
    minutos: number;
    valor: string | number;
  }>) {
    const pessoa = nomes.get(c.atendente_id);
    const lista = porGorjeta.get(c.gorjeta_id) ?? [];
    lista.push({
      atendente_id: c.atendente_id,
      nome: pessoa?.apelido || pessoa?.nome || "—",
      funcao: pessoa?.funcao ?? null,
      peso: Number(c.peso),
      minutos: c.minutos,
      valor: Number(c.valor),
    });
    porGorjeta.set(c.gorjeta_id, lista);
  }

  return gorjetas.map((g) => ({
    ...g,
    valor: Number(g.valor),
    cotas: (porGorjeta.get(g.id) ?? []).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")),
  }));
}

export async function apagarGorjeta(params: { venueId: string; id: string }): Promise<{ apagado: boolean }> {
  const { error } = await cliente()
    .from("rh_gorjetas")
    .delete()
    .eq("venue_id", params.venueId)
    .eq("id", params.id);
  if (error) falhar(500, "Falha ao apagar o fechamento", error.message);
  return { apagado: true };
}
