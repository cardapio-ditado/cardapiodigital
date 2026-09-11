import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { db, ehMigracaoPendente } from "./supabase.js";
import { deslocamentoDoFuso } from "./fuso.js";
import { temModulo } from "./modulos.js";
import { ErroDoRh } from "./rh.js";
// A classe é utilitária e não carrega nada do cardápio junto: importar não
// cria dependência de MÓDULO (contrato), só reaproveita código que já existe
// e já foi testado. Duplicar um limitador de ritmo seria pior.
import { LimiteDeRitmo } from "./cardapioDigital.js";

/**
 * RH — Fase 3: o ponto, batido num tablet fixo na casa.
 *
 * Um tablet preso na parede, sem app e sem login individual: a pessoa toca no
 * próprio nome, digita quatro dígitos e bate entrada, pausa, volta ou saída.
 * Garçom não tem crachá nem e-mail corporativo, e quase sempre está com as
 * mãos ocupadas — qualquer coisa mais pesada que isso não é usada, e um ponto
 * que não é usado é pior que nenhum.
 *
 * Hora trabalhada NÃO é campo: é conta feita em cima das batidas. Por isso a
 * correção do gestor também vira batida, com autor e motivo. Ponto sem rastro
 * não serve numa discussão trabalhista — nem para a casa, nem para a pessoa.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cliente = () => db() as any;

const scryptAsync = promisify(scrypt) as (
  senha: string,
  sal: Buffer,
  tamanho: number,
) => Promise<Buffer>;

function falhar(status: number, contexto: string, mensagem: string): never {
  if (ehMigracaoPendente(mensagem)) {
    throw new ErroDoRh(
      503,
      `${contexto}: o banco ainda não recebeu a migração do ponto. Rode o SQL e tente de novo.`,
    );
  }
  throw new ErroDoRh(status, `${contexto}: ${mensagem}`);
}

/**
 * Quatro dígitos são fracos por natureza — 10 mil combinações.
 *
 * O que segura não é o tamanho do PIN: é o tablet estar dentro da casa e o
 * limite de tentativas. Cinco erros por minuto por totem transformam a força
 * bruta em algo que leva dias e aparece na cara de todo mundo.
 */
export const LIMITE_DE_PIN = new LimiteDeRitmo(5, 60_000);

export const TIPOS_DE_BATIDA = ["entrada", "pausa", "volta", "saida"] as const;
export type TipoDeBatida = (typeof TIPOS_DE_BATIDA)[number];

export interface Batida {
  id: string;
  atendente_id: string;
  dia: string;
  tipo: TipoDeBatida;
  momento: string;
  origem: string;
  editado_por: string | null;
  motivo: string | null;
}

// ============================================================
// O relógio da casa — contas puras, sem banco
// ============================================================

/**
 * O dia DA CASA a que um instante pertence.
 *
 * A casa que vira às 5h fecha a noite de sábado às 4h59 de domingo. Sem isto,
 * a saída da madrugada cairia no dia seguinte e toda noite apareceria partida
 * em dois dias — com meia jornada em cada.
 */
export function diaOperacional(instante: Date, fuso: string, virada = 0): string {
  const local = instante.getTime() + deslocamentoDoFuso(instante, fuso) - virada * 3_600_000;
  return new Date(local).toISOString().slice(0, 10);
}

/** "18:42" no relógio da casa. */
export function horaLocal(instante: Date, fuso: string): string {
  const local = new Date(instante.getTime() + deslocamentoDoFuso(instante, fuso));
  return local.toISOString().slice(11, 16);
}

/**
 * Minutos entre 22h e 5h dentro de um intervalo — o adicional noturno.
 *
 * Calculado nas HORAS, não no salário: quem transforma minuto noturno em
 * dinheiro é a contabilidade, com o percentual e a hora reduzida que a
 * convenção da categoria manda.
 */
