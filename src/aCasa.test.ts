import assert from "node:assert/strict";
import test from "node:test";
import {
  SETORES,
  arrumarFatos,
  comoFazTempo,
  minutosEntre,
  montarSetores,
  oQueCadaUmFaz,
  primeiroNome,
  setorDaFuncao,
  type Fato,
  type Trabalhador,
} from "./aCasa.js";

const fato = (id: string, setor: string, quando: string, extra: Partial<Fato> = {}): Fato => ({
  id,
  quando,
  setor,
  tipo: "teste",
  titulo: "Alguma coisa aconteceu",
  detalhe: null,
  quem: null,
  atencao: false,
  ...extra,
});

const TODOS = ["agentes-ia", "cmv", "rh", "cardapio-digital", "checklist", "clientes"];

test("as salas cabem na planta e nenhuma invade a outra", () => {
  for (const s of SETORES) {
    assert.ok(s.x >= 0 && s.y >= 0, `${s.id} começa fora da planta`);
    assert.ok(s.x + s.w <= 100, `${s.id} passa da borda direita`);
    assert.ok(s.y + s.h <= 100, `${s.id} passa da borda de baixo`);
    assert.ok(s.w >= 20 && s.h >= 20, `${s.id} é pequena demais para um boneco caber`);
  }
  // Duas salas sobrepostas põem um boneco dentro da parede da outra.
  for (const a of SETORES) {
    for (const b of SETORES) {
      if (a.id >= b.id) continue;
      const separadas = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(separadas, `${a.id} e ${b.id} se sobrepõem`);
    }
  }
});

test("cada função vai para a sala onde ela trabalha, com o cadastro torto que existe", () => {
  // O cadastro do bar tem "GARCOM", "garçom" e "Garçonete" na mesma lista.
  assert.equal(setorDaFuncao("GARCOM"), "salao");
  assert.equal(setorDaFuncao("garçom"), "salao");
  assert.equal(setorDaFuncao("Garçonete"), "salao");
  assert.equal(setorDaFuncao("Auxiliar de Cozinha"), "cozinha");
  assert.equal(setorDaFuncao("CHAPEIRO"), "cozinha");
  assert.equal(setorDaFuncao("Estoquista"), "doca");
  assert.equal(setorDaFuncao("subgerente"), "escritorio");
  assert.equal(setorDaFuncao("Segurança"), "porta");
  assert.equal(setorDaFuncao("Barman"), "salao", "quem não se encaixa fica no salão");
  assert.equal(setorDaFuncao(null), "salao");

  // Toda sala apontada existe de verdade na planta.
  const ids = new Set(SETORES.map((s) => s.id));
  for (const f of ["GARCOM", "Cozinha", "Estoquista", "gerente", "Portaria", "Limpeza", null] as Array<string | null>) {
    assert.ok(ids.has(setorDaFuncao(f)), `${f} foi para uma sala que não existe`);
  }
});

test("fato repetido não entra duas vezes", () => {
  // A tela pergunta de novo a cada quinze segundos, e a borda da janela
  // devolve o mesmo fato. Sem o corte pelo id, o bonequinho andaria de novo.
  const r = arrumarFatos([
    fato("a", "porta", "2026-09-12T10:00:00.000Z"),
    fato("a", "porta", "2026-09-12T10:00:00.000Z"),
    fato("b", "doca", "2026-09-12T11:00:00.000Z"),
  ]);
  assert.deepEqual(r.map((f) => f.id), ["b", "a"], "o mais novo primeiro, e sem repetir");
});

test("o limite corta os mais velhos, nunca os mais novos", () => {
  const muitos = Array.from({ length: 30 }, (_, i) =>
    fato(`f${i}`, "porta", `2026-09-12T${String(i % 24).padStart(2, "0")}:00:00.000Z`));
  const r = arrumarFatos(muitos, 5);
  assert.equal(r.length, 5);
  assert.equal(r[0]!.quando > r[4]!.quando, true);
});

