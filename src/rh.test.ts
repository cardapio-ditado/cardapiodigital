import assert from "node:assert/strict";
import test from "node:test";
import {
  ErroDoRh,
  apenasDigitos,
  cpfValido,
  dataOuNulo,
  diasParaVencer,
  estaEmAlerta,
  extensaoDoArquivo,
  montarFicha,
  pendenciasDaFicha,
  type Ficha,
} from "./rh.js";

function ficha(mudancas: Partial<Ficha> = {}): Ficha {
  return {
    atendente_id: "a1",
    nome_completo: "Maria Aparecida Souza",
    cpf: "52998224725",
    rg: null,
    nascimento: null,
    telefone: "65999990000",
    endereco: null,
    vinculo: "clt",
    cargo: "Garçonete",
    admissao: "2026-01-10",
    desligamento: null,
    motivo_desligamento: null,
    salario: 1800,
    forma_pagamento: "pix",
    chave_pix: null,
    banco: null,
    emergencia_nome: null,
    emergencia_telefone: null,
    observacoes: null,
    ...mudancas,
  };
}

test("o CPF só passa quando os dígitos verificadores fecham", () => {
  assert.equal(cpfValido("529.982.247-25"), true);
  assert.equal(cpfValido("52998224725"), true);
  // Um dígito trocado no fim: o erro mais comum de digitação.
  assert.equal(cpfValido("52998224726"), false);
  assert.equal(cpfValido("111.111.111-11"), false);
  assert.equal(cpfValido("1234567890"), false);
  assert.equal(cpfValido(""), false);
  assert.equal(cpfValido(null), false);
  assert.equal(apenasDigitos("(65) 99999-0000"), "65999990000");
});

test("data vazia vira nulo e data torta vira erro que o dono entende", () => {
  assert.equal(dataOuNulo("", "Admissão"), null);
  assert.equal(dataOuNulo(null, "Admissão"), null);
  assert.equal(dataOuNulo("2026-01-10", "Admissão"), "2026-01-10");
  assert.equal(dataOuNulo("2026-01-10T00:00:00Z", "Admissão"), "2026-01-10");
  assert.throws(() => dataOuNulo("10/01/2026", "Admissão"), (e: unknown) => {
    assert.ok(e instanceof ErroDoRh);
    assert.equal(e.status, 400);
    return true;
  });
  assert.throws(() => dataOuNulo("2026-13-45", "Admissão"), ErroDoRh);
});

test("a ficha recusa CPF inválido, salário negativo e vínculo inventado", () => {
  assert.throws(() => montarFicha({ cpf: "52998224726" }), (e: unknown) => {
    assert.ok(e instanceof ErroDoRh);
    assert.match(e.message, /CPF/);
    return true;
  });
  assert.throws(() => montarFicha({ salario: -1 }), ErroDoRh);
  assert.throws(() => montarFicha({ vinculo: "estagiario" }), ErroDoRh);
  assert.throws(() => montarFicha({ forma_pagamento: "boleto" }), ErroDoRh);

  const linha = montarFicha({
    cpf: "529.982.247-25",
    telefone: "(65) 99999-0000",
    salario: "1800",
    vinculo: "diarista",
    forma_pagamento: "pix",
    cargo: "  Bar  ",
    rg: "",
  });
  assert.equal(linha.cpf, "52998224725");
  assert.equal(linha.telefone, "65999990000");
  assert.equal(linha.salario, 1800);
  assert.equal(linha.vinculo, "diarista");
  assert.equal(linha.cargo, "Bar");
  assert.equal(linha.rg, null);
});

test("campo que não veio não vira mudança — salvar telefone não apaga o salário", () => {
  const linha = montarFicha({ telefone: "65999990000" });
  assert.deepEqual(Object.keys(linha), ["telefone"]);
  // Mandar explicitamente vazio, sim, apaga.
  assert.equal(montarFicha({ salario: "" }).salario, null);
});

test("a admissão guiada cobra o que falta, e cobra por tipo de vínculo", () => {
  // CLT com tudo em ordem: nada a cobrar.
  const completa = pendenciasDaFicha(ficha(), [
    { tipo: "rg" },
    { tipo: "cpf" },
    { tipo: "ctps" },
    { tipo: "comprovante_endereco" },
    { tipo: "exame_admissional" },
  ]);
  assert.deepEqual(completa, []);

  // O mesmo cadastro, sem documento nenhum.
  const semDocumento = pendenciasDaFicha(ficha(), []);
  assert.ok(semDocumento.includes("Carteira de trabalho"));
  assert.ok(semDocumento.includes("Exame admissional"));

  // Diarista de fim de semana não tem carteira nem exame — cobrar isso dele
  // só ensina a equipe a ignorar o aviso.
  const diarista = pendenciasDaFicha(ficha({ vinculo: "diarista" }), [{ tipo: "rg" }, { tipo: "cpf" }]);
  assert.deepEqual(diarista, []);

  // Dado que falta na própria ficha também é pendência.
  const semCpf = pendenciasDaFicha(ficha({ cpf: null, admissao: null }), []);
  assert.ok(semCpf.includes("CPF"));
  assert.ok(semCpf.includes("Data de admissão"));

  // Ficha nem começou.
  assert.deepEqual(pendenciasDaFicha(null, []), ["Ficha ainda não preenchida"]);

  // Quem saiu não tem pendência de admissão.
  assert.deepEqual(pendenciasDaFicha(ficha({ desligamento: "2026-08-01", cpf: null }), []), []);
});

test("o alerta de validade pega o que vence em 30 dias e o que já venceu", () => {
  const hoje = new Date("2026-09-10T12:00:00Z");
  assert.equal(diasParaVencer("2026-09-20", hoje), 10);
  assert.equal(diasParaVencer("2026-09-01", hoje), -9);
  assert.equal(diasParaVencer(null, hoje), null);

  assert.equal(estaEmAlerta("2026-09-20", hoje), true);
  assert.equal(estaEmAlerta("2026-09-01", hoje), true, "vencido continua em alerta");
  assert.equal(estaEmAlerta("2026-12-20", hoje), false);
  assert.equal(estaEmAlerta(null, hoje), false, "documento sem validade não vence");
});

test("o balde de documentos aceita PDF e foto, e recusa o resto", () => {
  assert.equal(extensaoDoArquivo("application/pdf"), "pdf");
  assert.equal(extensaoDoArquivo("image/jpeg"), "jpg");
  assert.equal(extensaoDoArquivo("image/png; charset=binary"), "png");
  assert.equal(extensaoDoArquivo("video/mp4"), null);
  assert.equal(extensaoDoArquivo("application/x-msdownload"), null);
  assert.equal(extensaoDoArquivo(null), null);
});
