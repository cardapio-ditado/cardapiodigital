import { get } from "../api.js";
import { el, icone, limpar, vazio } from "../ui.js";

/**
 * A CASA AGORA — o salão do bar visto de cima, como um tabuleiro.
 *
 * O SALÃO é o lugar grande: as mesas da casa desenhadas em grade, a porta no
 * canto por onde o cliente entra, e os garçons andando entre elas. A mesa
 * ACENDE no instante em que alguém lê o QR code dela, e PISCA quando aquela
 * mesa chama o garçom — que é a coisa mais urgente que um salão tem.
 *
 * A RETAGUARDA é a faixa de cima: cozinha, doca, escritório, rotinas e
 * opinião. Importam, mas não é lá que o dinheiro aparece.
 *
 * Os bonecos são de quem está na casa: as pessoas com o ponto aberto e os
 * agentes de software. Cada um anda pelo lugar dele e carrega na cabeça o que
 * está fazendo — ou "ocioso", e há quanto tempo.
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
/** De quanto em quanto tempo um boneco escolhe um novo lugar. */
const PASSO_TRABALHANDO = [2600, 4200];
const PASSO_OCIOSO = [7000, 12_000];
/** Quantas mesas por fileira no salão, do monitor ao celular. */
const MESAS_POR_FILEIRA = 10;

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
  planta.classList.add("planta-jogo");
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
    const ocupadas = (dados.mesas ?? []).filter((m) => m.estado !== "livre").length;

    limpar(cabecalho).append(
      el("div", { classe: "cabecalho-secao" }, [
        el("div", {}, [
          el("h2", { texto: "A casa agora" }),
          el("p", {
            classe: "muted",
            texto: [
              gente.length ? `${gente.length} na casa` : "ninguém na casa",
              ociosos ? `${ociosos} ocioso(s)` : null,
              ocupadas ? `${ocupadas} mesa(s) com cliente` : null,
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

    const daArea = (area) => dados.setores.filter((s) => s.area === area);
    const moradoresDe = (id) => (dados.trabalhadores ?? []).filter((t) => t.setor === id);

    planta.append(
      el("div", { classe: "retaguarda" }, [
        el("span", { classe: "retaguarda-titulo", texto: "Retaguarda" }),
        el("div", { classe: "retaguarda-salas" },
          daArea("retaguarda").map((setor) => sala(setor, moradoresDe(setor.id), "compacta"))),
      ]),
      desenharSalao(daArea("salao"), moradoresDe),
    );

    if (!menosAnimacao()) {
      for (const node of planta.querySelectorAll(".boneco:not(.boneco-na-fila)")) passear(node);
    }
  }

  /**
   * O salão: as mesas em grade e, por cima delas, os garçons andando.
   *
   * As mesas ficam no fluxo normal (uma grade), e os bonecos flutuam por
   * cima em posição absoluta. Assim o salão cresce sozinho conforme o número
   * de mesas da casa — setenta mesas e três mesas desenham igual.
   */
  function desenharSalao(setores, moradoresDe) {
    const salao = setores.find((s) => s.id === "salao");
    const portaria = setores.find((s) => s.id === "porta");
    const mesas = dados.mesas ?? [];
    const ocupadas = mesas.filter((m) => m.estado !== "livre").length;
    const chamando = mesas.filter((m) => m.estado === "chamando").length;

    const gente = [...moradoresDe("salao"), ...moradoresDe("porta")];

    return el("div", {
      classe: `salao ${salao && !salao.contratado ? "salao-apagado" : ""}`.trim(),
      "data-setor": "salao",
    }, [
      el("div", { classe: "salao-placa" }, [
        icone(ICONE_DO_SETOR.salao, 16),
        el("strong", { texto: "Salão" }),
        el("span", {
          classe: "muted",
          texto: !salao?.contratado
            ? "cardápio digital não contratado"
            : mesas.length === 0
              ? "nenhuma mesa cadastrada"
              : `${mesas.length} mesas · ${ocupadas} com cliente`,
        }),
        chamando ? el("span", { classe: "salao-chamando", texto: `${chamando} chamando o garçom` }) : null,
      ]),

      el("div", { classe: "salao-piso" }, [
        mesas.length === 0
          ? el("span", { classe: "sala-vazia", texto: salao?.contratado ? "Cadastre as mesas no Cardápio para o salão aparecer" : "não contratado" })
          : el("div", { classe: "mesas", style: `--por-fileira:${Math.min(MESAS_POR_FILEIRA, Math.max(4, Math.ceil(Math.sqrt(mesas.length * 1.6))))}` },
            mesas.map((m) => mesa(m))),

        // O corredor: a faixa por onde a equipe circula, na frente da porta.
        // Os bonecos moram AQUI, e não por cima das mesas — em cima do
        // tabuleiro eles cobriam justamente o número da mesa e o estado dela,
        // que é o que a tela existe para mostrar.
        el("div", { classe: "salao-corredor" }, [
          portaria ? porta(portaria) : null,
          el("div", { classe: "salao-gente" },
            gente.map((t, i) => boneco(t, lugarNaSala(i, Math.max(1, gente.length))))),
        ]),
      ]),
    ]);
  }

  /** Uma mesa: acesa quando leram o QR, piscando quando chamaram o garçom. */
  function mesa(m) {
    const detalhe = [
      m.cliente,
      m.olhando ? `olhando ${m.olhando}` : null,
      m.garcom ? `garçom ${m.garcom}` : null,
      m.minutos !== null ? `há ${m.minutos} min` : null,
    ].filter(Boolean).join(" · ");

    return el("div", {
      classe: `mesa mesa-${m.estado}`,
      title: `Mesa ${m.numero}${detalhe ? ` — ${detalhe}` : " — livre"}`,
    }, [
      el("span", { classe: "mesa-numero", texto: String(m.numero) }),
      m.garcom ? el("span", { classe: "mesa-garcom", texto: iniciais(m.garcom) }) : null,
    ]);
  }

  /** A porta da rua, com o que a portaria tem para contar. */
  function porta(setor) {
    return el("div", {
      classe: `porta ${setor.ultimo?.atencao ? "porta-atencao" : ""}`.trim(),
      "data-setor": "porta",
      title: setor.contratado ? setor.legenda : `${setor.legenda} — não contratado`,
    }, [
      icone(ICONE_DO_SETOR.porta, 16),
      el("span", { classe: "porta-nome", texto: "Entrada" }),
      el("span", {
        classe: "porta-recado",
        texto: !setor.contratado ? "não contratado" : setor.ultimo ? setor.ultimo.titulo : "sem movimento",
      }),
    ]);
  }

  function sala(setor, moradores) {
    const vivo = setor.minutos_parado !== null && setor.minutos_parado <= MINUTOS_ATE_ESFRIAR;
    const precisa = setor.ultimo?.atencao === true;
    const estado = !setor.contratado ? "sala-apagada" : precisa ? "sala-atencao" : vivo ? "sala-viva" : "";

    return el("div", {
      classe: `sala ${estado}`.trim(),
      "data-setor": setor.id,
      title: setor.contratado ? setor.legenda : `${setor.legenda} — a casa não contratou este módulo`,
    }, [
      el("div", { classe: "sala-placa" }, [
        icone(ICONE_DO_SETOR[setor.id] ?? ICONE_DO_SETOR.salao, 15),
        el("strong", { texto: setor.nome }),
        setor.contratado && setor.quantos > 0
          ? el("span", { classe: "sala-conta", texto: String(setor.quantos) })
          : null,
      ]),
      el("div", { classe: "sala-piso sala-piso-fila" },
        !setor.contratado
          ? [el("span", { classe: "sala-vazia", texto: "não contratado" })]
          : moradores.length === 0
            ? [el("span", { classe: "sala-vazia", texto: "ninguém aqui" })]
            : moradores.map((t) => boneco(t, null))),
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
    const x = n === 1 ? 50 : 8 + ((i + 0.5) / n) * 84;
    // Duas faixas de altura, alternadas: assim a etiqueta de um não bate na
    // do vizinho, que foi o primeiro defeito que esta tela teve.
    const y = n === 1 ? 60 : i % 2 === 0 ? 46 : 74;
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
      // Sem lugar marcado, o boneco entra na fila da sala — é a retaguarda,
      // onde o espaço é pouco e a posição não diz nada.
      classe: lugar ? classe : `${classe} boneco-na-fila`,
      style: lugar ? `left:${lugar.x.toFixed(1)}%;top:${lugar.y.toFixed(1)}%` : null,
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
    // e não uma corrida pelo salão inteiro que embaralharia todo mundo.
    if (lugar) node.dataset.casa = `${lugar.x},${lugar.y}`;
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
