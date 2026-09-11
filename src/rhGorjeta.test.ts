import assert from "node:assert/strict";
import test from "node:test";
import { ErroDoRh } from "./rh.js";
import { calcularGorjeta, ratear, type Participante } from "./rhGorjeta.js";
import { bordasDoMes, comoCsv, comoTexto, diasDentroDaJanela, type ResumoDoMes } from "./rhResumo.js";

function gente(nome: string, extra: Partial<Participante> = {}): Participante {
  return { atendente_id: nome.toLowerCase(), nome, funcao: "Garçom", peso: 1, minutos: 480, ...extra };
}

const soma = (cotas: Array<{ valor: number }>) => Math.round(cotas.reduce((t, c) => t + c.valor, 0) * 100) / 100;

test("dividir por três não perde o centavo", () => {
  const cotas = ratear({
    valor: 100,
    criterio: "igual",
    participantes: [gente("Ana"), gente("Bruno"), gente("Cida")],
  });

  assert.equal(soma(cotas), 100, "a soma precisa bater com o valor lançado");
  const valores = cotas.map((c) => c.valor).sort();
  assert.deepEqual(valores, [33.33, 33.33, 33.34]);
});

test("o centavo que sobra vai sempre para a mesma pessoa, não para quem vier primeiro", () => {
  const participantes = [gente("Ana"), gente("Bruno"), gente("Cida")];
  const primeira = ratear({ valor: 100, criterio: "igual", participantes });
  const segunda = ratear({ valor: 100, criterio: "igual", participantes: [...participantes].reverse() });

  const mapa = (cotas: Array<{ nome: string; valor: number }>) =>
    Object.fromEntries(cotas.map((c) => [c.nome, c.valor]));
  assert.deepEqual(mapa(primeira), mapa(segunda), "a ordem da lista não pode mudar quem ganha o centavo");
});

test("rateio por peso: garçom pesa mais que apoio", () => {
  const cotas = ratear({
    valor: 300,
    criterio: "peso",
    participantes: [
      gente("Ana", { peso: 2 }),
      gente("Bruno", { peso: 2 }),
      gente("Cida", { peso: 1, funcao: "Apoio" }),
    ],
  });

  const valor = (n: string) => cotas.find((c) => c.nome === n)!.valor;
  assert.equal(valor("Ana"), 120);
  assert.equal(valor("Bruno"), 120);
  assert.equal(valor("Cida"), 60);
  assert.equal(soma(cotas), 300);
});

test("rateio por horas: quem ficou meio turno leva metade", () => {
  const cotas = ratear({
    valor: 450,
    criterio: "horas",
    participantes: [gente("Ana", { minutos: 480 }), gente("Bruno", { minutos: 240 }), gente("Cida", { minutos: 240 })],
  });

  const valor = (n: string) => cotas.find((c) => c.nome === n)!.valor;
  assert.equal(valor("Ana"), 225);
  assert.equal(valor("Bruno"), 112.5);
  assert.equal(valor("Cida"), 112.5);
  assert.equal(soma(cotas), 450);
});

test("quem não trabalhou minuto nenhum não entra no rateio por horas, mas aparece com zero", () => {
  const cotas = ratear({
    valor: 200,
    criterio: "horas",
    participantes: [gente("Ana", { minutos: 480 }), gente("Faltou", { minutos: 0 })],
  });

  assert.equal(cotas.find((c) => c.nome === "Ana")!.valor, 200);
  assert.equal(cotas.find((c) => c.nome === "Faltou")!.valor, 0, "aparece na lista para a tela explicar");
  assert.equal(soma(cotas), 200);
});

test("peso zero para todo mundo não quebra nem faz dinheiro sumir", () => {
  const cotas = ratear({
    valor: 100,
    criterio: "peso",
    participantes: [gente("Ana", { peso: 0 }), gente("Bruno", { peso: 0 })],
  });
  assert.deepEqual(cotas.map((c) => c.valor), [0, 0]);
});

test("valores quebrados continuam fechando no total", () => {
  for (const valor of [0.01, 0.05, 7.77, 199.99, 1234.56]) {
    for (const quantos of [2, 3, 4, 7, 11]) {
      const participantes = Array.from({ length: quantos }, (_, i) => gente(`P${i}`));
      const cotas = ratear({ valor, criterio: "igual", participantes });
      assert.equal(soma(cotas), valor, `${valor} entre ${quantos} não fechou`);
    }
  }
});

