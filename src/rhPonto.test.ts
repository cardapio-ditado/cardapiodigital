import assert from "node:assert/strict";
import test from "node:test";
import { ErroDoRh } from "./rh.js";
import {
  atrasoEmMinutos,
  batidasPermitidas,
  conferirPin,
  diaOperacional,
  emHoras,
  hashDoPin,
  horaLocal,
  minutosNoturnos,
  pinValido,
  resumoDoDia,
} from "./rhPonto.js";

const CUIABA = "America/Cuiaba"; // GMT-4 o ano inteiro

/** Instante a partir da hora de Cuiabá, para os testes lerem como a casa lê. */
function naCasa(dia: string, hora: string): string {
  return new Date(`${dia}T${hora}:00-04:00`).toISOString();
}

test("o dia da casa é o da virada, não o da meia-noite", () => {
  // Sábado 22h e domingo 3h são a MESMA noite quando a casa vira às 5h.
  const sabadoNoite = new Date(naCasa("2026-09-19", "22:00"));
  const madrugada = new Date(naCasa("2026-09-20", "03:00"));

  assert.equal(diaOperacional(sabadoNoite, CUIABA, 5), "2026-09-19");
  assert.equal(diaOperacional(madrugada, CUIABA, 5), "2026-09-19", "3h ainda é a noite de sábado");
  // Já às 6h a noite acabou.
  assert.equal(diaOperacional(new Date(naCasa("2026-09-20", "06:00")), CUIABA, 5), "2026-09-20");

  // Casa que vira à meia-noite: cada dia é o do calendário.
  assert.equal(diaOperacional(madrugada, CUIABA, 0), "2026-09-20");
});

test("a hora mostrada é a do relógio da casa, não a do servidor", () => {
  assert.equal(horaLocal(new Date(naCasa("2026-09-19", "18:42")), CUIABA), "18:42");
  assert.equal(horaLocal(new Date(naCasa("2026-09-20", "02:05")), CUIABA), "02:05");
});

test("adicional noturno conta só o que cai entre 22h e 5h", () => {
  // 18h às 22h: nada de noturno.
  assert.equal(minutosNoturnos(new Date(naCasa("2026-09-19", "18:00")), new Date(naCasa("2026-09-19", "22:00")), CUIABA), 0);
  // 21h às 23h: só a última hora conta.
  assert.equal(minutosNoturnos(new Date(naCasa("2026-09-19", "21:00")), new Date(naCasa("2026-09-19", "23:00")), CUIABA), 60);
  // 18h às 2h: das 22h às 2h, quatro horas.
  assert.equal(minutosNoturnos(new Date(naCasa("2026-09-19", "18:00")), new Date(naCasa("2026-09-20", "02:00")), CUIABA), 240);
  // Fechamento pesado: 22h às 6h dá sete horas (para às 5h).
  assert.equal(minutosNoturnos(new Date(naCasa("2026-09-19", "22:00")), new Date(naCasa("2026-09-20", "06:00")), CUIABA), 420);
  // Turno de almoço não tem noturno nenhum.
  assert.equal(minutosNoturnos(new Date(naCasa("2026-09-19", "11:00")), new Date(naCasa("2026-09-19", "15:00")), CUIABA), 0);
  // Intervalo invertido não vira número negativo.
  assert.equal(minutosNoturnos(new Date(naCasa("2026-09-19", "23:00")), new Date(naCasa("2026-09-19", "22:00")), CUIABA), 0);
});

test("o tablet só oferece a batida que faz sentido agora", () => {
  assert.deepEqual(batidasPermitidas([]), ["entrada"]);
  assert.deepEqual(batidasPermitidas(["entrada"]), ["pausa", "saida"]);
  assert.deepEqual(batidasPermitidas(["entrada", "pausa"]), ["volta"]);
  assert.deepEqual(batidasPermitidas(["entrada", "pausa", "volta"]), ["pausa", "saida"]);
  // Quem já saiu pode voltar no mesmo dia da casa — acontece, e barrar
  // mandaria a pessoa procurar o gerente no meio do movimento.
  assert.deepEqual(batidasPermitidas(["entrada", "saida"]), ["entrada"]);
});

