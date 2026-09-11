import { del, get, post } from "../api.js";
import { avisar, el, etiqueta, limpar, vazio } from "../ui.js";

/**
 * RH — Fase 4: férias.
 *
 * A tela é um relógio, não um formulário. O que o dono precisa ver ao abrir
 * é quem está com o período aquisitivo perto de vencer — porque férias
 * vencida vira pagamento em dobro, e isso costuma aparecer tarde demais.
 *
 * Nenhum valor em reais aqui: datas e dias. Terço, abono e recibo continuam
 * com a contabilidade.
 */

const NOME_DA_SITUACAO = {
  pedido: "Pedido",
  aprovado: "Aprovado",
  recusado: "Recusado",
  cancelado: "Cancelado",
};

const COR_DA_SITUACAO = {
  pedido: "etiqueta-alerta",
  aprovado: "etiqueta-ok",
  recusado: "",
  cancelado: "",
};

const NOME_DO_PERIODO = {
  em_curso: "acumulando",
  a_conceder: "pode conceder",
  a_vencer: "vence em breve",
  vencido: "vencido",
  gozado: "gozado",
};

export function criarFerias(corpo, ctx) {
  let dados = null;
  let abertaId = null;

  return { desenhar, recarregar };

  async function recarregar() {
    try {
      dados = await get(`/v1/venues/${ctx.venue}/rh/ferias`);
    } catch (e) {
      limpar(corpo).append(vazio("Não deu para carregar as férias", e.message));
      return;
    }
    desenhar();
  }

  function desenhar() {
    if (!dados) {
      void recarregar();
      return;
    }
    limpar(corpo);

    const emRisco = dados.pessoas.filter((p) => p.alerta);
    const pedidos = dados.pessoas.flatMap((p) =>
      p.ferias.filter((f) => f.situacao === "pedido").map((f) => ({ pessoa: p, ferias: f })),
    );

    corpo.append(cabecalho(emRisco, pedidos));
    if (emRisco.length) corpo.append(cartaoDeRisco(emRisco));
    if (pedidos.length) corpo.append(cartaoDePedidos(pedidos));

    if (dados.pessoas.length === 0) {
      corpo.append(vazio("Ninguém na equipe ainda", 'Cadastre a equipe na aba "Equipe" para acompanhar as férias.'));
      return;
    }

    corpo.append(tabela());
    if (abertaId) corpo.append(detalhe());
  }

  /* ================= Cabeçalho ================= */

  function cabecalho(emRisco, pedidos) {
    const vencidos = emRisco.filter((p) => p.alerta.vencido).length;
    return el("div", { classe: "cartao" }, [
      el("div", { classe: "cabecalho-secao" }, [
        el("div", {}, [
          el("h2", { texto: "Férias" }),
          el("p", {
            classe: "muted",
            texto:
              "Cada pessoa junta um período de doze meses e a casa tem os doze seguintes para conceder. Passou disso, a lei manda pagar em dobro.",
          }),
        ]),
        el("div", { classe: "reserva-acoes" }, [
          vencidos ? etiqueta(`${vencidos} vencido(s)`, "etiqueta-alerta") : null,
          emRisco.length - vencidos > 0 ? etiqueta(`${emRisco.length - vencidos} vencendo`, "etiqueta-alerta") : null,
          pedidos.length ? etiqueta(`${pedidos.length} pedido(s) para decidir`, "etiqueta-alerta") : null,
          !emRisco.length && !pedidos.length ? etiqueta("tudo em dia", "etiqueta-ok") : null,
        ]),
      ]),
    ]);
  }

  function cartaoDeRisco(emRisco) {
    return el("section", { classe: "cartao alerta" }, [
      el("strong", { texto: "Precisa marcar férias" }),
      el(
        "ul",
        { classe: "muted", style: "padding-left:18px;line-height:1.9;margin:8px 0 0" },
        emRisco.map((p) =>
          el("li", {
            texto: p.alerta.vencido
              ? `${p.nome}: o período venceu em ${diaBr(p.alerta.limite)}. A partir daqui a lei manda pagar em dobro — fale com a contabilidade.`
              : `${p.nome}: vence em ${diaBr(p.alerta.limite)}, daqui a ${p.alerta.dias_para_vencer} dia(s).`,
          }),
        ),
      ),
    ]);
  }

  function cartaoDePedidos(pedidos) {
    return el("section", { classe: "cartao" }, [
      el("h3", { texto: "Pedidos esperando decisão" }),
      el(
        "div",
        { classe: "tabela" },
        pedidos.map(({ pessoa, ferias }) =>
          el("div", { classe: "linha-tabela" }, [
            el("div", { classe: "linha-principal", style: "flex:1;min-width:220px" }, [
              el("strong", { texto: `${pessoa.nome} · ${diaBr(ferias.inicio)} a ${diaBr(ferias.fim)}` }),
              el("span", {
                classe: "muted",
                texto: `${ferias.dias} dia(s)${ferias.abono_dias ? ` + ${ferias.abono_dias} vendido(s)` : ""}${
                  ferias.observacao ? ` · ${ferias.observacao}` : ""
                }`,
              }),
            ]),
            el("button", {
              classe: "btn btn-primario btn-peq",
              type: "button",
              texto: "Aprovar",
              onclick: (e) => decidir(ferias.id, "aprovar", e.target),
            }),
            el("button", {
              classe: "btn btn-peq",
              type: "button",
              texto: "Recusar",
              onclick: (e) => decidir(ferias.id, "recusar", e.target),
            }),
          ]),
        ),
      ),
    ]);
  }

  async function decidir(id, acao, botao) {
    botao.disabled = true;
    try {
      await post(`/v1/venues/${ctx.venue}/rh/ferias/${id}/${acao}`, {});
      avisar(
        acao === "aprovar"
          ? "Férias aprovadas. Os dias já entraram na escala como férias."
          : "Pedido recusado.",
        "ok",
      );
      await recarregar();
    } catch (e) {
      avisar(e.message, "erro");
      botao.disabled = false;
    }
  }

  /* ================= A tabela da equipe ================= */

  function tabela() {
    return el("div", { classe: "rolagem-x" }, [
      el("table", { classe: "planilha" }, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { texto: "Pessoa" }),
            el("th", { texto: "Admissão" }),
            el("th", { texto: "Período mais antigo" }),
            el("th", { texto: "Conceder até" }),
            el("th", { classe: "col-num", texto: "Saldo" }),
            el("th", { texto: "Situação" }),
          ]),
        ]),
        el(
          "tbody",
          {},
          dados.pessoas.map((pessoa) => linha(pessoa)),
        ),
      ]),
    ]);
  }

  function linha(pessoa) {
    const fechado =
      pessoa.periodos.find((p) => p.situacao !== "em_curso" && p.situacao !== "gozado") ?? null;
    const tudoGozado =
      !fechado && pessoa.periodos.some((p) => p.situacao === "gozado");
    const aberta = abertaId === pessoa.atendente_id;

    return el(
      "tr",
      {
        style: `cursor:pointer;${aberta ? "outline:2px solid var(--marca);outline-offset:-2px" : ""}`,
        classe: pessoa.alerta ? "linha-atencao" : "",
        onclick: () => {
          abertaId = aberta ? null : pessoa.atendente_id;
          desenhar();
          if (!aberta) corpo.querySelector(".detalhe-ferias")?.scrollIntoView({ behavior: "smooth", block: "center" });
        },
      },
      [
        el("td", {}, [el("strong", { texto: pessoa.nome })]),
        el("td", { texto: pessoa.admissao ? diaBr(pessoa.admissao) : "—" }),
        el("td", {
          // Sem admissão não há período nenhum: dizer "acumulando" faria
          // parecer que o relógio está correndo quando ele nem começou.
          texto: !pessoa.admissao
            ? "—"
            : fechado
              ? `${diaBr(fechado.inicio)} a ${diaBr(fechado.fim)}`
              : tudoGozado
                ? "tudo gozado"
                : "ainda acumulando",
        }),
        el("td", { texto: fechado ? diaBr(fechado.limite) : "—" }),
        el("td", { classe: "col-num", texto: pessoa.saldo === null ? "—" : `${pessoa.saldo} d` }),
        el("td", {}, [
          !pessoa.admissao
            ? etiqueta("sem data de admissão", "etiqueta-alerta")
            : pessoa.alerta
              ? etiqueta(
                  pessoa.alerta.vencido ? "vencido" : `vence em ${pessoa.alerta.dias_para_vencer} d`,
                  "etiqueta-alerta",
                )
              : fechado
                ? etiqueta(
                    NOME_DO_PERIODO[fechado.situacao] ?? fechado.situacao,
                    fechado.situacao === "gozado" ? "etiqueta-ok" : "",
                  )
                : etiqueta("acumulando", ""),
        ]),
      ],
    );
  }

  /* ================= Ficha de férias da pessoa ================= */

  function detalhe() {
    const pessoa = dados.pessoas.find((p) => p.atendente_id === abertaId);
    if (!pessoa) return el("div", {});

    const inicio = el("input", { classe: "input", type: "date" });
    const fim = el("input", { classe: "input", type: "date" });
    const abono = el("input", { classe: "input", type: "number", min: "0", max: "10", value: "0" });
    const observacao = el("input", { classe: "input", type: "text", placeholder: "Combinado com a equipe" });

    return el("section", { classe: "cartao detalhe-ferias" }, [
      el("div", { classe: "cabecalho-secao" }, [
        el("div", {}, [
          el("h3", { texto: pessoa.nome }),
          el("p", {
            classe: "muted",
            texto: pessoa.admissao
              ? `Admitida em ${diaBr(pessoa.admissao)} · ${pessoa.periodos.length} período(s) aquisitivo(s).`
              : "Sem data de admissão na ficha — preencha na aba Equipe para o período aquisitivo existir.",
          }),
        ]),
        el("button", {
          classe: "btn btn-peq",
          type: "button",
          texto: "Fechar",
          onclick: () => {
            abertaId = null;
            desenhar();
          },
        }),
      ]),

      pessoa.periodos.length
        ? el(
            "div",
            { classe: "tabela" },
            pessoa.periodos
              .slice()
              .reverse()
              .map((p) =>
                el("div", { classe: "linha-tabela" }, [
                  el("div", { classe: "linha-principal", style: "flex:1" }, [
                    el("strong", { texto: `${p.numero}º período · ${diaBr(p.inicio)} a ${diaBr(p.fim)}` }),
                    el("span", {
                      classe: "muted",
                      texto:
                        p.situacao === "gozado"
                          ? `gozado — ${p.dias_gozados} dia(s), último em ${diaBr(p.gozado_em)}`
                          : p.situacao === "em_curso"
                            ? "ainda acumulando"
                            : `conceder até ${diaBr(p.limite)}${p.dias_para_vencer < 0 ? " (já passou)" : ""}${
                                p.dias_gozados ? ` · ${p.dias_gozados} de 30 já tirados` : ""
                              }`,
                    }),
                  ]),
                  etiqueta(
                    NOME_DO_PERIODO[p.situacao] ?? p.situacao,
                    p.situacao === "gozado"
                      ? "etiqueta-ok"
                      : p.situacao === "vencido" || p.situacao === "a_vencer"
                        ? "etiqueta-alerta"
                        : "",
                  ),
                ]),
              ),
          )
        : null,

      pessoa.ferias.length
        ? el("div", {}, [
            el("h4", { texto: "Férias lançadas", style: "margin:18px 0 6px" }),
            el(
              "div",
              { classe: "tabela" },
              pessoa.ferias.map((f) =>
                el("div", { classe: "linha-tabela" }, [
                  el("div", { classe: "linha-principal", style: "flex:1" }, [
                    el("strong", { texto: `${diaBr(f.inicio)} a ${diaBr(f.fim)} · ${f.dias} dia(s)` }),
                    el("span", {
                      classe: "muted",
                      texto: [
                        f.abono_dias ? `${f.abono_dias} dia(s) vendido(s)` : null,
                        f.decidido_por ? `decidido por ${f.decidido_por}` : null,
                        f.observacao,
                      ]
                        .filter(Boolean)
                        .join(" · "),
                    }),
                  ]),
                  etiqueta(NOME_DA_SITUACAO[f.situacao] ?? f.situacao, COR_DA_SITUACAO[f.situacao] ?? ""),
                  f.situacao === "aprovado"
                    ? el("button", {
                        classe: "btn btn-peq",
                        type: "button",
                        texto: "Cancelar",
                        onclick: (e) => decidir(f.id, "cancelar", e.target),
                      })
                    : null,
                  el("button", {
                    classe: "btn btn-peq btn-perigo",
                    type: "button",
                    texto: "Apagar",
                    onclick: async (e) => {
                      if (!confirm("Apagar este lançamento de férias?")) return;
                      e.target.disabled = true;
                      try {
                        await del(`/v1/venues/${ctx.venue}/rh/ferias/${f.id}`);
                        avisar("Lançamento apagado.", "ok");
                        await recarregar();
                      } catch (err) {
                        avisar(err.message, "erro");
                        e.target.disabled = false;
                      }
                    },
                  }),
                ]),
              ),
            ),
          ])
        : null,

      el("h4", { texto: "Marcar férias", style: "margin:18px 0 0" }),
      el("p", {
        classe: "muted",
        texto: "Ao aprovar, os dias entram na escala como férias — ninguém vai cobrar presença de quem está fora.",
      }),
      el("div", { classe: "grade" }, [
        el("div", { classe: "campo" }, [el("label", { texto: "Começa" }), inicio]),
        el("div", { classe: "campo" }, [el("label", { texto: "Termina" }), fim]),
        el("div", { classe: "campo" }, [el("label", { texto: "Dias vendidos (abono)" }), abono]),
        el("div", { classe: "campo" }, [el("label", { texto: "Observação" }), observacao]),
      ]),
      el("div", { classe: "reserva-acoes" }, [
        el("button", {
          classe: "btn btn-primario",
          type: "button",
          texto: "Lançar pedido",
          onclick: async (e) => {
            if (!inicio.value || !fim.value) {
              avisar("Informe o começo e o fim das férias.", "erro");
              return;
            }
            e.target.disabled = true;
            try {
              const r = await post(`/v1/venues/${ctx.venue}/rh/ferias`, {
                atendente_id: pessoa.atendente_id,
                inicio: inicio.value,
                fim: fim.value,
                abono_dias: Number(abono.value) || 0,
                observacao: observacao.value,
              });
              // Aviso não é erro: a lei permite com acordo, e travar faria o
              // gestor lançar por fora.
              avisar(r.avisos.length ? `Pedido lançado. Atenção: ${r.avisos.join(" ")}` : "Pedido lançado.", r.avisos.length ? "info" : "ok");
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
}

function diaBr(iso) {
  if (!iso) return "";
  const [ano, mes, dia] = String(iso).slice(0, 10).split("-");
  return `${dia}/${mes}/${ano}`;
}