test("valor negativo é recusado antes de virar cota", () => {
  assert.throws(() => ratear({ valor: -10, criterio: "igual", participantes: [gente("Ana")] }), ErroDoRh);
});

test("as bordas do mês pegam o último dia certo, inclusive em fevereiro", () => {
  assert.deepEqual(bordasDoMes("2026-09"), { de: "2026-09-01", ate: "2026-09-30" });
  assert.deepEqual(bordasDoMes("2026-02"), { de: "2026-02-01", ate: "2026-02-28" });
  assert.deepEqual(bordasDoMes("2028-02"), { de: "2028-02-01", ate: "2028-02-29" }, "bissexto");
  assert.deepEqual(bordasDoMes("2026-12"), { de: "2026-12-01", ate: "2026-12-31" });
  assert.throws(() => bordasDoMes("setembro"), ErroDoRh);
});

test("férias que atravessam o mês contam só os dias de dentro", () => {
  // 25/09 a 10/10, olhando setembro: seis dias (25 a 30).
  assert.equal(diasDentroDaJanela("2026-09-25", "2026-10-10", "2026-09-01", "2026-09-30"), 6);
  // O mesmo período, olhando outubro: dez dias.
  assert.equal(diasDentroDaJanela("2026-09-25", "2026-10-10", "2026-10-01", "2026-10-31"), 10);
  // Fora da janela.
  assert.equal(diasDentroDaJanela("2026-11-01", "2026-11-10", "2026-09-01", "2026-09-30"), 0);
  // Um dia só.
  assert.equal(diasDentroDaJanela("2026-09-15", "2026-09-15", "2026-09-01", "2026-09-30"), 1);
});

const RESUMO: ResumoDoMes = {
  mes: "2026-09",
  de: "2026-09-01",
  ate: "2026-09-30",
  casa: "Ditado Popular",
  linhas: [
    {
      atendente_id: "p1",
      nome: "Cida",
      vinculo: "clt",
      cargo: "Garçonete",
      salario: 1650,
      dias_trabalhados: 22,
      minutos_trabalhados: 10560,
      minutos_noturnos: 4200,
      faltas: 1,
      atrasos: 3,
      minutos_de_atraso: 47,
      dias_de_ferias: 0,
      gorjeta: 812.35,
    },
    {
      atendente_id: "p2",
      nome: "JB",
      vinculo: "diarista",
      cargo: "Bar",
      salario: null,
      dias_trabalhados: 8,
      minutos_trabalhados: 3840,
      minutos_noturnos: 1800,
      faltas: 0,
      atrasos: 0,
      minutos_de_atraso: 0,
      dias_de_ferias: 0,
      gorjeta: 0,
    },
  ],
};

test("o texto do contador traz o que ele pede e diz de quem é o cálculo", () => {
  const texto = comoTexto(RESUMO);

  assert.match(texto, /Ditado Popular — fechamento de setembro\/2026/);
  assert.match(texto, /01\/09\/2026 a 30\/09\/2026/);
  assert.match(texto, /\*Cida\* \(Garçonete\)/);
  assert.match(texto, /22 dia\(s\) · 176h/);
  assert.match(texto, /noturno 70h/);
  assert.match(texto, /1 falta\(s\)/);
  assert.match(texto, /3 atraso\(s\)/);
  assert.match(texto, /gorjeta R\$\s?812,35/);
  // Quem não teve falta nem gorjeta não ganha linha vazia dizendo "0".
  assert.doesNotMatch(texto, /0 falta/);
  assert.match(texto, /permanece com a contabilidade/);
});

test("mês sem movimento não manda planilha vazia disfarçada", () => {
  const texto = comoTexto({ ...RESUMO, linhas: [] });
  assert.match(texto, /Nenhum movimento de equipe registrado/);
});

