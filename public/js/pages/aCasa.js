import { get } from "../api.js";
import { el, icone, limpar, vazio } from "../ui.js";

/**
 * A CASA AGORA — a planta do bar como um escritório visto de cima.
 *
 * Sete salas com parede, e dentro delas os bonecos de quem está na casa: as
 * pessoas com o ponto aberto e os agentes de software. Cada boneco anda pela
 * sala dele e carrega na cabeça o que está fazendo — ou "ocioso", e há quanto
 * tempo.
 *
 * "Ocioso" aqui é informação de verdade, não enfeite. Agente ocioso é o
 * normal: ninguém escreveu. Cozinheiro ocioso às três da tarde também. O que
 * esta tela entrega é o CONTRASTE — três garçons ociosos às nove da noite de
 * sexta salta aos olhos de qualquer um, e não há relatório que faça isso tão
 * rápido.
 *
 * Cuidados que a tela toma:
 *   · com a aba escondida ela para de perguntar;
 *   · quem pediu menos animação no aparelho vê os bonecos parados nos
 *     lugares, sem caminhada;
 *   · no celular as salas viram cartões empilhados com os bonecos em fila —
 *     sete salas lado a lado em 400px não se leem.
 */

const QUANTO_ESPERA_MS = 15_000;
/** Depois disto, a sala deixa de ser "viva" e vira "quieta". */
const MINUTOS_ATE_ESFRIAR = 45;
/** De quanto em quanto tempo um boneco escolhe um novo lugar na sala. */
const PASSO_TRABALHANDO = [2600, 4200];
const PASSO_OCIOSO = [7000, 12_000];

const ICONE_DO_SETOR = {
  doca: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10",
  cozinha: "M5 11h14v6a3 3 0 01-3 3H8a3 3 0 01-3-3v-6zM3 11h18M8 8c0-2 1-2.5 1-4M12 8c0-2 1-2.5 1-4M16 8c0-2 1-2.5 1-4",
  escritorio: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z",
  salao: "M3 9h18l-2 3H5L3 9zM3 9l2-4h14l2 4M8 12v8M16 12v8M8 20h8",
  porta: "M4 21h16M6 3h9v18H6zM11.5 12h.01M15 7h4v14h-4",
  operacao: "M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11",
  opiniao: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 6.91-1.01L12 2z",
};

const menosAnimacao = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const sorteio = (de, ate) => de + Math.random() * (ate - de);