test("as horas do dia saem das batidas, com pausa descontada", () => {
  const batidas = [
    { tipo: "entrada", momento: naCasa("2026-09-19", "18:00") },
    { tipo: "pausa", momento: naCasa("2026-09-19", "21:00") },
    { tipo: "volta", momento: naCasa("2026-09-19", "21:30") },
    { tipo: "saida", momento: naCasa("2026-09-20", "02:00") },
  ];
  const r = resumoDoDia(batidas, CUIABA);

  assert.equal(r.minutos_trabalhados, 7 * 60 + 30, "3h + 4h30");
  assert.equal(r.minutos_pausa, 30);
  // Noturno: 22h→2h são 4h. A parte antes das 22h não conta.
  assert.equal(r.minutos_noturnos, 240);
  assert.equal(r.primeira_entrada, "18:00");
  assert.equal(r.ultima_saida, "02:00");
  assert.equal(r.aberto, false);
});

test("turno em andamento conta até agora, para o gestor ver quem está na casa", () => {
  const batidas = [{ tipo: "entrada", momento: naCasa("2026-09-19", "18:00") }];
  const agora = new Date(naCasa("2026-09-19", "20:30"));
  const r = resumoDoDia(batidas, CUIABA, agora);

  assert.equal(r.minutos_trabalhados, 150);
  assert.equal(r.aberto, true);
  assert.equal(r.ultima_saida, null);
});

test("batida fora de ordem não vira hora negativa", () => {
  // Saída sem entrada: o gestor vai corrigir, mas até lá a conta não pode
  // devolver número absurdo para a tela.
  const r = resumoDoDia([{ tipo: "saida", momento: naCasa("2026-09-19", "23:00") }], CUIABA);
  assert.equal(r.minutos_trabalhados, 0);
  assert.equal(r.aberto, false);
});

test("atraso compara a escala com a primeira entrada", () => {
  assert.equal(atrasoEmMinutos("18:00", "18:12"), 12);
  assert.equal(atrasoEmMinutos("18:00:00", "17:50"), -10, "chegou antes");
  assert.equal(atrasoEmMinutos(null, "18:12"), null, "sem escala não existe atraso");
  assert.equal(atrasoEmMinutos("18:00", null), null, "sem batida não existe atraso");
});

test("minutos viram hora do jeito que a casa lê", () => {
  assert.equal(emHoras(450), "7h30");
  assert.equal(emHoras(120), "2h");
  assert.equal(emHoras(0), "0h");
  assert.equal(emHoras(-15), "-0h15");
});

test("PIN só aceita quatro dígitos, e nunca é guardado em texto", async () => {
  assert.equal(pinValido("4729"), true);
  assert.equal(pinValido("123"), false);
  assert.equal(pinValido("12a4"), false);
  assert.equal(pinValido(null), false);

  const guardado = await hashDoPin("4729");
  assert.match(guardado, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]+$/);
  assert.equal(guardado.includes("4729"), false, "o PIN não pode aparecer no que é gravado");

  assert.equal(await conferirPin("4729", guardado), true);
  assert.equal(await conferirPin("4728", guardado), false);
  assert.equal(await conferirPin("4729", null), false);
  assert.equal(await conferirPin("4729", "texto-qualquer"), false);

  // Dois hashes do mesmo PIN são diferentes: o sal é sorteado a cada vez.
  assert.notEqual(await hashDoPin("4729"), guardado);
});

test("PIN óbvio é recusado antes de chegar ao banco", async () => {
  const { definirPin } = await import("./rhPonto.js");
  for (const obvio of ["0000", "1111", "1234", "4321"]) {
    await assert.rejects(
      () => definirPin({ venueId: "v", atendenteId: "a", pin: obvio }),
      (e: unknown) => {
        assert.ok(e instanceof ErroDoRh);
        assert.equal(e.status, 400);
        return true;
      },
      `"${obvio}" deveria ser recusado`,
    );
  }
});