export function minutosNoturnos(inicio: Date, fim: Date, fuso: string): number {
  if (fim.getTime() <= inicio.getTime()) return 0;

  const localInicio = inicio.getTime() + deslocamentoDoFuso(inicio, fuso);
  const localFim = fim.getTime() + deslocamentoDoFuso(fim, fuso);

  const DIA = 86_400_000;
  let total = 0;
  // Uma janela por dia local tocado: das 22h às 5h do dia seguinte. Começa um
  // dia antes porque a janela que pegou a virada nasceu ontem.
  const primeiro = Math.floor(localInicio / DIA) * DIA - DIA;
  for (let dia = primeiro; dia <= localFim; dia += DIA) {
    const abre = dia + 22 * 3_600_000;
    const fecha = dia + 29 * 3_600_000;
    total += Math.max(0, Math.min(localFim, fecha) - Math.max(localInicio, abre));
  }
  return Math.round(total / 60_000);
}

/**
 * O que o tablet pode oferecer agora, dado o que já foi batido hoje.
 *
 * Duas opções depois da entrada (pausar ou sair) porque em bar nem todo turno
 * tem pausa. Depois da saída volta a aceitar entrada: quem sai às 16h e volta
 * às 19h no mesmo dia da casa é comum, e barrar isso mandaria a pessoa
 * procurar o gerente no meio do movimento.
 */
export function batidasPermitidas(tiposDoDia: string[]): TipoDeBatida[] {
  const ultima = tiposDoDia[tiposDoDia.length - 1];
  if (!ultima) return ["entrada"];
  if (ultima === "entrada" || ultima === "volta") return ["pausa", "saida"];
  if (ultima === "pausa") return ["volta"];
  return ["entrada"];
}

export interface ResumoDoDia {
  minutos_trabalhados: number;
  minutos_pausa: number;
  minutos_noturnos: number;
  primeira_entrada: string | null;
  ultima_saida: string | null;
  /** Bateu entrada e ainda não bateu saída. */
  aberto: boolean;
}

/**
 * Quanto a pessoa trabalhou, a partir das batidas.
 *
 * Trabalhando é o tempo entre entrada/volta e a pausa/saída seguinte. Dia
 * ainda aberto conta até agora — é o que faz o painel do gestor mostrar quem
 * está na casa neste minuto.
 */
export function resumoDoDia(
  batidas: Array<{ tipo: string; momento: string }>,
  fuso: string,
  agora = new Date(),
): ResumoDoDia {
  const ordenadas = [...batidas].sort((a, b) => a.momento.localeCompare(b.momento));

  let trabalhados = 0;
  let pausa = 0;
  let noturnos = 0;
  let entrouEm: Date | null = null;
  let pausouEm: Date | null = null;
  let primeira: Date | null = null;
  let ultimaSaida: Date | null = null;

  for (const b of ordenadas) {
    const quando = new Date(b.momento);
    if (b.tipo === "entrada" || b.tipo === "volta") {
      if (b.tipo === "entrada" && !primeira) primeira = quando;
      if (pausouEm) {
        pausa += quando.getTime() - pausouEm.getTime();
        pausouEm = null;
      }
      entrouEm = quando;
    } else if (entrouEm) {
      trabalhados += quando.getTime() - entrouEm.getTime();
      noturnos += minutosNoturnos(entrouEm, quando, fuso);
      entrouEm = null;
      if (b.tipo === "pausa") pausouEm = quando;
      else ultimaSaida = quando;
    }
  }

  // Turno em andamento: conta até agora, senão quem está na casa aparece com
  // zero hora e o gestor acha que ninguém bateu ponto.
  if (entrouEm) {
    trabalhados += agora.getTime() - entrouEm.getTime();
    noturnos += minutosNoturnos(entrouEm, agora, fuso);
  }

  return {
    minutos_trabalhados: Math.max(0, Math.round(trabalhados / 60_000)),
    minutos_pausa: Math.max(0, Math.round(pausa / 60_000)),
    minutos_noturnos: noturnos,
    primeira_entrada: primeira ? horaLocal(primeira, fuso) : null,
    ultima_saida: ultimaSaida ? horaLocal(ultimaSaida, fuso) : null,
    aberto: entrouEm !== null,
  };
}