export async function aCasa(raiz, ctx) {
  let dados = null;
  const vistos = new Set();
  let pausado = false;
  let relogio = null;
  /** Um passeio por boneco: `setTimeout` que se reagenda sozinho. */
  const passeios = new Set();

  const planta = el("div", { classe: "planta" });
  const lista = el("div", {});
  const cabecalho = el("div", { classe: "cartao" });

  limpar(raiz).append(el("div", { classe: "pilha" }, [cabecalho, planta, lista]));

  // A tela morre quando o usuário sai dela: sem isto o relógio continua
  // batendo em segundo plano e a casa inteira é buscada para ninguém.
  ctx.aoSair(() => {
    clearInterval(relogio);
    pararPasseios();
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

  function pararPasseios() {
    for (const t of passeios) clearTimeout(t);
    passeios.clear();
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

    const novidades = primeira ? [] : novo.fatos.filter((f) => !vistos.has(f.id));
    for (const f of novo.fatos) vistos.add(f.id);

    dados = primeira
      ? novo
      : {
        ...novo,
        // A janela incremental só traz o que é novo; o resto continua valendo.
        fatos: [...novidades, ...dados.fatos].slice(0, 60),
        setores: juntarSetores(dados.setores, novo.setores),
      };

    desenhar();
    for (const f of novidades) avisarNaSala(f.setor);
  }

  /**
   * A sala nova manda no que ela sabe, mas não apaga o que já havia.
   *
   * A busca incremental só olha os últimos quinze segundos: se ela mandasse
   * sozinha, toda sala viraria "sem movimento" a cada volta do relógio.
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
    const gente = dados.trabalhadores ?? [];
    const ociosos = gente.filter((t) => !t.fazendo && !t.em_pausa).length;

    limpar(cabecalho).append(
      el("div", { classe: "cabecalho-secao" }, [
        el("div", {}, [
          el("h2", { texto: "A casa agora" }),
          el("p", {
            classe: "muted",
            texto: [
              gente.length ? `${gente.length} na casa` : "ninguém na casa",
              ociosos ? `${ociosos} ocioso(s)` : null,
              dados.fatos.length ? `${dados.fatos.length} coisa(s) em 24 h` : null,
              atencao ? `${atencao} pedindo atenção` : null,
            ].filter(Boolean).join(" · "),
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
    pararPasseios();
    limpar(planta);

    for (const setor of dados.setores) {
      const moradores = (dados.trabalhadores ?? []).filter((t) => t.setor === setor.id);
      planta.append(sala(setor, moradores));
    }
    if (!menosAnimacao()) {
      for (const node of planta.querySelectorAll(".boneco")) passear(node);
    }
  }

  function sala(setor, moradores) {
    const vivo = setor.minutos_parado !== null && setor.minutos_parado <= MINUTOS_ATE_ESFRIAR;
    const precisa = setor.ultimo?.atencao === true;
    const estado = !setor.contratado ? "sala-apagada" : precisa ? "sala-atencao" : vivo ? "sala-viva" : "";

    return el("div", {
      classe: `sala ${estado}`.trim(),
      "data-setor": setor.id,
      style: `left:${setor.x}%;top:${setor.y}%;width:${setor.w}%;height:${setor.h}%`,
      title: setor.contratado ? setor.legenda : `${setor.legenda} — a casa não contratou este módulo`,
    }, [
      el("div", { classe: "sala-placa" }, [
        icone(ICONE_DO_SETOR[setor.id] ?? ICONE_DO_SETOR.salao, 15),
        el("strong", { texto: setor.nome }),
        setor.contratado && setor.quantos > 0
          ? el("span", { classe: "sala-conta", texto: String(setor.quantos) })
          : null,
      ]),
      el("div", { classe: "sala-piso" },
        !setor.contratado
          ? [el("span", { classe: "sala-vazia", texto: "não contratado" })]
          : moradores.length === 0
            ? [el("span", { classe: "sala-vazia", texto: "ninguém aqui agora" })]
            : moradores.map((t, i) => boneco(t, lugarNaSala(i, moradores.length)))),
      setor.contratado
        ? el("span", { classe: "sala-rodape", texto: setor.ultimo ? setor.ultimo.titulo : "sem movimento" })
        : null,
    ]);
  }

  /**
   * Onde o i-ésimo de n colegas fica na sala.
   *
   * Repartido, e não sorteado: com posição aleatória dois bonecos nasciam
   * colados e as etiquetas de cabeça se cobriam — que é justamente o texto
   * que a tela existe para mostrar. A altura alterna entre duas faixas para
   * as etiquetas de vizinhos também não baterem.
   */
  function lugarNaSala(i, n) {
    const x = n === 1 ? 50 : 16 + ((i + 0.5) / n) * 68;
    const y = n === 1 ? 52 : i % 2 === 0 ? 42 : 66;
    return { x, y };
  }

  /**
   * O boneco: cabeça com as iniciais, tronco, e a etiqueta em cima dizendo o
   * que ele está fazendo.
   */
  function boneco(t, lugar) {
    const ocioso = !t.fazendo && !t.em_pausa;
    const classe = [
      "boneco",
      t.tipo === "agente" ? "boneco-agente" : "boneco-pessoa",
      t.em_pausa ? "boneco-pausa" : ocioso ? "boneco-ocioso" : "boneco-ativo",
    ].join(" ");

    const dizer = t.em_pausa
      ? "em pausa"
      : t.fazendo
        ? t.fazendo
        : `ocioso ${comoFazTempo(t.minutos_parado)}`.trim();

    const node = el("div", {
      classe,
      style: `left:${lugar.x.toFixed(1)}%;top:${lugar.y.toFixed(1)}%`,
      title: [t.nome, t.papel, dizer].filter(Boolean).join(" · "),
    }, [
      el("span", { classe: "boneco-etiqueta", texto: dizer }),
      el("span", { classe: "boneco-corpo" }, [
        el("span", { classe: "boneco-cabeca", texto: iniciais(t.nome) }),
        el("span", { classe: "boneco-tronco" }),
      ]),
      el("span", { classe: "boneco-nome", texto: primeiroNome(t.nome) }),
    ]);
    // O lugar de origem fica guardado: o passeio é um vaivém em torno dele,
    // e não uma corrida pela sala inteira que embaralharia todo mundo.
    node.dataset.casa = `${lugar.x},${lugar.y}`;
    return node;
  }

  /** Um passo a cada tantos segundos: quem trabalha anda mais que quem não. */
  function passear(node) {
    const parado = node.classList.contains("boneco-ocioso") || node.classList.contains("boneco-pausa");
    const [de, ate] = parado ? PASSO_OCIOSO : PASSO_TRABALHANDO;
    const [casaX, casaY] = String(node.dataset.casa ?? "50,52").split(",").map(Number);
    // O passo é curto: ninguém atravessa a sala de uma vez, e ninguém pisa
    // no lugar do colega.
    const raio = parado ? 5 : 9;

    const t = setTimeout(() => {
      passeios.delete(t);
      node.style.left = `${Math.min(86, Math.max(14, casaX + sorteio(-raio, raio))).toFixed(1)}%`;
      node.style.top = `${Math.min(74, Math.max(30, casaY + sorteio(-raio / 2, raio / 2))).toFixed(1)}%`;
      passear(node);
    }, sorteio(de, ate));
    passeios.add(t);
  }

  /** Chegou fato novo numa sala: ela pisca, para o olho perceber de longe. */
  function avisarNaSala(setor) {
    const node = planta.querySelector(`[data-setor="${setor}"]`);
    if (!node) return;
    node.classList.add("sala-piscou");
    setTimeout(() => node.classList.remove("sala-piscou"), 1200);
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
}

/* ================= Miudezas ================= */

function comoFazTempo(minutos) {
  if (minutos === null || minutos === undefined) return "";
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

/** Duas letras cabem na cabeça do boneco; três já viram borrão. */
function iniciais(nome) {
  const partes = String(nome ?? "").trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "•";
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[1][0]).toUpperCase();
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
