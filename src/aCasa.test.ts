import assert from "node:assert/strict";
import test from "node:test";
import {
  SETORES,
  arrumarFatos,
  comoFazTempo,
  minutosEntre,
  montarSetores,
  primeiroNome,
  type Fato,
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

test("a planta tem um setor por lugar do bar, sem coordenada repetida", () => {
  const posicoes = new Set(SETORES.map((s) => `${s.x},${s.y}`));
  assert.equal(posicoes.size, SETORES.length, "dois setores no mesmo ponto se sobrepõem na tela");
  for (const s of SETORES) {
    assert.ok(s.x > 5 && s.x < 95, `${s.id} encosta na borda da planta`);
    assert.ok(s.y > 5 && s.y < 95, `${s.id} encosta na borda da planta`);
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