/** "7h20" a partir de minutos. */
export function emHoras(minutos: number): string {
  const h = Math.floor(Math.abs(minutos) / 60);
  const m = Math.abs(minutos) % 60;
  const sinal = minutos < 0 ? "-" : "";
  return m === 0 ? `${sinal}${h}h` : `${sinal}${h}h${String(m).padStart(2, "0")}`;
}

/**
 * Atraso em minutos: previsto pela escala x primeira entrada.
 *
 * Negativo quer dizer que chegou antes. Null quando falta um dos dois lados —
 * sem escala não existe atraso, só presença.
 */
export function atrasoEmMinutos(
  horaPrevista: string | null | undefined,
  primeiraEntrada: string | null | undefined,
): number | null {
  if (!horaPrevista || !primeiraEntrada) return null;
  const paraMinutos = (hhmm: string) => {
    const [h, m] = hhmm.split(":");
    return Number(h) * 60 + Number(m ?? 0);
  };
  return paraMinutos(primeiraEntrada.slice(0, 5)) - paraMinutos(horaPrevista.slice(0, 5));
}

// ============================================================
// PIN
// ============================================================

export function pinValido(pin: unknown): boolean {
  return /^\d{4}$/.test(String(pin ?? ""));
}

export async function hashDoPin(pin: string): Promise<string> {
  const sal = randomBytes(16);
  const hash = await scryptAsync(pin, sal, 32);
  return `scrypt$${sal.toString("hex")}$${hash.toString("hex")}`;
}

export async function conferirPin(pin: string, guardado: string | null | undefined): Promise<boolean> {
  const partes = String(guardado ?? "").split("$");
  if (partes.length !== 3 || partes[0] !== "scrypt") return false;
  try {
    const sal = Buffer.from(partes[1]!, "hex");
    const esperado = Buffer.from(partes[2]!, "hex");
    const calculado = await scryptAsync(pin, sal, esperado.length);
    return esperado.length === calculado.length && timingSafeEqual(esperado, calculado);
  } catch {
    return false;
  }
}

export async function definirPin(params: {
  venueId: string;
  atendenteId: string;
  pin: string;
}): Promise<{ definido: boolean }> {
  if (!pinValido(params.pin)) throw new ErroDoRh(400, "O PIN precisa ter exatamente 4 números.");
  // 1234, 0000 e afins são o primeiro chute de qualquer um.
  if (/^(\d)\1{3}$/.test(params.pin) || ["1234", "4321", "0123"].includes(params.pin)) {
    throw new ErroDoRh(400, "Escolha um PIN menos óbvio: 0000, 1111 e 1234 são o primeiro chute.");
  }

  const { error } = await cliente()
    .from("rh_fichas")
    .upsert(
      {
        venue_id: params.venueId,
        atendente_id: params.atendenteId,
        pin_hash: await hashDoPin(params.pin),
        pin_atualizado_em: new Date().toISOString(),
      } as never,
      { onConflict: "atendente_id" },
    );
  if (error) falhar(500, "Falha ao gravar o PIN", error.message);
  return { definido: true };
}

// ============================================================
// Totens
// ============================================================

export interface Totem {
  id: string;
  nome: string;
  token: string;
  ativo: boolean;
  ultimo_uso_em: string | null;
}

export async function listarTotens(venueId: string): Promise<Totem[]> {
  const { data, error } = await cliente()
    .from("rh_totens")
    .select("id, nome, token, ativo, ultimo_uso_em")
    .eq("venue_id", venueId)
    .order("criado_em", { ascending: true });
  if (error) falhar(500, "Falha ao listar os totens", error.message);
  return (data ?? []) as Totem[];
}

export async function criarTotem(params: { venueId: string; nome: string }): Promise<Totem> {
  const nome = String(params.nome ?? "").trim() || "Tablet da casa";
  const { data, error } = await cliente()
    .from("rh_totens")
    .insert({ venue_id: params.venueId, nome, token: randomBytes(24).toString("base64url") } as never)
    .select("id, nome, token, ativo, ultimo_uso_em")
    .single();
  if (error) falhar(500, "Falha ao criar o totem", error.message);
  return data as Totem;
}

