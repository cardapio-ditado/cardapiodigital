import assert from "node:assert/strict";
import test from "node:test";
import { ErroDoRh } from "./rh.js";
import {
  conferirPedido,
  diasEntre,
  diasPorFaltas,
  periodoDoPedido,
  periodosAquisitivos,
  somarAnos,
  somarDias,
} from "./rhFerias.js";

test("o período aquisitivo fecha em doze meses e dá doze meses para conceder", () => {
  // Admitida em 15/03/2024. Um ano depois fecha o primeiro período; a casa
  // tem até 14/03/2026 para conceder sem risco de pagar em dobro.
  const p = periodosAquisitivos("2024-03-15", "2026-01-10");

  assert.equal(p[0]!.numero, 1);
  assert.equal(p[0]!.inicio, "2024-03-15");
  assert.equal(p[0]!.fim, "2025-03-14");
  assert.equal(p[0]!.limite, "2026-03-14");
  // 63 dias para o limite: ainda é "dá para conceder com calma".
  assert.equal(p[0]!.situacao, "a_conceder");
  assert.equal(p[0]!.dias_para_vencer, 63);

  // O segundo período ainda está correndo.
  assert.equal(p[1]!.inicio, "2025-03-15");
  assert.equal(p[1]!.fim, "2026-03-14");
  assert.equal(p[1]!.situacao, "em_curso");

  // Não inventa período que ainda nem começou.
  assert.equal(p.length, 2);
});

test("o alerta acende exatamente a 60 dias do limite", () => {
  // Limite em 14/03/2026. A 61 dias ainda é "a conceder"; a 60, acende.
  const longe = periodosAquisitivos("2024-03-15", "2026-01-12");
  assert.equal(longe[0]!.dias_para_vencer, 61);
  assert.equal(longe[0]!.situacao, "a_conceder");

  const perto = periodosAquisitivos("2024-03-15", "2026-01-13");
  assert.equal(perto[0]!.dias_para_vencer, 60);
  assert.equal(perto[0]!.situacao, "a_vencer");
});

test("período que passou do limite aparece como vencido", () => {
  const p = periodosAquisitivos("2023-01-10", "2025-06-01");
  assert.equal(p[0]!.limite, "2025-01-09");
  assert.equal(p[0]!.situacao, "vencido");
  assert.ok(p[0]!.dias_para_vencer < 0);
});

test("quem entrou há pouco ainda não tem período fechado", () => {
  const p = periodosAquisitivos("2026-08-01", "2026-09-11");
  assert.equal(p.length, 1);
  assert.equal(p[0]!.situacao, "em_curso");
  assert.equal(p[0]!.dias_para_vencer > 300, true);
});

test("admissão em 29 de fevereiro não escorrega para março", () => {
  assert.equal(somarAnos("2024-02-29", 1), "2025-02-28");
  assert.equal(somarAnos("2024-02-29", 4), "2028-02-29", "ano bissexto de novo");
  assert.equal(somarDias("2026-01-01", -1), "2025-12-31");
});

test("dias de férias contam as duas pontas", () => {
  assert.equal(diasEntre("2026-10-01", "2026-10-30"), 30);
  assert.equal(diasEntre("2026-10-01", "2026-10-01"), 1);
  assert.equal(diasEntre("2026-12-20", "2027-01-03"), 15, "atravessa o ano");
});

test("falta demais derruba o direito, pela tabela da CLT", () => {
  assert.equal(diasPorFaltas(0), 30);
  assert.equal(diasPorFaltas(5), 30);
  assert.equal(diasPorFaltas(6), 24);
  assert.equal(diasPorFaltas(14), 24);
  assert.equal(diasPorFaltas(15), 18);
  assert.equal(diasPorFaltas(23), 18);
  assert.equal(diasPorFaltas(24), 12);
  assert.equal(diasPorFaltas(32), 12);
  assert.equal(diasPorFaltas(33), 0);
  assert.equal(diasPorFaltas(-4), 30, "número torto não vira direito maior");
});

test("pedido curto demais e saldo estourado são barrados", () => {
  const base = { diasDeDireito: 30, jaTirados: [], hoje: "2026-09-01" };

  const curto = conferirPedido({ ...base, inicio: "2026-10-01", fim: "2026-10-03" });
  assert.ok(curto.erros.some((e) => /menos de 5 dias/.test(e)));

  const estourado = conferirPedido({
    ...base,
    inicio: "2026-10-01",
    fim: "2026-10-30",
    jaTirados: [{ inicio: "2026-05-01", fim: "2026-05-15", dias: 15 }],
  });
  assert.ok(estourado.erros.some((e) => /Saldo insuficiente/.test(e)));

  const abonoDemais = conferirPedido({ ...base, inicio: "2026-10-01", fim: "2026-10-20", abonoDias: 15 });
  assert.ok(abonoDemais.erros.some((e) => /um terço/.test(e)));
});

