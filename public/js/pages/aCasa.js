import { get } from "../api.js";
import { el, icone, limpar, vazio } from "../ui.js";

/**
 * A CASA AO VIVO — a planta do bar, com o que está acontecendo em cada setor.
 *
 * O painel conta a verdade repartida em dez telas. Quem abre de manhã quer
 * uma coisa só: "o que andou acontecendo na minha casa?". Aqui a casa vira
 * planta vista de cima, e cada fato aparece NO LUGAR onde ele acontece — a
 * mercadoria na doca, a reserva na porta, o ponto no escritório.
 *
 * O bonequinho que atravessa a planta não é enfeite: ele diz DE ONDE PARA
 * ONDE a coisa foi, e é isso que faz o dono perceber num relance que a doca
 * está parada há três dias sem ler número nenhum.
 *
 * Três cuidados que a tela toma:
 *   · na primeira carga ninguém anda. Vinte e quatro horas de fatos viraria
 *     um formigueiro, e o que interessa é o estado, não a chegada.
 *   · com a aba escondida a tela para de perguntar. Não faz sentido o
 *     celular no bolso buscar movimento a cada quinze segundos.
 *   · quem pediu menos animação no sistema não vê bonequinho andando; o
 *     setor pisca e pronto.
 */

const QUANTO_ESPERA_MS = 15_000;
/** Depois disto, o setor deixa de ser "vivo" e vira "quieto". */
const MINUTOS_ATE_ESFRIAR = 45;
/** Quantos bonequinhos podem estar na planta ao mesmo tempo. */
const BONECOS_AO_MESMO_TEMPO = 4;

const ICONE_DO_SETOR = {
  doca: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10",
  cozinha: "M5 11h14v6a3 3 0 01-3 3H8a3 3 0 01-3-3v-6zM3 11h18M8 8c0-2 1-2.5 1-4M12 8c0-2 1-2.5 1-4M16 8c0-2 1-2.5 1-4",
  escritorio: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z",
  salao: "M3 9h18l-2 3H5L3 9zM3 9l2-4h14l2 4M8 12v8M16 12v8M8 20h8",
  porta: "M4 21h16M6 3h9v18H6zM11.5 12h.01M15 7h4v14h-4",
  operacao: "M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11",
  opiniao: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 6.91-1.01L12 2z",
};

/** De onde o bonequinho sai: a porta da rua, no canto de baixo. */
const ENTRADA = { x: 4, y: 95 };