export async function atualizarTotem(params: {
  venueId: string;
  id: string;
  nome?: unknown;
  ativo?: unknown;
}): Promise<Totem> {
  const mudancas: Record<string, unknown> = {};
  if (params.nome !== undefined) mudancas.nome = String(params.nome).trim() || "Tablet da casa";
  if (params.ativo !== undefined) mudancas.ativo = Boolean(params.ativo);

  const { data, error } = await cliente()
    .from("rh_totens")
    .update(mudancas as never)
    .eq("venue_id", params.venueId)
    .eq("id", params.id)
    .select("id, nome, token, ativo, ultimo_uso_em")
    .maybeSingle();
  if (error) falhar(500, "Falha ao salvar o totem", error.message);
  if (!data) throw new ErroDoRh(404, "Totem não encontrado.");
  return data as Totem;
}

export async function apagarTotem(params: { venueId: string; id: string }): Promise<{ apagado: boolean }> {
  const { error } = await cliente()
    .from("rh_totens")
    .delete()
    .eq("venue_id", params.venueId)
    .eq("id", params.id);
  if (error) falhar(500, "Falha ao apagar o totem", error.message);
  return { apagado: true };
}

// ============================================================
// A porta do tablet — pública, protegida pelo token do endereço
// ============================================================

interface CasaDoTotem {
  totemId: string;
  venueId: string;
  nome: string;
  timezone: string;
  virada: number;
}

async function casaDoToken(token: string): Promise<CasaDoTotem> {
  const { data, error } = await cliente()
    .from("rh_totens")
    .select("id, venue_id, ativo")
    .eq("token", String(token ?? ""))
    .maybeSingle();
  if (error) falhar(500, "Falha ao reconhecer o totem", error.message);
  if (!data) throw new ErroDoRh(404, "Este tablet não está autorizado. Peça um endereço novo à gerência.");
  if (!(data as { ativo: boolean }).ativo) throw new ErroDoRh(403, "Este tablet foi desativado pela gerência.");

  const venueId = (data as { venue_id: string }).venue_id;

  // A casa que cancelou o RH não pode ter um tablet esquecido na parede
  // continuando a registrar ponto de um módulo que ninguém paga.
  if (!(await temModulo(venueId, "rh"))) {
    throw new ErroDoRh(404, "Este tablet não está autorizado. Peça um endereço novo à gerência.");
  }

  const { data: casa, error: erroCasa } = await cliente()
    .from("venues")
    .select("id, name, timezone, virada_do_dia")
    .eq("id", venueId)
    .maybeSingle();
  if (erroCasa) falhar(500, "Falha ao ler a casa", erroCasa.message);
  if (!casa) throw new ErroDoRh(404, "Casa não encontrada.");

  const c = casa as { name: string; timezone: string | null; virada_do_dia: number | null };
  return {
    totemId: (data as { id: string }).id,
    venueId,
    nome: c.name,
    timezone: c.timezone ?? "America/Cuiaba",
    virada: Number(c.virada_do_dia) || 0,
  };
}

/**
 * A tela do tablet: quem pode bater e em que pé cada um está.
 *
 * Devolve nome e apelido, nada mais. Nem CPF, nem salário, nem telefone: o
 * tablet fica num corredor onde passa cliente, fornecedor e entregador.
 */