test("o CSV abre no Excel em português: ponto e vírgula e vírgula decimal", () => {
  const csv = comoCsv(RESUMO);
  const linhas = csv.split("\n");

  assert.equal(linhas[0], "nome;cargo;vinculo;dias_trabalhados;horas_trabalhadas;horas_noturnas;faltas;atrasos;minutos_de_atraso;dias_de_ferias;gorjeta;salario_combinado");
  assert.equal(linhas[1], "Cida;Garçonete;clt;22;176,00;70,00;1;3;47;0;812,35;1650,00");
  // Sem salário anotado sai vazio, não zero — zero seria mentira.
  assert.match(linhas[2]!, /;$/);
});

test("nome com ponto e vírgula não quebra a coluna do CSV", () => {
  const csv = comoCsv({
    ...RESUMO,
    linhas: [{ ...RESUMO.linhas[0]!, nome: 'Ana; a "grande"' }],
  });
  assert.match(csv, /"Ana; a ""grande"""/);
  assert.equal(csv.split("\n")[1]!.split(";").length > 12, true);
});

test("a gorjeta sai da venda pelo percentual de serviço", () => {
  // 10% sobre R$ 12.000 de venda = R$ 1.200 de serviço arrecadado.
  const conta = calcularGorjeta({ base: 12000, percentualServico: 10 });
  assert.equal(conta.arrecadado, 1200);
  assert.equal(conta.repassado, 1200, "sem retenção, tudo vai para a equipe");
  assert.equal(conta.retido, 0);
});

test("o repasse diz quanto do serviço chega no bolso", () => {
  // 10% de R$ 12.000 = R$ 1.200; a casa repassa 80% = R$ 960.
  const conta = calcularGorjeta({ base: 12000, percentualServico: 10, percentualRepasse: 80 });
  assert.equal(conta.arrecadado, 1200);
  assert.equal(conta.repassado, 960);
  assert.equal(conta.retido, 240, "o que fica com a casa aparece, em vez de sumir");
});

test("valor fechado continua funcionando, e o repasse vale nele também", () => {
  assert.deepEqual(calcularGorjeta({ valorFechado: 900 }), { arrecadado: 900, repassado: 900, retido: 0 });
  const comRetencao = calcularGorjeta({ valorFechado: 900, percentualRepasse: 90 });
  assert.equal(comRetencao.repassado, 810);
});

test("centavo do percentual não some: 13% de 1.234,56", () => {
  const conta = calcularGorjeta({ base: 1234.56, percentualServico: 13, percentualRepasse: 70 });
  assert.equal(conta.arrecadado, 160.49);
  assert.equal(conta.repassado, 112.34);
  // Arrecadado tem que fechar com repassado + retido, sempre.
  assert.equal(Math.round((conta.repassado + conta.retido) * 100) / 100, conta.arrecadado);
});

test("percentual impossível é recusado antes de virar dinheiro", () => {
  assert.throws(() => calcularGorjeta({ base: 1000, percentualServico: 1200 }), ErroDoRh);
  assert.throws(() => calcularGorjeta({ base: 1000, percentualServico: -5 }), ErroDoRh);
  assert.throws(() => calcularGorjeta({ base: 1000, percentualServico: 10, percentualRepasse: 150 }), ErroDoRh);
  assert.throws(() => calcularGorjeta({ base: -100, percentualServico: 10 }), ErroDoRh);
});

test("rateio por venda individual: quem vendeu mais leva mais", () => {
  // R$ 600 repassados, vendas de 5.000, 3.000 e 2.000 → 300, 180, 120.
  const cotas = ratear({
    valor: 600,
    criterio: "venda",
    participantes: [
      gente("Ana", { venda: 5000 }),
      gente("Bruno", { venda: 3000 }),
      gente("Cida", { venda: 2000 }),
    ],
  });

  const valor = (n: string) => cotas.find((c) => c.nome === n)!.valor;
  assert.equal(valor("Ana"), 300);
  assert.equal(valor("Bruno"), 180);
  assert.equal(valor("Cida"), 120);
  assert.equal(soma(cotas), 600);
});

test("quem não vendeu nada não leva no critério por venda, e o total continua fechando", () => {
  const cotas = ratear({
    valor: 500,
    criterio: "venda",
    participantes: [gente("Ana", { venda: 4000 }), gente("Apoio", { venda: 0 })],
  });
  assert.equal(cotas.find((c) => c.nome === "Ana")!.valor, 500);
  assert.equal(cotas.find((c) => c.nome === "Apoio")!.valor, 0);
  assert.equal(soma(cotas), 500);
});
