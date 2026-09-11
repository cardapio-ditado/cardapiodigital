import { del, get, post } from "../api.js";
import { avisar, dinheiro, el, etiqueta, limpar, vazio } from "../ui.js";

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
};

export function criarFechamento(corpo, ctx) {
  let dados = null;
  let mes = null;
  let resumo = null;
  let previa = null; // { participantes, criterio, valor }

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
    const hoje = new Date().toISOString().slice(0, 10);
    const dia = el("input", { classe: "input", type: "date", value: hoje });
    const turno = el(
      "select",
      { classe: "select" },
      [
        el("option", { value: "", texto: "A noite toda" }),
        ...dados.turnos.filter((t) => t.ativo).map((t) => el("option", { value: t.id, texto: t.nome })),
      ],
    );
    const valor = el("input", { classe: "input", type: "number", step: "0.01", min: "0", placeholder: "0,00" });
    const criterio = el(
      "select",
      { classe: "select" },
      dados.criterios.map((c) => el("option", { value: c.id, texto: c.nome })),
    );
    const observacao = el("input", { classe: "input", type: "text", placeholder: "Observação (opcional)" });

    return el("section", { classe: "cartao" }, [
      el("h2", { texto: "Gorjeta do turno" }),
      el("p", {
        classe: "muted",
        texto:
          "Lance o valor arrecadado e veja a divisão antes de gravar. Entra quem estava escalado e quem bateu ponto — inclusive quem chegou de última hora.",
      }),
      el("div", { classe: "grade" }, [
        el("div", { classe: "campo" }, [el("label", { texto: "Dia" }), dia]),
        el("div", { classe: "campo" }, [el("label", { texto: "Turno" }), turno]),
        el("div", { classe: "campo" }, [el("label", { texto: "Valor arrecadado" }), valor]),
        el("div", { classe: "campo" }, [el("label", { texto: "Como dividir" }), criterio]),
        el("div", { classe: "campo" }, [el("label", { texto: "Observação" }), observacao]),
      ]),
      el("div", { classe: "reserva-acoes" }, [
        el("button", {
          classe: "btn",
          type: "button",
          texto: "Ver a divisão",
          onclick: async (e) => {
            if (!(Number(valor.value) > 0)) {
              avisar("Informe o valor arrecadado.", "erro");
              return;
            }
            e.target.disabled = true;
            try {
              const busca = new URLSearchParams({ dia: dia.value });
              if (turno.value) busca.set("turno", turno.value);
              const r = await get(`/v1/venues/${ctx.venue}/rh/gorjetas?${busca}`);
              previa = {
                participantes: r.participantes,
                criterio: criterio.value,
                valor: Number(valor.value),
                dia: dia.value,
                turnoId: turno.value || null,
                observacao: observacao.value,
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
    const cotas = dividirLocalmente(previa);

    return el("section", { classe: "cartao previa-gorjeta" }, [
      el("div", { classe: "cabecalho-secao" }, [
        el("div", {}, [
          el("h3", { texto: `Divisão de ${dinheiro(previa.valor)}` }),
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

      cotas.length === 0
        ? vazio("Ninguém neste turno", "Monte a escala do dia ou espere as batidas do ponto.")
        : el("div", { classe: "rolagem-x" }, [
            el("table", { classe: "planilha" }, [
              el("thead", {}, [
                el("tr", {}, [
                  el("th", { texto: "Pessoa" }),
                  el("th", { texto: "Função" }),
                  el("th", { classe: "col-num", texto: "Peso" }),
                  el("th", { classe: "col-num", texto: "Horas" }),
                  el("th", { classe: "col-num", texto: "Recebe" }),
                ]),
              ]),
              el(
                "tbody",
                {},
                cotas.map((c) =>
                  el("tr", {}, [
                    el("td", {}, [el("strong", { texto: c.nome })]),
                    el("td", { texto: c.funcao ?? "—" }),
                    el("td", { classe: "col-num", texto: String(c.peso) }),
                    el("td", { classe: "col-num", texto: emHoras(c.minutos) }),
                    el("td", { classe: "col-num", texto: dinheiro(c.valor) }),
                  ]),
                ),
              ),
              el("tfoot", {}, [
                el("tr", {}, [
                  el("td", { colspan: 4, texto: "Total repartido" }),
                  el("td", { classe: "col-num", texto: dinheiro(soma(cotas)) }),
                ]),
              ]),
            ]),
          ]),

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
                valor: previa.valor,
                criterio: previa.criterio,
                observacao: previa.observacao,
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
    const nomeDoTurno = (id) => dados.turnos.find((t) => t.id === id)?.nome ?? "A noite toda";

    return el("section", { classe: "cartao" }, [
      el("div", { classe: "cabecalho-secao" }, [
        el("div", {}, [
          el("h3", { texto: "Gorjetas lançadas" }),
          el("p", { classe: "muted", texto: `${diaBr(dados.de)} a ${diaBr(dados.ate)} · total ${dinheiro(total)}` }),
        ]),
      ]),
      el(
        "div",
        { classe: "tabela" },
        dados.gorjetas.map((g) =>
          el("div", { classe: "linha-tabela" }, [
            el("div", { classe: "linha-principal", style: "flex:1;min-width:240px" }, [
              el("strong", { texto: `${diaBr(g.dia)} · ${nomeDoTurno(g.turno_id)} · ${dinheiro(g.valor)}` }),
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
  const fatia = (p) => (criterio === "peso" ? Math.max(0, p.peso) : criterio === "horas" ? Math.max(0, p.minutos) : 1);
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