export async function telaDoTotem(token: string): Promise<{
  casa: string;
  dia: string;
  pessoas: Array<{
    id: string;
    nome: string;
    tem_pin: boolean;
    permitidas: TipoDeBatida[];
    ultima: string | null;
    aberto: boolean;
  }>;
}> {
  const casa = await casaDoToken(token);
  const dia = diaOperacional(new Date(), casa.timezone, casa.virada);

  const { data: pessoas, error } = await cliente()
    .from("pesquisa_atendentes")
    .select("id, nome, apelido")
    .eq("venue_id", casa.venueId)
    .eq("ativo", true)
    .order("nome", { ascending: true });
  if (error) falhar(500, "Falha ao listar a equipe", error.message);

  const lista = (pessoas ?? []) as Array<{ id: string; nome: string; apelido: string | null }>;
  if (lista.length === 0) return { casa: casa.nome, dia, pessoas: [] };

  const ids = lista.map((p) => p.id);

  const [{ data: fichas }, { data: batidas }] = await Promise.all([
    cliente().from("rh_fichas").select("atendente_id, pin_hash").eq("venue_id", casa.venueId).in("atendente_id", ids),
    cliente()
      .from("rh_pontos")
      .select("atendente_id, tipo, momento")
      .eq("venue_id", casa.venueId)
      .eq("dia", dia)
      .order("momento", { ascending: true }),
  ]);

  const temPin = new Set(
    ((fichas ?? []) as Array<{ atendente_id: string; pin_hash: string | null }>)
      .filter((f) => f.pin_hash)
      .map((f) => f.atendente_id),
  );

  const doDia = new Map<string, Array<{ tipo: string; momento: string }>>();
  for (const b of (batidas ?? []) as Array<{ atendente_id: string; tipo: string; momento: string }>) {
    const lista = doDia.get(b.atendente_id) ?? [];
    lista.push({ tipo: b.tipo, momento: b.momento });
    doDia.set(b.atendente_id, lista);
  }

  return {
    casa: casa.nome,
    dia,
    pessoas: lista.map((p) => {
      const minhas = doDia.get(p.id) ?? [];
      const ultima = minhas[minhas.length - 1] ?? null;
      return {
        id: p.id,
        nome: p.apelido || p.nome,
        tem_pin: temPin.has(p.id),
        permitidas: batidasPermitidas(minhas.map((b) => b.tipo)),
        ultima: ultima ? `${ultima.tipo} às ${horaLocal(new Date(ultima.momento), casa.timezone)}` : null,
        aberto: ultima ? ultima.tipo === "entrada" || ultima.tipo === "volta" : false,
      };
    }),
  };
}

const NOME_DA_BATIDA: Record<string, string> = {
  entrada: "Entrada",
  pausa: "Pausa",
  volta: "Volta da pausa",
  saida: "Saída",
};

export async function baterPonto(params: {
  token: string;
  atendenteId: string;
  pin: string;
  tipo: string;
  chaveDoRitmo: string;
}): Promise<{ registrado: true; tipo: string; hora: string; mensagem: string }> {
  if (!LIMITE_DE_PIN.permitir(params.chaveDoRitmo)) {
    throw new ErroDoRh(429, "Muitas tentativas seguidas. Espere um minuto e tente de novo.");
  }

  const casa = await casaDoToken(params.token);
  const tipo = String(params.tipo);
  if (!TIPOS_DE_BATIDA.includes(tipo as TipoDeBatida)) {
    throw new ErroDoRh(400, "Tipo de batida desconhecido.");
  }

  const { data: ficha, error } = await cliente()
    .from("rh_fichas")
    .select("pin_hash")
    .eq("venue_id", casa.venueId)
    .eq("atendente_id", params.atendenteId)
    .maybeSingle();
  if (error) falhar(500, "Falha ao conferir o PIN", error.message);

  const hash = (ficha as { pin_hash: string | null } | null)?.pin_hash ?? null;
  if (!hash) throw new ErroDoRh(400, "Você ainda não tem PIN. Peça para a gerência criar o seu.");
  if (!(await conferirPin(String(params.pin ?? ""), hash))) {
    // Mensagem igual para PIN errado e pessoa errada: dizer qual dos dois
    // falhou ajudaria quem está tentando adivinhar.
    throw new ErroDoRh(401, "PIN incorreto.");
  }

  const agora = new Date();
  const dia = diaOperacional(agora, casa.timezone, casa.virada);

  const { data: doDia, error: erroDia } = await cliente()
    .from("rh_pontos")
    .select("tipo")
    .eq("venue_id", casa.venueId)
    .eq("atendente_id", params.atendenteId)
    .eq("dia", dia)
    .order("momento", { ascending: true });
  if (erroDia) falhar(500, "Falha ao ler as batidas do dia", erroDia.message);

  const permitidas = batidasPermitidas(((doDia ?? []) as Array<{ tipo: string }>).map((b) => b.tipo));
  if (!permitidas.includes(tipo as TipoDeBatida)) {
    throw new ErroDoRh(
      409,
      `Agora não dá para bater "${NOME_DA_BATIDA[tipo] ?? tipo}". O próximo passo é ${permitidas
        .map((t) => NOME_DA_BATIDA[t]?.toLowerCase() ?? t)
        .join(" ou ")}.`,
    );
  }

  const { error: erroGravar } = await cliente()
    .from("rh_pontos")
    .insert({
      venue_id: casa.venueId,
      atendente_id: params.atendenteId,
      dia,
      tipo,
      momento: agora.toISOString(),
      origem: "totem",
      totem_id: casa.totemId,
    } as never);
  if (erroGravar) falhar(500, "Falha ao registrar a batida", erroGravar.message);

  await cliente()
    .from("rh_totens")
    .update({ ultimo_uso_em: agora.toISOString() } as never)
    .eq("id", casa.totemId);

  const hora = horaLocal(agora, casa.timezone);
  return {
    registrado: true,
    tipo,
    hora,
    mensagem: `${NOME_DA_BATIDA[tipo] ?? tipo} registrada às ${hora}.`,
  };
}