test("setor sem contrato fica apagado e não conta nada", () => {
  const fatos = [fato("a", "doca", "2026-09-12T10:00:00.000Z")];
  const setores = montarSetores({ fatos, contratados: ["agentes-ia"], agora: "2026-09-12T10:30:00.000Z" });

  const doca = setores.find((s) => s.id === "doca")!;
  assert.equal(doca.contratado, false);
  assert.equal(doca.quantos, 0);
  assert.equal(doca.ultimo, null);
  assert.equal(doca.minutos_parado, null, "cobrar 'parado há 30 min' de quem não comprou é mentira");

  const porta = setores.find((s) => s.id === "porta")!;
  assert.equal(porta.contratado, true);
});

test("o setor guarda o fato mais recente e há quanto tempo foi", () => {
  const setores = montarSetores({
    fatos: arrumarFatos([
      fato("velho", "doca", "2026-09-12T08:00:00.000Z", { titulo: "Contagem aberta" }),
      fato("novo", "doca", "2026-09-12T10:00:00.000Z", { titulo: "Mercadoria recebida" }),
    ]),
    contratados: TODOS,
    agora: "2026-09-12T10:45:00.000Z",
  });

  const doca = setores.find((s) => s.id === "doca")!;
  assert.equal(doca.quantos, 2);
  assert.equal(doca.ultimo!.titulo, "Mercadoria recebida");
  assert.equal(doca.minutos_parado, 45);
});

test("setor contratado e sem movimento aparece como quieto, não como erro", () => {
  const setores = montarSetores({ fatos: [], contratados: TODOS, agora: "2026-09-12T10:00:00.000Z" });
  for (const s of setores) {
    assert.equal(s.contratado, true);
    assert.equal(s.quantos, 0);
    assert.equal(s.minutos_parado, null);
  }
});

test("o tempo é dito como gente fala", () => {
  assert.equal(comoFazTempo(null), "nada ainda");
  assert.equal(comoFazTempo(0), "agora mesmo");
  assert.equal(comoFazTempo(12), "há 12 min");
  assert.equal(comoFazTempo(59), "há 59 min");
  assert.equal(comoFazTempo(60), "há 1 h");
  assert.equal(comoFazTempo(180), "há 3 h");
  assert.equal(comoFazTempo(60 * 24), "ontem");
  assert.equal(comoFazTempo(60 * 72), "há 3 dias");
});

test("minutos entre dois instantes nunca é negativo", () => {
  assert.equal(minutosEntre("2026-09-12T10:00:00.000Z", "2026-09-12T10:30:00.000Z"), 30);
  // Relógio do servidor atrás do carimbo do banco acontece; virar número
  // negativo faria a tela dizer "parado há -2 min".
  assert.equal(minutosEntre("2026-09-12T10:30:00.000Z", "2026-09-12T10:00:00.000Z"), 0);
});

test("o bonequinho leva só o primeiro nome", () => {
  assert.equal(primeiroNome("Juliana Barbosa dos Santos"), "Juliana");
  assert.equal(primeiroNome("  Cida  "), "Cida");
  assert.equal(primeiroNome(""), null);
  assert.equal(primeiroNome(null), null);
});

test("o que precisa de atenção continua marcado depois de arrumado", () => {
  const r = arrumarFatos([
    fato("a", "porta", "2026-09-12T10:00:00.000Z", { atencao: true, titulo: "Reserva esperando" }),
    fato("b", "salao", "2026-09-12T11:00:00.000Z"),
  ]);
  assert.equal(r.filter((f) => f.atencao).length, 1);
  assert.equal(r.find((f) => f.atencao)!.titulo, "Reserva esperando");
});

// ============================================================
// Quem está fazendo o quê
// ============================================================

const trabalhador = (nome: string, setor: string, extra: Partial<Trabalhador> = {}): Trabalhador => ({
  id: `pessoa:${nome}`,
  nome,
  tipo: "pessoa",
  papel: null,
  setor,
  fazendo: null,
  desde: null,
  minutos_parado: null,
  em_pausa: false,
  ...extra,
});

test("quem acabou de fazer alguma coisa aparece fazendo aquilo", () => {
  const r = oQueCadaUmFaz({
    trabalhadores: [trabalhador("Juliana", "salao")],
    fatos: [fato("a", "salao", "2026-09-12T20:50:00.000Z", { quem: "Juliana", titulo: "Mesa 12: Chamou o garçom" })],
    agora: "2026-09-12T21:00:00.000Z",
  });
  assert.equal(r[0]!.fazendo, "Mesa 12: Chamou o garçom");
  assert.equal(r[0]!.minutos_parado, 10);
});

