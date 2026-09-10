import assert from "node:assert/strict";
import test from "node:test";
import { ErroDoRh } from "./rh.js";
import {
  descreverTurno,
  diaCurto,
  diasDaSemana,
  horaCurta,
  mensagemDaSemana,
  segundaDaSemana,
  somarDias,
  viraODia,
  type LinhaDaEscala,
  type Turno,
} from "./rhEscala.js";

const NOITE: Turno = { id: "t1", nome: "Noite", inicio: "18:00:00", fim: "02:00:00", ordem: 2, ativo: true };
const ALMOCO: Turno = { id: "t2", nome: "Almoço", inicio: "11:00:00", fim: "15:30:00", ordem: 1, ativo: true };

function linha(mudancas: Partial<LinhaDaEscala>): LinhaDaEscala {
  return {
    id: "x",
    data: "2026-09-14",
    atendente_id: "p1",
    turno_id: NOITE.id,
    situacao: "trabalha",
    funcao: null,
    observacao: null,
    ...mudancas,
  };
}

test("a semana começa na segunda, e domingo pertence à semana que passou", () => {
  // 14/09/2026 é uma segunda-feira.
  assert.equal(segundaDaSemana("2026-09-14"), "2026-09-14");
  assert.equal(segundaDaSemana("2026-09-17"), "2026-09-14", "quinta");
  assert.equal(segundaDaSemana("2026-09-19"), "2026-09-14", "sábado");
  // O domingo é o fim da semana da casa, não o começo — é o dia de maior
  // movimento e ninguém chama aquilo de "semana nova".
  assert.equal(segundaDaSemana("2026-09-20"), "2026-09-14", "domingo");
  assert.equal(segundaDaSemana("2026-09-21"), "2026-09-21", "segunda seguinte");
});

test("a semana tem sete dias e atravessa a virada do mês", () => {
  const dias = diasDaSemana("2026-09-28");
  assert.equal(dias.length, 7);
  assert.equal(dias[0], "2026-09-28");
  assert.equal(dias[3], "2026-10-01", "quinta cai em outubro");
  assert.equal(dias[6], "2026-10-04");
  // Ano bissexto: 2028 tem 29 de fevereiro.
  assert.equal(somarDias("2028-02-28", 1), "2028-02-29");
  assert.equal(somarDias("2026-01-01", -1), "2025-12-31");
});

test("data que não é data não vira semana", () => {
  assert.throws(() => segundaDaSemana("14/09/2026"), ErroDoRh);
  assert.throws(() => segundaDaSemana(""), ErroDoRh);
});

test("turno de bar atravessa a meia-noite, e a tela diz isso", () => {
  assert.equal(viraODia(NOITE), true);
  assert.equal(viraODia(ALMOCO), false);
  assert.equal(horaCurta("18:00:00"), "18h");
  assert.equal(horaCurta("15:30:00"), "15h30");
  assert.equal(descreverTurno(NOITE), "Noite · 18h → 2h (vira o dia)");
  assert.equal(descreverTurno(ALMOCO), "Almoço · 11h → 15h30");
});

test("o dia aparece do jeito que a casa fala", () => {
  assert.equal(diaCurto("2026-09-14"), "seg 14/09");
  assert.equal(diaCurto("2026-09-20"), "dom 20/09");
});

test("a mensagem traz só os dias da pessoa, com turno, função e folga", () => {
  const texto = mensagemDaSemana({
    nome: "Cida",
    casa: "Ditado Popular",
    segunda: "2026-09-14",
    turnos: [NOITE, ALMOCO],
    linhas: [
      linha({ data: "2026-09-18", turno_id: ALMOCO.id, funcao: "Caixa" }),
      linha({ data: "2026-09-14" }),
      linha({ data: "2026-09-16", situacao: "folga", turno_id: null }),
    ],
  });

  assert.match(texto, /Olá, Cida!/);
  assert.match(texto, /Ditado Popular/);
  assert.match(texto, /seg 14\/09 a dom 20\/09/);
  // Ordem cronológica, mesmo com as linhas chegando fora de ordem do banco.
  assert.ok(texto.indexOf("seg 14/09 · Noite") < texto.indexOf("qua 16/09 · Folga"));
  assert.ok(texto.indexOf("qua 16/09 · Folga") < texto.indexOf("sex 18/09 · Almoço"));
  assert.match(texto, /sex 18\/09 · Almoço 11h → 15h30 \(Caixa\)/);
  assert.match(texto, /seg 14\/09 · Noite 18h → 2h/);
  // Terça e quinta não foram lançadas: não aparecem, e a última linha impede
  // que o silêncio seja lido como folga.
  assert.doesNotMatch(texto, /ter 15/);
  assert.match(texto, /não aparecem aqui não estão na sua escala/);
});

test("semana sem nada lançado ainda gera mensagem honesta", () => {
  const texto = mensagemDaSemana({
    nome: "JB",
    casa: "Ditado Popular",
    segunda: "2026-09-14",
    turnos: [NOITE],
    linhas: [],
  });
  assert.match(texto, /Nenhum turno lançado para você nesta semana/);
});

test("férias e atestado aparecem pelo nome, não como turno vazio", () => {
  const texto = mensagemDaSemana({
    nome: "Ana",
    casa: "Ditado",
    segunda: "2026-09-14",
    turnos: [NOITE],
    linhas: [
      linha({ data: "2026-09-15", situacao: "ferias", turno_id: null }),
      linha({ data: "2026-09-16", situacao: "atestado", turno_id: null }),
    ],
  });
  assert.match(texto, /ter 15\/09 · Férias/);
  assert.match(texto, /qua 16\/09 · Atestado/);
});