// ============================================================
// A tela do gestor
// ============================================================

export interface PessoaNoPonto {
  atendente_id: string;
  nome: string;
  escalado: string | null;
  situacao_escala: string | null;
  batidas: Batida[];
  resumo: ResumoDoDia;
  atraso: number | null;
  /** Escalado e sem nenhuma batida no dia. */
  faltou: boolean;
}

export async function pontoDoDia(params: {
  venueId: string;
  timezone: string;
  virada: number;
  dia?: string;
}): Promise<{ dia: string; pessoas: PessoaNoPonto[] }> {
  const dia = params.dia ?? diaOperacional(new Date(), params.timezone, params.virada);

  const [{ data: batidas, error }, { data: escala }, { data: pessoas }, { data: turnos }] = await Promise.all([
    cliente()
      .from("rh_pontos")
      .select("id, atendente_id, dia, tipo, momento, origem, editado_por, motivo")
      .eq("venue_id", params.venueId)
      .eq("dia", dia)
      .order("momento", { ascending: true }),
    cliente()
      .from("rh_escala")
      .select("atendente_id, turno_id, situacao")
      .eq("venue_id", params.venueId)
      .eq("data", dia),
    cliente().from("pesquisa_atendentes").select("id, nome, apelido").eq("venue_id", params.venueId),
    cliente().from("rh_turnos").select("id, nome, inicio").eq("venue_id", params.venueId),
  ]);
  if (error) falhar(500, "Falha ao ler o ponto do dia", error.message);

  const nomes = new Map(
    ((pessoas ?? []) as Array<{ id: string; nome: string; apelido: string | null }>).map((p) => [
      p.id,
      p.apelido || p.nome,
    ]),
  );
  const horaDoTurno = new Map(
    ((turnos ?? []) as Array<{ id: string; nome: string; inicio: string }>).map((t) => [t.id, t]),
  );

  const daPessoa = new Map<string, Batida[]>();
  for (const b of (batidas ?? []) as Batida[]) {
    const lista = daPessoa.get(b.atendente_id) ?? [];
    lista.push(b);
    daPessoa.set(b.atendente_id, lista);
  }

  const escalados = new Map<string, { turno_id: string | null; situacao: string }>();
  for (const e of (escala ?? []) as Array<{ atendente_id: string; turno_id: string | null; situacao: string }>) {
    // Quem tem dois turnos no dia: vale o primeiro para efeito de atraso.
    if (!escalados.has(e.atendente_id)) escalados.set(e.atendente_id, e);
  }

  // Aparece quem foi escalado OU quem bateu ponto. Quem não fez nenhum dos
  // dois não é notícia — e a lista fica do tamanho do dia, não do quadro.
  const ids = new Set([...daPessoa.keys(), ...escalados.keys()]);

  const lista: PessoaNoPonto[] = [...ids].map((id) => {
    const minhas = daPessoa.get(id) ?? [];
    const previsto = escalados.get(id) ?? null;
    const turno = previsto?.turno_id ? horaDoTurno.get(previsto.turno_id) : null;
    const resumo = resumoDoDia(minhas, params.timezone);
    const escalado = turno ? turno.inicio.slice(0, 5) : null;

    return {
      atendente_id: id,
      nome: nomes.get(id) ?? "—",
      escalado,
      situacao_escala: previsto?.situacao ?? null,
      batidas: minhas,
      resumo,
      atraso: atrasoEmMinutos(escalado, resumo.primeira_entrada),
      faltou: Boolean(previsto && previsto.situacao === "trabalha" && minhas.length === 0),
    };
  });

  lista.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  return { dia, pessoas: lista };
}

