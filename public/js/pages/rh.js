import { del, get, patch, post, postArquivo } from "../api.js";
import { avisar, dataHora, el, etiqueta, indicador, limpar, vazio } from "../ui.js";

/**
 * RH — Fase 1: a ficha de cada pessoa da casa.
 *
 * Duas telas só: a LISTA (quem está na casa, quem tem pendência) e a FICHA
 * (tudo de uma pessoa, com a pasta de documentos). Sem abas: o gestor de bar
 * abre isto para resolver uma coisa — admitir alguém, achar um atestado,
 * desligar — e não para navegar.
 *
 * O que esta tela NÃO faz: folha de pagamento. O salário é anotado porque o
 * gestor precisa saber quanto combinou; imposto e líquido continuam com a
 * contabilidade.
 */

const NOME_DO_VINCULO = {
  clt: "CLT",
  mei: "MEI",
  diarista: "Diarista",
  freelancer: "Freelancer",
  estagio: "Estágio",
  socio: "Sócio",
};

const FORMAS = [
  ["", "Não definido"],
  ["pix", "Pix"],
  ["dinheiro", "Dinheiro"],
  ["transferencia", "Transferência"],
];

export async function rh(raiz, ctx) {
  let dados = null;
  let verDesligados = false;
  let abertaId = null;

  const cabecalho = el("div", { classe: "grade" });
  const corpo = el("div", {});

  raiz.append(el("div", { classe: "pilha" }, [cabecalho, corpo]));
  await recarregar();

  async function recarregar() {
    try {
      dados = await get(`/v1/venues/${ctx.venue}/rh${verDesligados ? "?desligados=1" : ""}`);
    } catch (e) {
      limpar(corpo).append(
        el("div", { classe: "cartao" }, [
          el("h2", { texto: "Não deu para carregar o RH" }),
          el("p", { classe: "muted", texto: e.message }),
        ]),
      );
      return;
    }
    desenharCabecalho();
    if (abertaId) await abrirFicha(abertaId);
    else desenharLista();
  }

  function desenharCabecalho() {
    const r = dados.resumo;
    limpar(cabecalho).append(
      indicador({ rotulo: "Na casa", valor: r.ativos }),
      indicador({ rotulo: "Com pendência", valor: r.com_pendencia, destaque: r.com_pendencia > 0 }),
      indicador({ rotulo: "Documento vencendo", valor: r.documentos_em_alerta, destaque: r.documentos_em_alerta > 0 }),
      indicador({ rotulo: "Desligados", valor: r.desligados }),
    );
  }

  /* ================= A lista ================= */

  function desenharLista() {
    abertaId = null;
    limpar(corpo);

    const lista = el("div", { classe: "tabela" });

    corpo.append(
      el("div", { classe: "cabecalho-secao" }, [
        el("div", {}, [
          el("h2", { texto: "Equipe" }),
          el("p", {
            classe: "muted",
            texto: "Quem trabalha na casa, o que falta de documento e a ficha de cada um.",
          }),
        ]),
        el("div", { classe: "reserva-acoes" }, [
          el("button", {
            classe: "btn btn-peq",
            type: "button",
            texto: verDesligados ? "Esconder desligados" : "Ver desligados",
            onclick: async () => {
              verDesligados = !verDesligados;
              await recarregar();
            },
          }),
          el("button", {
            classe: "btn btn-primario",
            type: "button",
            texto: "Admitir alguém",
            onclick: () => formularioDeAdmissao(),
          }),
        ]),
      ]),
      lista,
    );

    if (dados.pessoas.length === 0) {
      lista.append(
        vazio(
          "Ninguém cadastrado ainda",
          'Clique em "Admitir alguém" para abrir a primeira ficha. Quem você cadastrar aqui já aparece como garçom no cardápio.',
        ),
      );
      return;
    }

    for (const pessoa of dados.pessoas) {
      const f = pessoa.ficha;
      const desligado = Boolean(f?.desligamento);

      lista.append(
        el(
          "div",
          {
            classe: "linha linha-clicavel",
            onclick: () => abrirFicha(pessoa.id),
          },
          [
            el("div", { style: "flex:1;min-width:200px" }, [
              el("strong", { texto: pessoa.apelido ? `${pessoa.nome} (${pessoa.apelido})` : pessoa.nome }),
              el("p", {
                classe: "muted",
                style: "margin:2px 0 0",
                texto: [
                  f?.cargo || pessoa.funcao || "sem função",
                  f?.vinculo ? NOME_DO_VINCULO[f.vinculo] ?? f.vinculo : null,
                  f?.admissao ? `desde ${diaBr(f.admissao)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
              }),
            ]),
            el("div", { classe: "reserva-acoes" }, [
              desligado ? etiqueta(`saiu em ${diaBr(f.desligamento)}`, "") : null,
              pessoa.documentos_alerta
                ? etiqueta(`${pessoa.documentos_alerta} documento(s) vencendo`, "etiqueta-alerta")
                : null,
              !desligado && pessoa.pendencias.length
                ? etiqueta(`falta ${pessoa.pendencias.length}`, "etiqueta-alerta")
                : null,
              !desligado && !pessoa.pendencias.length ? etiqueta("completo", "etiqueta-ok") : null,
            ]),
          ],
        ),
      );
    }
  }

  /* ================= Admissão ================= */

  function formularioDeAdmissao() {
    limpar(corpo);

    const nome = campo("Nome completo", el("input", { classe: "input", type: "text", placeholder: "Como está no documento" }));
    const apelido = campo("Como a equipe chama", el("input", { classe: "input", type: "text", placeholder: "Zé do Bar" }));
    const funcao = campo("Função", el("input", { classe: "input", type: "text", placeholder: "Garçom, bar, cozinha, caixa…" }));
    const vinculo = campo("Vínculo", seletorDeVinculo("clt"));
    const admissao = campo("Data de admissão", el("input", { classe: "input", type: "date", value: hoje() }));
    const telefone = campo("Telefone", el("input", { classe: "input", type: "tel", placeholder: "(65) 99999-0000" }));
    const cpf = campo("CPF", el("input", { classe: "input", type: "text", placeholder: "000.000.000-00" }));

    corpo.append(
      el("div", { classe: "cartao" }, [
        el("div", { classe: "cabecalho-secao" }, [
          el("div", {}, [
            el("h2", { texto: "Admitir alguém" }),
            el("p", {
              classe: "muted",
              texto: "O básico agora; o resto (documentos, pagamento, endereço) você completa na ficha depois.",
            }),
          ]),
          el("button", { classe: "btn btn-peq", type: "button", texto: "Cancelar", onclick: () => desenharLista() }),
        ]),
        el("div", { classe: "grade grade-2" }, [nome.caixa, apelido.caixa, funcao.caixa, vinculo.caixa]),
        el("div", { classe: "grade" }, [admissao.caixa, telefone.caixa, cpf.caixa]),
        el("div", { classe: "reserva-acoes" }, [
          el("button", {
            classe: "btn btn-primario",
            type: "button",
            texto: "Admitir",
            onclick: async (e) => {
              if (!nome.campo.value.trim()) {
                avisar("O nome é obrigatório.", "erro");
                return;
              }
              e.target.disabled = true;
              try {
                const r = await post(`/v1/venues/${ctx.venue}/rh`, {
                  nome: nome.campo.value.trim(),
                  apelido: apelido.campo.value.trim() || null,
                  funcao: funcao.campo.value.trim() || null,
                  ficha: {
                    vinculo: vinculo.campo.value,
                    admissao: admissao.campo.value || null,
                    telefone: telefone.campo.value || null,
                    cpf: cpf.campo.value || null,
                    nome_completo: nome.campo.value.trim(),
                    cargo: funcao.campo.value.trim() || null,
                  },
                });
                avisar("Admitido. Agora complete os documentos.", "ok");
                abertaId = r.atendente_id;
                await recarregar();
              } catch (err) {
                avisar(err.message, "erro");
                e.target.disabled = false;
              }
            },
          }),
        ]),
      ]),
    );
    nome.campo.focus();
  }

  /* ================= A ficha ================= */

  async function abrirFicha(id) {
    abertaId = id;
    limpar(corpo).append(el("p", { classe: "muted", texto: "Abrindo a ficha…" }));

    let visao;
    try {
      visao = await get(`/v1/venues/${ctx.venue}/rh/${id}`);
    } catch (e) {
      limpar(corpo).append(vazio("Não deu para abrir a ficha", e.message));
      return;
    }

    const { pessoa, documentos } = visao;
    const f = pessoa.ficha ?? {};
    const desligado = Boolean(f.desligamento);
    limpar(corpo);

    // ---- Cadastro (o que os outros módulos também enxergam) ----
    const nome = campo("Nome no cadastro", el("input", { classe: "input", type: "text", value: pessoa.nome }));
    const apelido = campo("Apelido", el("input", { classe: "input", type: "text", value: pessoa.apelido ?? "" }));
    const funcao = campo("Função", el("input", { classe: "input", type: "text", value: pessoa.funcao ?? "" }));

    // ---- Ficha ----
    const nomeCompleto = campo("Nome completo (documento)", el("input", { classe: "input", type: "text", value: f.nome_completo ?? "" }));
    const cpf = campo("CPF", el("input", { classe: "input", type: "text", value: formatarCpf(f.cpf) }));
    const rg = campo("RG", el("input", { classe: "input", type: "text", value: f.rg ?? "" }));
    const nascimento = campo("Nascimento", el("input", { classe: "input", type: "date", value: f.nascimento ?? "" }));
    const telefone = campo("Telefone", el("input", { classe: "input", type: "tel", value: f.telefone ?? "" }));
    const endereco = campo("Endereço", el("input", { classe: "input", type: "text", value: f.endereco ?? "" }));

    const vinculo = campo("Vínculo", seletorDeVinculo(f.vinculo ?? "clt"));
    const cargo = campo("Cargo", el("input", { classe: "input", type: "text", value: f.cargo ?? "" }));
    const admissao = campo("Admissão", el("input", { classe: "input", type: "date", value: f.admissao ?? "" }));
    const salario = campo("Salário combinado", el("input", { classe: "input", type: "number", step: "0.01", min: "0", value: f.salario ?? "" }));

    const forma = campo(
      "Como recebe",
      el(
        "select",
        { classe: "select" },
        FORMAS.map(([id, rotulo]) => el("option", { value: id, texto: rotulo, selected: (f.forma_pagamento ?? "") === id })),
      ),
    );
    const pix = campo("Chave Pix", el("input", { classe: "input", type: "text", value: f.chave_pix ?? "" }));
    const banco = campo("Banco / conta", el("input", { classe: "input", type: "text", value: f.banco ?? "" }));

    const emergenciaNome = campo("Emergência — quem avisar", el("input", { classe: "input", type: "text", value: f.emergencia_nome ?? "" }));
    const emergenciaTel = campo("Emergência — telefone", el("input", { classe: "input", type: "tel", value: f.emergencia_telefone ?? "" }));
    const observacoes = campo("Observações", el("textarea", { classe: "input", rows: 3, texto: f.observacoes ?? "" }));

    corpo.append(
      el("div", { classe: "cabecalho-secao" }, [
        el("div", {}, [
          el("h2", { texto: pessoa.apelido ? `${pessoa.nome} (${pessoa.apelido})` : pessoa.nome }),
          el("p", {
            classe: "muted",
            texto: desligado
              ? `Desligado em ${diaBr(f.desligamento)}${f.motivo_desligamento ? ` · ${f.motivo_desligamento}` : ""}`
              : f.admissao
                ? `Na casa desde ${diaBr(f.admissao)}`
                : "Sem data de admissão",
          }),
        ]),
        el("button", { classe: "btn btn-peq", type: "button", texto: "Voltar", onclick: () => desenharLista() }),
      ]),
    );

    // ---- O que falta (admissão guiada) ----
    if (!desligado && pessoa.pendencias.length) {
      corpo.append(
        el("section", { classe: "cartao alerta" }, [
          el("strong", { texto: "Falta para completar a admissão" }),
          el(
            "ul",
            { classe: "muted", style: "padding-left:18px;line-height:1.8;margin:6px 0 0" },
            pessoa.pendencias.map((t) => el("li", { texto: t })),
          ),
        ]),
      );
    }

    corpo.append(
      el("section", { classe: "cartao" }, [
        el("h3", { texto: "Cadastro da casa" }),
        el("p", {
          classe: "muted",
          texto: "É por este nome que a pessoa aparece no cardápio (garçom da mesa) e na pesquisa de satisfação.",
        }),
        el("div", { classe: "grade" }, [nome.caixa, apelido.caixa, funcao.caixa]),
      ]),
      el("section", { classe: "cartao" }, [
        el("h3", { texto: "Dados pessoais" }),
        el("div", { classe: "grade grade-2" }, [nomeCompleto.caixa, cpf.caixa, rg.caixa, nascimento.caixa, telefone.caixa, endereco.caixa]),
      ]),
      el("section", { classe: "cartao" }, [
        el("h3", { texto: "Trabalho" }),
        el("div", { classe: "grade grade-2" }, [vinculo.caixa, cargo.caixa, admissao.caixa, salario.caixa]),
        el("p", {
          classe: "muted",
          texto: "O salário fica anotado para a casa saber o que combinou. Imposto, líquido e folha continuam com a contabilidade.",
        }),
      ]),
      el("section", { classe: "cartao" }, [
        el("h3", { texto: "Pagamento" }),
        el("div", { classe: "grade" }, [forma.caixa, pix.caixa, banco.caixa]),
      ]),
      el("section", { classe: "cartao" }, [
        el("h3", { texto: "Emergência e observações" }),
        el("div", { classe: "grade grade-2" }, [emergenciaNome.caixa, emergenciaTel.caixa]),
        observacoes.caixa,
      ]),
      el("div", { classe: "reserva-acoes" }, [
        el("button", {
          classe: "btn btn-primario",
          type: "button",
          texto: "Salvar ficha",
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              await patch(`/v1/venues/${ctx.venue}/rh/${id}`, {
                cadastro: {
                  nome: nome.campo.value.trim(),
                  apelido: apelido.campo.value.trim() || null,
                  funcao: funcao.campo.value.trim() || null,
                },
                ficha: {
                  nome_completo: nomeCompleto.campo.value,
                  cpf: cpf.campo.value,
                  rg: rg.campo.value,
                  nascimento: nascimento.campo.value || null,
                  telefone: telefone.campo.value,
                  endereco: endereco.campo.value,
                  vinculo: vinculo.campo.value,
                  cargo: cargo.campo.value,
                  admissao: admissao.campo.value || null,
                  salario: salario.campo.value,
                  forma_pagamento: forma.campo.value,
                  chave_pix: pix.campo.value,
                  banco: banco.campo.value,
                  emergencia_nome: emergenciaNome.campo.value,
                  emergencia_telefone: emergenciaTel.campo.value,
                  observacoes: observacoes.campo.value,
                },
              });
              avisar("Ficha salva.", "ok");
              await recarregar();
            } catch (err) {
              avisar(err.message, "erro");
              e.target.disabled = false;
            }
          },
        }),
        desligado
          ? el("button", {
              classe: "btn",
              type: "button",
              texto: "Readmitir",
              onclick: async (e) => {
                e.target.disabled = true;
                try {
                  await post(`/v1/venues/${ctx.venue}/rh/${id}/readmitir`, { admissao: hoje() });
                  avisar("Readmitido. Já volta a aparecer nas listas da casa.", "ok");
                  await recarregar();
                } catch (err) {
                  avisar(err.message, "erro");
                  e.target.disabled = false;
                }
              },
            })
          : el("button", {
              classe: "btn btn-perigo",
              type: "button",
              texto: "Desligar",
              onclick: () => desligarPessoa(id, pessoa.nome),
            }),
      ]),
      secaoDeDocumentos(id, documentos),
    );
  }

  function desligarPessoa(id, nomeDaPessoa) {
    const data = el("input", { classe: "input", type: "date", value: hoje() });
    const motivo = el("input", { classe: "input", type: "text", placeholder: "Pediu demissão, fim de contrato, justa causa…" });

    const cartao = el("section", { classe: "cartao alerta" }, [
      el("h3", { texto: `Desligar ${nomeDaPessoa}` }),
      el("p", {
        classe: "muted",
        texto: "A ficha e os documentos ficam guardados — obrigação trabalhista se guarda por anos. A pessoa só sai das listas do dia a dia.",
      }),
      el("div", { classe: "grade grade-2" }, [
        el("div", { classe: "campo" }, [el("label", { texto: "Data do desligamento" }), data]),
        el("div", { classe: "campo" }, [el("label", { texto: "Motivo" }), motivo]),
      ]),
      el("div", { classe: "reserva-acoes" }, [
        el("button", {
          classe: "btn btn-perigo",
          type: "button",
          texto: "Confirmar desligamento",
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              await post(`/v1/venues/${ctx.venue}/rh/${id}/desligar`, {
                data: data.value || null,
                motivo: motivo.value || null,
              });
              avisar("Desligamento registrado.", "ok");
              await recarregar();
            } catch (err) {
              avisar(err.message, "erro");
              e.target.disabled = false;
            }
          },
        }),
        el("button", { classe: "btn btn-peq", type: "button", texto: "Cancelar", onclick: () => cartao.remove() }),
      ]),
    ]);

    corpo.append(cartao);
    cartao.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* ================= Documentos ================= */

  function secaoDeDocumentos(id, documentos) {
    const lista = el("div", { classe: "tabela" });

    const tipo = el(
      "select",
      { classe: "select" },
      dados.tipos_de_documento.map((t) => el("option", { value: t.id, texto: t.nome })),
    );
    const titulo = el("input", { classe: "input", type: "text", placeholder: "Ex.: Atestado 3 dias" });
    const validade = el("input", { classe: "input", type: "date" });
    const arquivo = el("input", { classe: "input", type: "file", accept: ".pdf,image/png,image/jpeg,image/webp" });

    if (documentos.length === 0) {
      lista.append(vazio("Nenhum documento guardado", "Suba o RG, a carteira, o exame admissional — o que a casa precisa ter em mãos."));
    }

    for (const doc of documentos) {
      const nomeDoTipo = dados.tipos_de_documento.find((t) => t.id === doc.tipo)?.nome ?? doc.tipo;
      const dias = doc.dias_para_vencer;

      lista.append(
        el("div", { classe: "linha" }, [
          el("div", { style: "flex:1;min-width:200px" }, [
            el("strong", { texto: doc.titulo ? `${nomeDoTipo} — ${doc.titulo}` : nomeDoTipo }),
            el("p", {
              classe: "muted",
              style: "margin:2px 0 0",
              texto: `enviado ${dataHora(doc.enviado_em)}${doc.enviado_por ? ` por ${doc.enviado_por}` : ""}`,
            }),
          ]),
          dias === null
            ? null
            : dias < 0
              ? etiqueta(`venceu há ${Math.abs(dias)} dia(s)`, "etiqueta-alerta")
              : dias <= 30
                ? etiqueta(`vence em ${dias} dia(s)`, "etiqueta-alerta")
                : etiqueta(`vale até ${diaBr(doc.validade)}`, "etiqueta-ok"),
          el("div", { classe: "reserva-acoes" }, [
            el("button", {
              classe: "btn btn-peq",
              type: "button",
              texto: "Abrir",
              onclick: async (e) => {
                e.target.disabled = true;
                try {
                  const { url } = await get(`/v1/venues/${ctx.venue}/rh/documentos/${doc.id}/link`);
                  window.open(url, "_blank", "noopener");
                } catch (err) {
                  avisar(err.message, "erro");
                } finally {
                  e.target.disabled = false;
                }
              },
            }),
            el("button", {
              classe: "btn btn-peq btn-perigo",
              type: "button",
              texto: "Apagar",
              onclick: async (e) => {
                if (!confirm("Apagar este documento? Não dá para desfazer.")) return;
                e.target.disabled = true;
                try {
                  await del(`/v1/venues/${ctx.venue}/rh/documentos/${doc.id}`);
                  avisar("Documento apagado.", "ok");
                  await abrirFicha(id);
                } catch (err) {
                  avisar(err.message, "erro");
                  e.target.disabled = false;
                }
              },
            }),
          ]),
        ]),
      );
    }

    return el("section", { classe: "cartao" }, [
      el("h3", { texto: "Documentos" }),
      el("p", {
        classe: "muted",
        texto: "Guardados em cofre: só o dono e o gerente abrem, e o link para ver expira em minutos.",
      }),
      lista,
      el("div", { classe: "grade", style: "margin-top:12px" }, [
        el("div", { classe: "campo" }, [el("label", { texto: "Tipo" }), tipo]),
        el("div", { classe: "campo" }, [el("label", { texto: "Descrição (opcional)" }), titulo]),
        el("div", { classe: "campo" }, [el("label", { texto: "Vence em (opcional)" }), validade]),
        el("div", { classe: "campo" }, [el("label", { texto: "Arquivo (PDF ou foto)" }), arquivo]),
      ]),
      el("div", { classe: "reserva-acoes" }, [
        el("button", {
          classe: "btn btn-primario",
          type: "button",
          texto: "Guardar documento",
          onclick: async (e) => {
            const file = arquivo.files?.[0];
            if (!file) {
              avisar("Escolha o arquivo primeiro.", "erro");
              return;
            }
            e.target.disabled = true;
            try {
              const busca = new URLSearchParams({ tipo: tipo.value });
              if (titulo.value.trim()) busca.set("titulo", titulo.value.trim());
              if (validade.value) busca.set("validade", validade.value);
              await postArquivo(`/v1/venues/${ctx.venue}/rh/${id}/documentos?${busca}`, file);
              avisar("Documento guardado.", "ok");
              await recarregar();
            } catch (err) {
              avisar(err.message, "erro");
              e.target.disabled = false;
            }
          },
        }),
      ]),
    ]);
  }

  /* ================= Miudezas ================= */

  function campo(rotulo, campoEl) {
    return { campo: campoEl, caixa: el("div", { classe: "campo" }, [el("label", { texto: rotulo }), campoEl]) };
  }

  function seletorDeVinculo(atual) {
    return el(
      "select",
      { classe: "select" },
      dados.vinculos.map((v) => el("option", { value: v.id, texto: v.nome, selected: v.id === atual })),
    );
  }
}

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

/** "2026-01-10" vira "10/01/2026" — como a casa lê. */
function diaBr(iso) {
  if (!iso) return "";
  const [ano, mes, dia] = String(iso).slice(0, 10).split("-");
  return `${dia}/${mes}/${ano}`;
}

function formatarCpf(digitos) {
  const d = String(digitos ?? "").replace(/\D/g, "");
  if (d.length !== 11) return d;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}
