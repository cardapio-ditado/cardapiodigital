import { del, get, post } from "../api.js";
import { avisar, dinheiro, el, etiqueta, indicador, limpar, vazio } from "../ui.js";

/**
 * RH — Fase 5: o fechamento.
 *
 * Duas coisas que acontecem em momentos diferentes, na mesma tela porque são
 * a mesma conversa: o fim do TURNO (rateio da gorjeta) e o fim do MÊS (o
 * resumo que vai para o contador).
 *
 * A gorjeta é o assunto que mais azeda equipe em bar. Aqui a divisão aparece
 * antes de ser gravada, com o critério à vista — ninguém fica achando que
 * levou menos.
 */

const NOME_DO_CRITERIO = {
  igual: "Igual para todos",
  peso: "Por peso da função",
  horas: "Pelas horas trabalhadas",
  venda: "Por venda individual",
};

export function criarFechamento(corpo, ctx) {
  let dados = null;
  let mes = null;
  let resumo = null;
  let previa = null; // { participantes, criterio, arrecadado, repassado, retido }

  /**
   * O que está digitado no formulário.
   *
   * Mora FORA da função que desenha porque a tela se redesenha inteira a cada
   * prévia: sem isto, o gestor via a divisão, trocava o critério, e descobria
   * que a venda que ele tinha digitado havia sumido.
   */
  let form = {
    dia: new Date().toISOString().slice(0, 10),
    turnoId: "",
    modo: "percentual",
    base: "",
    percentual: "10",
    valor: "",
    repasse: "100",
    criterio: "igual",
    observacao: "",
  };

  return { desenhar, recarregar };

  async function recarregar() {
    try {
      dados = await get(`/v1/venues/${ctx.venue}/rh/gorjetas`);
      const busca = mes ? `?mes=${mes}` : "";
      resumo = await get(`/v1/venues/${ctx.venue}/rh/resumo${busca}`);
      mes = resumo.mes;
    } catch (e) {
      limpar(corpo).append(vazio("Não deu para carregar o fechamento", e.message));
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
    corpo.append(cartaoDaGorjeta());
    if (previa) corpo.append(cartaoDaPrevia());
    corpo.append(historico());
    corpo.append(cartaoDoResumo());
  }

  /* ================= Gorjeta do turno ================= */

  function cartaoDaGorjeta() {
    // Cada campo escreve no `form` ao mudar: é o que faz o valor sobreviver
    // ao redesenho da tela.
    const guardar = (campo) => (e) => {
      form[campo] = e.target.value;
    };

    const dia = el("input", { classe: "input", type: "date", value: form.dia, onchange: guardar("dia") });
    const turno = el(
      "select",
      { classe: "select", onchange: guardar("turnoId") },
      [
        el("option", { value: "", texto: "A noite toda", selected: form.turnoId === "" }),
        ...dados.turnos
          .filter((t) => t.ativo)
          .map((t) => el("option", { value: t.id, texto: t.nome, selected: form.turnoId === t.id })),
      ],
    );
    // Duas maneiras de dizer quanto entrou. A de porcentagem é a que a casa
    // usa no dia a dia; a de valor fechado serve para quando alguém já fez a
    // conta no caixa.
    const modo = el(
      "select",
      {
        classe: "select",
        onchange: (e) => {
          form.modo = e.target.value;
          trocarModo();
        },
      },
      [
        el("option", { value: "percentual", texto: "Percentual sobre a venda", selected: form.modo === "percentual" }),
        el("option", { value: "valor", texto: "Valor fechado", selected: form.modo === "valor" }),
      ],
    );
    const base = el("input", {
      classe: "input", type: "number", step: "0.01", min: "0",
      placeholder: "Venda do turno", value: form.base, oninput: guardar("base"),
    });
    const percentual = el("input", {
      classe: "input", type: "number", step: "0.5", min: "0", max: "100",
      value: form.percentual, oninput: guardar("percentual"),
    });
    const valor = el("input", {
      classe: "input", type: "number", step: "0.01", min: "0",
      placeholder: "0,00", value: form.valor, oninput: guardar("valor"),
    });
    const repasse = el("input", {
      classe: "input", type: "number", step: "1", min: "0", max: "100",
      value: form.repasse, oninput: guardar("repasse"),
    });
    const criterio = el(
      "select",
      { classe: "select", onchange: guardar("criterio") },
      dados.criterios.map((c) => el("option", { value: c.id, texto: c.nome, selected: form.criterio === c.id })),
    );
    const observacao = el("input", {
      classe: "input", type: "text", placeholder: "Observação (opcional)",
      value: form.observacao, oninput: guardar("observacao"),
    });

    const campoBase = el("div", { classe: "campo" }, [el("label", { texto: "Venda do turno" }), base]);
    const campoPercentual = el("div", { classe: "campo" }, [el("label", { texto: "% de serviço" }), percentual]);
    const campoValor = el("div", { classe: "campo" }, [el("label", { texto: "Valor arrecadado" }), valor]);

    function trocarModo() {
      const porPercentual = form.modo === "percentual";
      campoBase.hidden = !porPercentual;
      campoPercentual.hidden = !porPercentual;
      campoValor.hidden = porPercentual;
    }
    trocarModo();

    return el("section", { classe: "cartao" }, [
      el("h2", { texto: "Gorjeta do turno" }),
      el("p", {
        classe: "muted",
        texto:
          "O serviço é um percentual sobre a venda, e nem tudo que entra é repassado. Lance a conta inteira e veja a divisão antes de gravar — entra quem estava escalado e quem bateu ponto.",
      }),
      el("div", { classe: "grade" }, [
        el("div", { classe: "campo" }, [el("label", { texto: "Dia" }), dia]),
        el("div", { classe: "campo" }, [el("label", { texto: "Turno" }), turno]),
        el("div", { classe: "campo" }, [el("label", { texto: "Como entrou" }), modo]),
        campoBase,
        campoPercentual,
        campoValor,
        el("div", { classe: "campo" }, [el("label", { texto: "% repassado à equipe" }), repasse]),
        el("div", { classe: "campo" }, [el("label", { texto: "Como dividir" }), criterio]),
        el("div", { classe: "campo" }, [el("label", { texto: "Observação" }), observacao]),
      ]),
      el("div", { classe: "reserva-acoes" }, [
        el("button", {
          classe: "btn",
          type: "button",
          texto: "Ver a divisão",
          onclick: async (e) => {
            const porPercentual = form.modo === "percentual";
            if (porPercentual && !(Number(form.base) > 0)) {
              avisar("Informe a venda do turno.", "erro");
              return;
            }
            if (!porPercentual && !(Number(form.valor) > 0)) {
              avisar("Informe o valor arrecadado.", "erro");
              return;
            }
            e.target.disabled = true;
            try {
              const busca = new URLSearchParams({ dia: form.dia });
              if (form.turnoId) busca.set("turno", form.turnoId);
              const r = await get(`/v1/venues/${ctx.venue}/rh/gorjetas?${busca}`);
              const conta = contaDaGorjeta({
                base: porPercentual ? Number(form.base) : null,
                percentualServico: porPercentual ? Number(form.percentual) : null,
                valorFechado: porPercentual ? null : Number(form.valor),
                percentualRepasse: Number(form.repasse),
              });
              // Mantém a venda já digitada de quem continua no turno.
              const vendaAnterior = new Map((previa?.participantes ?? []).map((p) => [p.atendente_id, p.venda]));
              previa = {
                participantes: r.participantes.map((p) => ({ ...p, venda: vendaAnterior.get(p.atendente_id) ?? 0 })),
                criterio: form.criterio,
                dia: form.dia,
                turnoId: form.turnoId || null,
                observacao: form.observacao,
                baseVenda: porPercentual ? Number(form.base) : null,
                percentualServico: porPercentual ? Number(form.percentual) : null,
                percentualRepasse: Number(form.repasse),
                valorFechado: porPercentual ? null : Number(form.valor),
                ...conta,
              };
              desenhar();
              corpo.querySelector(".previa-gorjeta")?.scrollIntoView({ behavior: "smooth", block: "center" });
            } catch (err) {
              avisar(err.message, "erro");
            } finally {
              e.target.disabled = false;
            }
          },
        }),
      ]),
      dados.pesos.length
        ? el("p", {
            classe: "muted",
            texto: `Pesos por função: ${dados.pesos.map((p) => `${p.funcao} ${p.peso}`).join(" · ")}. Quem não estiver na lista pesa 1.`,
          })
        : el("p", { classe: "muted", texto: "Nenhum peso cadastrado: no critério por peso, todo mundo pesa igual." }),
      painelDePesos(),
    ]);
  }

  /** A divisão na tela ANTES de gravar — é o que evita discussão depois. */
  function cartaoDaPrevia() {
    const soma = (lista) => lista.reduce((t, c) => t + c.valor, 0);
    // Divide o REPASSADO: o que fica com a casa não entra no bolo de ninguém.
    const cotas = dividirLocalmente({ ...previa, valor: previa.repassado });
    const porVenda = previa.criterio === "venda";

    return el("section", { classe: "cartao previa-gorjeta" }, [
      el("div", { classe: "cabecalho-secao" }, [
        el("div", {}, [
          el("h3", { texto: `Divisão de ${dinheiro(previa.repassado)}` }),
          el("p", {
            classe: "muted",
            texto: `${NOME_DO_CRITERIO[previa.criterio]} · ${cotas.length} pessoa(s) no turno.`,
          }),
        ]),
        el("button", {
          classe: "btn btn-peq",
          type: "button",
          texto: "Cancelar",
          onclick: () => {
            previa = null;
            desenhar();
          },
        }),
      ]),

      // A conta inteira à vista: é o que responde "cadê o resto?" sem
      // ninguém precisar perguntar.
      el("div", { classe: "grade" }, [
        indicador({
          rotulo: "Serviço arrecadado",
          valor: dinheiro(previa.arrecadado),
          nota: previa.percentualServico ? `${previa.percentualServico}% sobre ${dinheiro(previa.baseVenda)}` : "valor lançado",
        }),
        indicador({
          rotulo: "Repassado à equipe",
          valor: dinheiro(previa.repassado),
          nota: `${previa.percentualRepasse}% do arrecadado`,
        }),
        indicador({
          rotulo: "Fica com a casa",
          valor: dinheiro(previa.retido),
          nota: previa.retido > 0 ? "taxa de cartão, quebra, o que a casa combinar" : "nada retido",
        }),
      ]),

      porVenda
        ? el("p", {
            classe: "muted",
            texto: "Digite a venda de cada um: a divisão acompanha o que você digitar, na hora.",
          })
        : null,

      cotas.length === 0
        ? vazio("Ninguém neste turno", "Monte a escala do dia ou espere as batidas do ponto.")
        : tabelaDaPrevia(cotas, porVenda, soma),
      el("div", { classe: "reserva-acoes" }, [
        el("button", {
          classe: "btn btn-primario",
          type: "button",
          texto: "Confirmar e gravar",
          disabled: cotas.length === 0,
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              await post(`/v1/venues/${ctx.venue}/rh/gorjetas`, {
                dia: previa.dia,
                turno_id: previa.turnoId,
                valor: previa.valorFechado,
                base_venda: previa.baseVenda,
                percentual_servico: previa.percentualServico,
                percentual_repasse: previa.percentualRepasse,
                criterio: previa.criterio,
                observacao: previa.observacao,
                // A venda individual só existe aqui na tela: o servidor não
                // tem de onde adivinhar quanto cada um vendeu.
                participantes: previa.criterio === "venda" ? previa.participantes : undefined,
              });
              avisar("Gorjeta registrada e dividida.", "ok");
              previa = null;
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

  /**
   * A tabela da prévia.
   *
   * Quando a divisão é por venda individual, cada linha tem um campo. Digitar
   * atualiza só a coluna "Recebe" e o total — redesenhar a tela inteira a
   * cada tecla tirava o cursor do lugar e piscava a página.
   */
  function tabelaDaPrevia(cotas, porVenda, soma) {
    const celulas = new Map();
    const totalCelula = el("td", { classe: "col-num", texto: dinheiro(soma(cotas)) });

    function recalcular() {
      const novas = dividirLocalmente({ ...previa, valor: previa.repassado });
      for (const c of novas) {
        const celula = celulas.get(c.atendente_id);
        if (celula) celula.textContent = dinheiro(c.valor);
      }
      totalCelula.textContent = dinheiro(soma(novas));
    }

    return el("div", { classe: "rolagem-x" }, [
      el("table", { classe: "planilha" }, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { texto: "Pessoa" }),
            el("th", { texto: "Função" }),
            el("th", { classe: "col-num", texto: porVenda ? "Venda dele" : "Peso" }),
            el("th", { classe: "col-num", texto: "Horas" }),
            el("th", { classe: "col-num", texto: "Recebe" }),
          ]),
        ]),
        el(
          "tbody",
          {},
          cotas.map((c) => {
            const recebe = el("td", { classe: "col-num", texto: dinheiro(c.valor) });
            celulas.set(c.atendente_id, recebe);

            return el("tr", {}, [
              el("td", {}, [el("strong", { texto: c.nome })]),
              el("td", { texto: c.funcao ?? "—" }),
              el("td", { classe: "col-num" }, [
                porVenda
                  ? el("input", {
                      classe: "input",
                      type: "number",
                      step: "0.01",
                      min: "0",
                      value: String(c.venda ?? 0),
                      style: "max-width:130px;text-align:right",
                      oninput: (e) => {
                        const pessoa = previa.participantes.find((p) => p.atendente_id === c.atendente_id);
                        if (pessoa) pessoa.venda = Number(e.target.value) || 0;
                        recalcular();
                      },
                    })
                  : document.createTextNode(String(c.peso)),
              ]),
              el("td", { classe: "col-num", texto: emHoras(c.minutos) }),
              recebe,
            ]);
          }),
        ),
        el("tfoot", {}, [el("tr", {}, [el("td", { colspan: 4, texto: "Total repartido" }), totalCelula])]),
      ]),
    ]);
  }

  function painelDePesos() {
    const funcao = el("input", { classe: "input", type: "text", placeholder: "Garçom" });
    const peso = el("input", { classe: "input", type: "number", step: "0.5", min: "0", value: "2" });

    return el("details", { style: "margin-top:10px" }, [
      el("summary", { classe: "muted", style: "cursor:pointer", texto: "Ajustar peso por função" }),
      el("p", {
        classe: "muted",
        texto: '"Garçom pesa mais que apoio" é regra de casa, não lei. Só vale no critério por peso.',
      }),
      dados.pesos.length
        ? el(
            "div",
            { classe: "tabela" },
            dados.pesos.map((p) =>
              el("div", { classe: "linha-tabela" }, [
                el("div", { classe: "linha-principal", style: "flex:1" }, [
                  el("strong", { texto: p.funcao }),
                  el("span", { classe: "muted", texto: `peso ${p.peso}` }),
                ]),
                el("button", {
                  classe: "btn btn-peq btn-perigo",
                  type: "button",
                  texto: "Apagar",
                  onclick: async (e) => {
                    e.target.disabled = true;
                    try {
                      await del(`/v1/venues/${ctx.venue}/rh/pesos/${p.id}`);
                      await recarregar();
                    } catch (err) {
                      avisar(err.message, "erro");
                      e.target.disabled = false;
                    }
                  },
                }),
              ]),
            ),
          )
        : null,
      el("div", { classe: "grade" }, [
        el("div", { classe: "campo" }, [el("label", { texto: "Função" }), funcao]),
        el("div", { classe: "campo" }, [el("label", { texto: "Peso" }), peso]),
      ]),
      el("div", { classe: "reserva-acoes" }, [
        el("button", {
          classe: "btn btn-peq",
          type: "button",
          texto: "Salvar peso",
          onclick: async (e) => {
            if (!funcao.value.trim()) {
              avisar("Diga a função.", "erro");
              return;
            }
            e.target.disabled = true;
            try {
              await post(`/v1/venues/${ctx.venue}/rh/pesos`, {
                funcao: funcao.value.trim(),
                peso: Number(peso.value),
              });
              avisar("Peso salvo.", "ok");
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

  /* ================= Histórico ================= */

  function historico() {
    if (dados.gorjetas.length === 0) {
      return el("section", { classe: "cartao" }, [
        el("h3", { texto: "Gorjetas do mês" }),
        vazio("Nenhum fechamento ainda", "O primeiro lançamento aparece aqui."),
      ]);
    }

    const total = dados.gorjetas.reduce((t, g) => t + g.valor, 0);
    const totalRepassado = dados.gorjetas.reduce((t, g) => t + (g.valor_repassado ?? g.valor), 0);
    const nomeDoTurno = (id) => dados.turnos.find((t) => t.id === id)?.nome ?? "A noite toda";

    return el("section", { classe: "cartao" }, [
      el("div", { classe: "cabecalho-secao" }, [
        el("div", {}, [
          el("h3", { texto: "Gorjetas lançadas" }),
          el("p", {
            classe: "muted",
            texto: `${diaBr(dados.de)} a ${diaBr(dados.ate)} · arrecadado ${dinheiro(total)} · repassado ${dinheiro(totalRepassado)}`,
          }),
        ]),
      ]),
      el(
        "div",
        { classe: "tabela" },
        dados.gorjetas.map((g) =>
          el("div", { classe: "linha-tabela" }, [
            el("div", { classe: "linha-principal", style: "flex:1;min-width:240px" }, [
              el("strong", {
                texto: `${diaBr(g.dia)} · ${nomeDoTurno(g.turno_id)} · ${dinheiro(g.valor_repassado ?? g.valor)}`,
              }),
              g.percentual_servico
                ? el("span", {
                    classe: "muted",
                    texto: `${g.percentual_servico}% sobre ${dinheiro(g.base_venda)} = ${dinheiro(g.valor)}; repasse de ${g.percentual_repasse}%`,
                  })
                : null,
              el("span", {
                classe: "muted",
                texto: g.cotas.map((c) => `${c.nome} ${dinheiro(c.valor)}`).join(" · ") || "sem cotas",
              }),
              g.observacao ? el("span", { classe: "muted", texto: g.observacao }) : null,
            ]),
            etiqueta(NOME_DO_CRITERIO[g.criterio] ?? g.criterio, ""),
            el("button", {
              classe: "btn btn-peq btn-perigo",
              type: "button",
              texto: "Apagar",
              onclick: async (e) => {
                if (!confirm("Apagar este fechamento? As cotas somem junto.")) return;
                e.target.disabled = true;
                try {
                  await del(`/v1/venues/${ctx.venue}/rh/gorjetas/${g.id}`);
                  avisar("Fechamento apagado.", "ok");
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
    ]);
  }

  /* ================= Resumo do mês ================= */

  function cartaoDoResumo() {
    const seletor = el("input", { classe: "input", type: "month", value: mes, style: "max-width:200px" });

    return el("section", { classe: "cartao" }, [
      el("div", { classe: "cabecalho-secao" }, [
        el("div", {}, [
          el("h2", { texto: "Resumo do mês para a contabilidade" }),
          el("p", {
            classe: "muted",
            texto:
              "Dias, horas, noturno, faltas, atrasos, férias e gorjeta de cada um. São os números de fato; salário, encargos e adicionais continuam com quem fecha a folha.",
          }),
        ]),
        el("div", { classe: "reserva-acoes" }, [
          seletor,
          el("button", {
            classe: "btn btn-peq",
            type: "button",
            texto: "Ver mês",
            onclick: async () => {
              mes = seletor.value;
              await recarregar();
            },
          }),
        ]),
      ]),

      resumo.linhas.length === 0
        ? vazio("Nada neste mês", "Sem ponto, escala ou gorjeta lançados no período.")
        : el("div", { classe: "rolagem-x" }, [
            el("table", { classe: "planilha" }, [
              el("thead", {}, [
                el("tr", {}, [
                  el("th", { texto: "Pessoa" }),
                  el("th", { classe: "col-num", texto: "Dias" }),
                  el("th", { classe: "col-num", texto: "Horas" }),
                  el("th", { classe: "col-num", texto: "Noturno" }),
                  el("th", { classe: "col-num", texto: "Faltas" }),
                  el("th", { classe: "col-num", texto: "Atrasos" }),
                  el("th", { classe: "col-num", texto: "Férias" }),
                  el("th", { classe: "col-num", texto: "Gorjeta" }),
                ]),
              ]),
              el(
                "tbody",
                {},
                resumo.linhas.map((l) =>
                  el("tr", { classe: l.faltas > 0 ? "linha-atencao" : "" }, [
                    el("td", {}, [
                      el("strong", { texto: l.nome }),
                      l.cargo ? el("small", { classe: "muted", texto: l.cargo }) : null,
                    ]),
                    el("td", { classe: "col-num", texto: String(l.dias_trabalhados) }),
                    el("td", { classe: "col-num", texto: emHoras(l.minutos_trabalhados) }),
                    el("td", { classe: "col-num", texto: l.minutos_noturnos ? emHoras(l.minutos_noturnos) : "—" }),
                    el("td", { classe: "col-num", texto: l.faltas ? String(l.faltas) : "—" }),
                    el("td", { classe: "col-num", texto: l.atrasos ? `${l.atrasos} (${emHoras(l.minutos_de_atraso)})` : "—" }),
                    el("td", { classe: "col-num", texto: l.dias_de_ferias ? `${l.dias_de_ferias} d` : "—" }),
                    el("td", { classe: "col-num", texto: l.gorjeta ? dinheiro(l.gorjeta) : "—" }),
                  ]),
                ),
              ),
            ]),
          ]),

      el("div", { classe: "reserva-acoes" }, [
        el("button", {
          classe: "btn btn-primario",
          type: "button",
          texto: "Copiar texto para o contador",
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(resumo.texto);
              avisar("Texto copiado. Cole no WhatsApp da contabilidade.", "ok");
            } catch {
              avisar("Não deu para copiar. Selecione o texto abaixo à mão.", "erro");
            }
          },
        }),
        el("button", {
          classe: "btn",
          type: "button",
          texto: "Copiar planilha (CSV)",
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(resumo.csv);
              avisar("Planilha copiada. Cole num arquivo .csv e abra no Excel.", "ok");
            } catch {
              avisar("Não deu para copiar.", "erro");
            }
          },
        }),
      ]),

      el("details", { style: "margin-top:10px" }, [
        el("summary", { classe: "muted", style: "cursor:pointer", texto: "Ver o texto que vai para o contador" }),
        el("pre", {
          style: "white-space:pre-wrap;font-size:0.85rem;background:var(--fundo);padding:12px;border-radius:10px;overflow-x:auto",
          texto: resumo.texto,
        }),
      ]),
    ]);
  }
}

/* ================= Miudezas ================= */

/**
 * A mesma divisão que o servidor faz, só para a prévia.
 *
 * Duplicar conta é ruim; mostrar ao gestor um número diferente do que será
 * gravado é pior. O servidor continua sendo a fonte da verdade: ele refaz a
 * conta ao gravar, e é a dele que vai para o banco.
 */
function dividirLocalmente({ participantes, criterio, valor }) {
  const centavos = Math.round(valor * 100);
  const fatia = (p) =>
    criterio === "peso"
      ? Math.max(0, p.peso)
      : criterio === "horas"
        ? Math.max(0, p.minutos)
        : criterio === "venda"
          ? Math.max(0, Number(p.venda) || 0)
          : 1;
  const soma = participantes.reduce((t, p) => t + fatia(p), 0);
  if (soma <= 0) return participantes.map((p) => ({ ...p, valor: 0 }));

  const exatos = participantes.map((p) => ({ p, exato: (centavos * fatia(p)) / soma }));
  const cotas = exatos.map((e) => ({ ...e, centavos: Math.floor(e.exato) }));
  let sobra = centavos - cotas.reduce((t, c) => t + c.centavos, 0);

  const fila = [...cotas]
    .filter((c) => c.exato > 0)
    .sort((a, b) => {
      const fa = a.exato - Math.floor(a.exato);
      const fb = b.exato - Math.floor(b.exato);
      if (fb !== fa) return fb - fa;
      return a.p.nome.localeCompare(b.p.nome, "pt-BR");
    });
  for (let i = 0; sobra > 0 && fila.length > 0; i += 1, sobra -= 1) fila[i % fila.length].centavos += 1;

  return cotas.map((c) => ({ ...c.p, valor: c.centavos / 100 }));
}

/**
 * A mesma conta do servidor: venda × serviço = arrecadado; × repasse = bolso.
 *
 * Existe aqui só para a prévia responder na hora, sem ida e volta. O servidor
 * refaz tudo ao gravar, e é a conta dele que vai para o banco.
 */
function contaDaGorjeta({ base, percentualServico, valorFechado, percentualRepasse }) {
  const centavos = (n) => Math.round((Number(n) || 0) * 100);
  const arrecadadoCentavos =
    valorFechado !== null && valorFechado !== undefined && valorFechado !== ""
      ? centavos(valorFechado)
      : Math.round(centavos(base) * ((Number(percentualServico) || 0) / 100));
  const repasse = percentualRepasse === null || percentualRepasse === undefined || percentualRepasse === "" ? 100 : Number(percentualRepasse);
  const repassadoCentavos = Math.round(arrecadadoCentavos * (repasse / 100));
  return {
    arrecadado: arrecadadoCentavos / 100,
    repassado: repassadoCentavos / 100,
    retido: (arrecadadoCentavos - repassadoCentavos) / 100,
  };
}

function diaBr(iso) {
  if (!iso) return "";
  const [ano, mes, dia] = String(iso).slice(0, 10).split("-");
  return `${dia}/${mes}/${ano}`;
}

function emHoras(minutos) {
  const m = Number(minutos) || 0;
  const h = Math.floor(Math.abs(m) / 60);
  const resto = Math.abs(m) % 60;
  return resto === 0 ? `${h}h` : `${h}h${String(resto).padStart(2, "0")}`;
}