/**
 * O gestor corrige uma batida — e a correção fica registrada como tal.
 *
 * Nunca apaga e regrava por baixo: `origem = 'gestor'`, com quem editou e o
 * motivo. É essa linha que responde "por que o ponto da Cida mudou".
 */
export async function corrigirPonto(params: {
  venueId: string;
  id: string;
  momento?: unknown;
  motivo: string;
  quem: string;
}): Promise<Batida> {
  const motivo = String(params.motivo ?? "").trim();
  if (!motivo) throw new ErroDoRh(400, "Diga o motivo da correção — é ele que vale numa discussão depois.");

  const mudancas: Record<string, unknown> = {
    origem: "gestor",
    editado_por: params.quem,
    motivo,
  };
  if (params.momento !== undefined) {
    const quando = new Date(String(params.momento));
    if (Number.isNaN(quando.getTime())) throw new ErroDoRh(400, "Horário inválido.");
    mudancas.momento = quando.toISOString();
  }

  const { data, error } = await cliente()
    .from("rh_pontos")
    .update(mudancas as never)
    .eq("venue_id", params.venueId)
    .eq("id", params.id)
    .select("id, atendente_id, dia, tipo, momento, origem, editado_por, motivo")
    .maybeSingle();
  if (error) falhar(500, "Falha ao corrigir a batida", error.message);
  if (!data) throw new ErroDoRh(404, "Batida não encontrada.");
  return data as Batida;
}

/** Lançamento à mão: alguém esqueceu de bater, e o gestor registra por ele. */
export async function lancarPonto(params: {
  venueId: string;
  atendenteId: string;
  dia: string;
  tipo: string;
  hora: string;
  timezone: string;
  motivo: string;
  quem: string;
}): Promise<Batida> {
  if (!TIPOS_DE_BATIDA.includes(params.tipo as TipoDeBatida)) {
    throw new ErroDoRh(400, "Tipo de batida desconhecido.");
  }
  if (!/^\d{2}:\d{2}$/.test(params.hora)) throw new ErroDoRh(400, "Informe a hora no formato 18:30.");
  const motivo = String(params.motivo ?? "").trim();
  if (!motivo) throw new ErroDoRh(400, "Diga por que está lançando esta batida à mão.");

  // A hora digitada é a do relógio da casa; o banco guarda o instante.
  const ingenuo = new Date(`${params.dia}T${params.hora}:00Z`);
  const momento = new Date(ingenuo.getTime() - deslocamentoDoFuso(ingenuo, params.timezone));

  const { data, error } = await cliente()
    .from("rh_pontos")
    .insert({
      venue_id: params.venueId,
      atendente_id: params.atendenteId,
      dia: params.dia,
      tipo: params.tipo,
      momento: momento.toISOString(),
      origem: "gestor",
      editado_por: params.quem,
      motivo,
    } as never)
    .select("id, atendente_id, dia, tipo, momento, origem, editado_por, motivo")
    .single();
  if (error) falhar(500, "Falha ao lançar a batida", error.message);
  return data as Batida;
}

export async function apagarPonto(params: { venueId: string; id: string }): Promise<{ apagado: boolean }> {
  const { error } = await cliente()
    .from("rh_pontos")
    .delete()
    .eq("venue_id", params.venueId)
    .eq("id", params.id);
  if (error) falhar(500, "Falha ao apagar a batida", error.message);
  return { apagado: true };
}