test("fracionar em mais de três períodos é erro; sem um de 14 dias é aviso", () => {
  const tres = [
    { inicio: "2026-01-01", fim: "2026-01-10", dias: 10 },
    { inicio: "2026-03-01", fim: "2026-03-10", dias: 10 },
    { inicio: "2026-05-01", fim: "2026-05-05", dias: 5 },
  ];
  const quarto = conferirPedido({
    inicio: "2026-10-01",
    fim: "2026-10-05",
    diasDeDireito: 30,
    jaTirados: tres,
    hoje: "2026-09-01",
  });
  assert.ok(quarto.erros.some((e) => /no máximo 3 períodos/.test(e)));

  // Dois pedaços curtos: passa, mas avisa que falta um de 14 dias.
  const semQuatorze = conferirPedido({
    inicio: "2026-10-01",
    fim: "2026-10-10",
    diasDeDireito: 30,
    jaTirados: [{ inicio: "2026-05-01", fim: "2026-05-10", dias: 10 }],
    hoje: "2026-09-01",
  });
  assert.deepEqual(semQuatorze.erros, []);
  assert.ok(semQuatorze.avisos.some((a) => /14 dias/.test(a)));
});

test("aviso de 30 dias e início em fim de semana não travam o lançamento", () => {
  // 2026-09-18 é uma sexta-feira, e o pedido é para daqui a dois dias.
  const r = conferirPedido({
    inicio: "2026-09-18",
    fim: "2026-10-02",
    diasDeDireito: 30,
    jaTirados: [],
    hoje: "2026-09-16",
  });
  assert.deepEqual(r.erros, [], "aviso não pode virar trava: o gestor lançaria fora do sistema");
  assert.ok(r.avisos.some((a) => /30 dias/.test(a)));
  assert.ok(r.avisos.some((a) => /sexta/.test(a)));
});

test("o pedido entra no período aquisitivo mais antigo que já fechou", () => {
  const periodos = periodosAquisitivos("2024-03-15", "2026-01-10");
  assert.equal(periodoDoPedido(periodos), "2024-03-15");

  // Quem ainda não fechou nenhum período cai no que está correndo.
  const novato = periodosAquisitivos("2026-08-01", "2026-09-11");
  assert.equal(periodoDoPedido(novato), "2026-08-01");
});

test("data que não é data não vira período", () => {
  assert.throws(() => periodosAquisitivos("15/03/2024", "2026-01-10"), ErroDoRh);
  assert.throws(() => diasEntre("2026-10-01", ""), ErroDoRh);
});

test("período com as férias concedidas vira GOZADO e sai do alerta", () => {
  // Era o defeito relatado: lançar as férias e o período continuar
  // aparecendo como vencido, cobrando uma coisa que já foi feita.
  const concedidas = [
    {
      periodo_inicio: "2023-01-10",
      inicio: "2025-02-01",
      fim: "2025-03-02",
      dias: 30,
      abono_dias: 0,
      situacao: "aprovado",
    },
  ];
  const p = periodosAquisitivos("2023-01-10", "2025-06-01", concedidas);

  assert.equal(p[0]!.situacao, "gozado");
  assert.equal(p[0]!.dias_gozados, 30);
  assert.equal(p[0]!.dias_restantes, 0);
  assert.equal(p[0]!.gozado_em, "2025-03-02");
  // Sem as férias, o mesmo período estaria vencido.
  assert.equal(periodosAquisitivos("2023-01-10", "2025-06-01")[0]!.situacao, "vencido");
});

test("pedido ainda não aprovado NÃO quita o período", () => {
  const pendente = [
    { periodo_inicio: "2023-01-10", inicio: "2025-02-01", fim: "2025-03-02", dias: 30, situacao: "pedido" },
  ];
  const p = periodosAquisitivos("2023-01-10", "2025-06-01", pendente);
  assert.equal(p[0]!.situacao, "vencido", "só a aprovação tira o período do risco");
  assert.equal(p[0]!.dias_gozados, 0);
});

test("férias tiradas em parcelas só quitam quando fecham os 30 dias", () => {
  const base = { periodo_inicio: "2023-01-10", situacao: "aprovado" };
  const metade = [{ ...base, inicio: "2025-02-01", fim: "2025-02-15", dias: 15, abono_dias: 0 }];

  const parcial = periodosAquisitivos("2023-01-10", "2025-06-01", metade);
  assert.equal(parcial[0]!.situacao, "vencido", "metade tirada não quita");
  assert.equal(parcial[0]!.dias_restantes, 15);

  const inteiro = periodosAquisitivos("2023-01-10", "2025-06-01", [
    ...metade,
    { ...base, inicio: "2025-04-01", fim: "2025-04-10", dias: 10, abono_dias: 5 },
  ]);
  assert.equal(inteiro[0]!.situacao, "gozado", "15 + 10 + 5 de abono fecham os 30");
  assert.equal(inteiro[0]!.dias_gozados, 30);
});

test("o pedido seguinte cai no próximo período, não no que já foi gozado", () => {
  const gozadoOPrimeiro = [
    { periodo_inicio: "2023-01-10", inicio: "2025-02-01", fim: "2025-03-02", dias: 30, situacao: "aprovado" },
  ];
  const periodos = periodosAquisitivos("2023-01-10", "2025-06-01", gozadoOPrimeiro);
  assert.equal(periodoDoPedido(periodos), "2024-01-10", "vai para o segundo período");
});