test("quem não fez nada há muito tempo fica ocioso, e a tela diz há quanto", () => {
  const r = oQueCadaUmFaz({
    trabalhadores: [trabalhador("Cida", "cozinha", { desde: "2026-09-12T18:00:00.000Z" })],
    fatos: [fato("a", "cozinha", "2026-09-12T18:10:00.000Z", { quem: "Cida", titulo: "Produziu 4 lote(s)" })],
    agora: "2026-09-12T21:00:00.000Z",
  });
  assert.equal(r[0]!.fazendo, null, "quase três horas depois não é mais 'fazendo'");
  assert.equal(r[0]!.minutos_parado, 170);
});

test("a fronteira do ocioso é o limite, não um chute", () => {
  const cenario = (minutos: number) => oQueCadaUmFaz({
    trabalhadores: [trabalhador("JB", "salao")],
    fatos: [fato("a", "salao", "2026-09-12T21:00:00.000Z", { quem: "JB", titulo: "Bateu entrada" })],
    agora: new Date(Date.parse("2026-09-12T21:00:00.000Z") + minutos * 60000).toISOString(),
    minutosParaOcioso: 25,
  })[0];

  assert.equal(cenario(25)!.fazendo, "Bateu entrada", "em cima do limite ainda está fazendo");
  assert.equal(cenario(26)!.fazendo, null, "um minuto depois, ocioso");
});

test("quem está em pausa não é ocioso: está em pausa", () => {
  const r = oQueCadaUmFaz({
    trabalhadores: [trabalhador("Tiago", "salao", { em_pausa: true, desde: "2026-09-12T20:40:00.000Z" })],
    fatos: [fato("a", "salao", "2026-09-12T20:58:00.000Z", { quem: "Tiago", titulo: "Mesa 7: Curtiu um item" })],
    agora: "2026-09-12T21:00:00.000Z",
  });
  assert.equal(r[0]!.fazendo, null);
  assert.equal(r[0]!.em_pausa, true);
  assert.equal(r[0]!.minutos_parado, 20, "conta desde a pausa, não desde o último fato");
});

test("o agente que já sabe o que faz não tem isso sobrescrito", () => {
  const r = oQueCadaUmFaz({
    trabalhadores: [trabalhador("Atendente", "porta", { tipo: "agente", fazendo: "Respondendo Renata" })],
    fatos: [],
    agora: "2026-09-12T21:00:00.000Z",
  });
  assert.equal(r[0]!.fazendo, "Respondendo Renata");
});

test("fato de outra pessoa não vira trabalho de quem tem nome parecido", () => {
  const r = oQueCadaUmFaz({
    trabalhadores: [trabalhador("Ana", "salao"), trabalhador("Ana Paula", "salao")],
    fatos: [fato("a", "salao", "2026-09-12T20:55:00.000Z", { quem: "Ana Paula", titulo: "Mesa 3" })],
    agora: "2026-09-12T21:00:00.000Z",
  });
  // "Ana Paula" casa com "Ana Paula" e, por prefixo, também com "Ana" —
  // o cadastro guarda apelido e nome completo da mesma pessoa.
  assert.equal(r.find((t) => t.nome === "Ana Paula")!.fazendo, "Mesa 3");

  const semParentesco = oQueCadaUmFaz({
    trabalhadores: [trabalhador("Marcos", "porta")],
    fatos: [fato("a", "porta", "2026-09-12T20:55:00.000Z", { quem: "Marcelo", titulo: "Bateu entrada" })],
    agora: "2026-09-12T21:00:00.000Z",
  });
  assert.equal(semParentesco[0]!.fazendo, null, "Marcelo não é Marcos");
});

test("ninguém na casa não quebra a conta", () => {
  const r = oQueCadaUmFaz({ trabalhadores: [], fatos: [], agora: "2026-09-12T21:00:00.000Z" });
  assert.deepEqual(r, []);
});