const menosAnimacao = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export async function aCasa(raiz, ctx) {
  let dados = null;
  let vistos = new Set();
  let pausado = false;
  let relogio = null;
  const fila = [];
  let andando = 0;

  const planta = el("div", { classe: "planta" });
  const lista = el("div", {});
  const cabecalho = el("div", { classe: "cartao" });

  limpar(raiz).append(el("div", { classe: "pilha" }, [cabecalho, planta, lista]));

  // A tela morre quando o usuário sai dela: sem isto o relógio continua
  // batendo em segundo plano e a casa inteira é buscada para ninguém.
  ctx.aoSair(() => {
    clearInterval(relogio);
    document.removeEventListener("visibilitychange", aoTrocarDeAba);
  });
  document.addEventListener("visibilitychange", aoTrocarDeAba);

  await buscar({ primeira: true });
  relogio = setInterval(() => {
    if (!pausado && !document.hidden) void buscar({ primeira: false });
  }, QUANTO_ESPERA_MS);

  function aoTrocarDeAba() {
    // Ao voltar para a aba, pergunta na hora: quem volta quer ver o agora,
    // não esperar mais quinze segundos.
    if (!document.hidden && !pausado) void buscar({ primeira: false });
  }

  /* ================= Dados ================= */

  async function buscar({ primeira }) {
    const desde = !primeira && dados ? `?desde=${encodeURIComponent(dados.agora)}` : "";
    let novo;
    try {
      novo = await get(`/v1/venues/${ctx.venue}/a-casa${desde}`);
    } catch (e) {
      if (primeira) limpar(raiz).append(vazio("Não deu para abrir a casa", e.message));
      return;
    }

    if (primeira) {
      dados = novo;
      // A primeira carga é estado, não chegada: ninguém anda.
      for (const f of novo.fatos) vistos.add(f.id);
      desenhar();
      return;
    }

    const novidades = novo.fatos.filter((f) => !vistos.has(f.id));
    for (const f of novidades) vistos.add(f.id);
    // A janela incremental só traz o que é novo; o resto continua valendo.
    dados = {
      ...novo,
      fatos: [...novidades, ...dados.fatos].slice(0, 60),
      setores: juntarSetores(dados.setores, novo.setores),
    };
    desenhar();
    for (const f of novidades.slice().reverse()) enfileirar(f);
  }

  /**
   * O setor novo manda no que ele sabe, mas não apaga o que já havia.
   *
   * A busca incremental só olha os últimos quinze segundos: se ela mandasse
   * sozinha, todo setor viraria "nada ainda" a cada volta do relógio.
   */
  function juntarSetores(antigos, novos) {
    return novos.map((n) => {
      const antigo = antigos.find((a) => a.id === n.id);
      if (!antigo || n.quantos > 0) return { ...n, quantos: n.quantos + (antigo?.quantos ?? 0) };
      return { ...n, quantos: antigo.quantos, ultimo: antigo.ultimo, minutos_parado: antigo.minutos_parado };
    });
  }

  /* ================= Desenho ================= */

  function desenhar() {
    desenharCabecalho();
    desenharPlanta();
    desenharLista();
  }

  function desenharCabecalho() {
    const atencao = dados.fatos.filter((f) => f.atencao).length;
    limpar(cabecalho).append(
      el("div", { classe: "cabecalho-secao" }, [
        el("div", {}, [
          el("h2", { texto: "A casa agora" }),
          el("p", {
            classe: "muted",
            texto: dados.fatos.length
              ? `${dados.fatos.length} coisa(s) nas últimas 24 horas${atencao ? ` · ${atencao} pedindo atenção` : ""}`
              : "Nada aconteceu nas últimas 24 horas.",
          }),
        ]),
        el("div", { classe: "reserva-acoes" }, [
          el("span", { classe: `casa-pulso ${pausado ? "casa-pulso-parado" : ""}`.trim() }),
          el("span", { classe: "muted", texto: pausado ? "parado" : "ao vivo" }),
          el("button", {
            classe: "btn btn-peq",
            type: "button",
            texto: pausado ? "Retomar" : "Pausar",
            onclick: () => {
              pausado = !pausado;
              if (!pausado) void buscar({ primeira: false });
              desenharCabecalho();
            },
          }),
        ]),
      ]),
    );
  }

  function desenharPlanta() {
    limpar(planta);
    planta.append(el("span", { classe: "planta-rotulo", texto: "entrada" , style: `left:${ENTRADA.x}%;top:${ENTRADA.y}%`}));
    for (const setor of dados.setores) planta.append(cartaoDoSetor(setor));
  }

  function cartaoDoSetor(setor) {
    const vivo = setor.minutos_parado !== null && setor.minutos_parado <= MINUTOS_ATE_ESFRIAR;
    const precisa = setor.ultimo?.atencao === true;
    const classe = !setor.contratado
      ? "setor setor-apagado"
      : precisa
        ? "setor setor-atencao"
        : vivo
          ? "setor setor-vivo"
          : "setor";

    return el("div", {
      classe,
      "data-setor": setor.id,
      style: `left:${setor.x}%;top:${setor.y}%`,
      title: setor.contratado ? setor.legenda : `${setor.legenda} — a casa não contratou este módulo`,
    }, [
      el("div", { classe: "setor-topo" }, [
        icone(ICONE_DO_SETOR[setor.id] ?? ICONE_DO_SETOR.salao, 18),
        el("strong", { texto: setor.nome }),
        setor.contratado && setor.quantos > 0
          ? el("span", { classe: "setor-conta", texto: String(setor.quantos) })
          : null,
      ]),
      !setor.contratado
        ? el("span", { classe: "setor-linha muted", texto: "não contratado" })
        : el("span", { classe: "setor-linha", texto: setor.ultimo ? setor.ultimo.titulo : "sem movimento" }),
      setor.contratado
        ? el("span", { classe: "setor-quando", texto: comoFazTempo(setor.minutos_parado) })
        : null,
    ]);
  }

  function desenharLista() {
    limpar(lista);
    if (dados.fatos.length === 0) {
      lista.append(vazio("A casa está quieta", "Quando entrar reserva, chegar mercadoria ou alguém bater ponto, aparece aqui."));
      return;
    }
    lista.append(
      el("section", { classe: "cartao" }, [
        el("h3", { texto: "O que aconteceu" }),
        el("div", { classe: "tabela", style: "margin-top:10px" },
          dados.fatos.slice(0, 25).map((f) => {
            const setor = dados.setores.find((s) => s.id === f.setor);
            // A hora entra na linha de baixo, e não numa coluna própria: no
            // celular a coluna fixa deixava a lista rígida demais e empurrava
            // a página inteira para fora da tela.
            return el("div", { classe: `linha-tabela ${f.atencao ? "linha-atencao" : ""}`.trim() }, [
              el("div", { classe: "linha-principal" }, [
                el("strong", { texto: f.titulo }),
                el("span", {
                  classe: "muted",
                  texto: [quandoFoi(f.quando, dados.agora), setor?.nome, f.quem, f.detalhe]
                    .filter(Boolean).join(" · "),
                }),
              ]),
            ]);
          })),
      ]),
    );
  }

  /* ================= Os bonequinhos ================= */

  function enfileirar(fato) {
    // Quem pediu menos animação no aparelho não ganha bonequinho: o setor já
    // mudou de cor e de texto sozinho, que é a informação.
    if (menosAnimacao()) return;
    fila.push(fato);
    puxarDaFila();
  }

  function puxarDaFila() {
    while (andando < BONECOS_AO_MESMO_TEMPO && fila.length > 0) andar(fila.shift());
  }

  function andar(fato) {
    const setor = dados.setores.find((s) => s.id === fato.setor);
    if (!setor || !setor.contratado) return;

    andando += 1;
    const boneco = el("div", {
      classe: `boneco ${fato.atencao ? "boneco-atencao" : ""}`.trim(),
      style: `left:${ENTRADA.x}%;top:${ENTRADA.y}%`,
    }, [
      el("span", { classe: "boneco-inicial", texto: inicial(fato.quem) }),
      el("span", { classe: "balao" }, [
        el("strong", { texto: fato.titulo }),
        fato.quem ? el("small", { texto: primeiroNome(fato.quem) }) : null,
      ]),
    ]);
    planta.append(boneco);

    // Dois quadros antes de mover: o navegador precisa pintar a posição de
    // partida, senão ele "aparece" já no destino e não há caminhada.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      boneco.style.left = `${setor.x}%`;
      boneco.style.top = `${setor.y + 9}%`;
      boneco.classList.add("boneco-andando");
    }));

    setTimeout(() => boneco.classList.add("boneco-chegou"), 2200);
    setTimeout(() => {
      const cartao = planta.querySelector(`[data-setor="${fato.setor}"]`);
      cartao?.classList.add("setor-piscou");
      setTimeout(() => cartao?.classList.remove("setor-piscou"), 900);
      boneco.classList.add("boneco-saindo");
    }, 5200);
    setTimeout(() => {
      boneco.remove();
      andando -= 1;
      puxarDaFila();
    }, 6000);
  }
}

/* ================= Miudezas ================= */

function comoFazTempo(minutos) {
  if (minutos === null || minutos === undefined) return "nada ainda";
  if (minutos < 1) return "agora mesmo";
  if (minutos < 60) return `há ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `há ${horas} h`;
  const dias = Math.floor(horas / 24);
  return dias === 1 ? "ontem" : `há ${dias} dias`;
}

function primeiroNome(nome) {
  return String(nome ?? "").trim().split(/\s+/)[0] ?? "";
}

function inicial(nome) {
  const primeiro = primeiroNome(nome);
  return primeiro ? primeiro[0].toUpperCase() : "•";
}

/**
 * A hora, e o dia junto quando não é de hoje.
 *
 * Sem o dia, um fato das 19h40 de ontem aparece embaixo de um das 13h40 de
 * hoje e a lista parece fora de ordem — já pareceu.
 */
function quandoFoi(iso, agora) {
  const d = new Date(iso);
  const hora = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const mesmoDia = d.toDateString() === new Date(agora).toDateString();
  return mesmoDia ? hora : `${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} ${hora}`;
}
