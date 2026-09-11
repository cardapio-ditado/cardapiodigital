-- RH — a gorjeta do jeito que a CASA paga, e não do jeito que o sistema achou.
--
-- Havia uma conta só: o bolo do turno, dividido entre quem estava. Mas bar
-- não paga gorjeta de um jeito só. Há duas famílias, e a casa precisa
-- escolher a sua uma vez, não a cada lançamento:
--
--   INDIVIDUAL — cada um recebe um percentual sobre O QUE ELE MESMO VENDEU.
--                É a comissão de garçom. Quem vendeu mais leva mais, e a
--                conta de cada um se explica sozinha.
--
--   GLOBAL     — a casa arrecada um percentual sobre a venda inteira e
--                reparte entre a equipe, por um critério: igual para todos,
--                por peso da função (a pontuação da casa) ou pelas horas
--                trabalhadas. É como paga quem quer o salão inteiro junto,
--                cozinha e copa incluídas.
--
-- Nos dois casos vale a mesma régua já existente: nem tudo que é arrecadado
-- é repassado. A diferença cobre taxa de cartão, quebra e o que a casa
-- combinar — e aparece na tela, porque essa é a pergunta que gera briga.
--
-- Esta migração acrescenta três coisas:
--   1. a regra da casa (qual método, quais percentuais);
--   2. a venda de cada pessoa, que o método individual precisa;
--   3. os adicionais e descontos da semana, que existem nos dois métodos.
--
-- Nada do que já estava é apagado: os fechamentos de turno já lançados
-- continuam valendo e continuam aparecendo.

-- ============================================================
-- 1. A regra da casa
-- ============================================================
--
-- Uma linha por venue. Sem linha, a casa ainda não escolheu, e a tela pede
-- a escolha antes de deixar lançar — melhor perguntar uma vez do que pagar
-- errado a semana inteira.
create table if not exists public.rh_gorjeta_regras (
  venue_id uuid primary key references public.venues(id) on delete cascade,

  metodo text not null default 'individual'
    check (metodo in ('individual', 'global')),

  -- Quanto a casa cobra de serviço sobre a venda. Os 10% de praxe, mas cada
  -- casa tem o seu — e há casa que cobra 12 ou 13.
  percentual_servico numeric(5, 2) not null default 10
    check (percentual_servico >= 0 and percentual_servico <= 100),

  -- Quanto do arrecadado vai para a equipe. 100 = a casa não retém nada.
  percentual_repasse numeric(5, 2) not null default 100
    check (percentual_repasse >= 0 and percentual_repasse <= 100),

  -- Só manda no método global: como o bolo se reparte.
  criterio_rateio text not null default 'igual'
    check (criterio_rateio in ('igual', 'peso', 'horas')),

  -- No método individual, quem não vende (cozinha, copa) ficaria de fora.
  -- Este percentual do arrecadado é separado ANTES das comissões e rateado
  -- pelo critério acima entre quem não teve venda própria. Zero desliga.
  percentual_da_casa_para_apoio numeric(5, 2) not null default 0
    check (percentual_da_casa_para_apoio >= 0 and percentual_da_casa_para_apoio <= 100),

  atualizado_em timestamptz not null default now(),
  atualizado_por text
);

comment on table public.rh_gorjeta_regras is
  'Como esta casa paga gorjeta. Uma linha por venue; sem linha, a casa ainda não escolheu.';

alter table public.rh_gorjeta_regras enable row level security;

-- ============================================================
-- 2. A venda de cada pessoa
-- ============================================================
--
-- O método individual não tem como existir sem isto. Uma linha por pessoa
-- por turno: o que ela vendeu e em quantas comandas.
--
-- O valor é DIGITADO À MÃO de propósito, como o resto do módulo: a casa que
-- não tem integração com o sistema de venda usa a gorjeta do mesmo jeito.
create table if not exists public.rh_vendas (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,

  -- O dia DA CASA: a noite que virou madrugada é uma só.
  dia date not null,
  turno_id uuid references public.rh_turnos(id) on delete set null,
  atendente_id uuid not null references public.pesquisa_atendentes(id) on delete cascade,

  valor numeric(12, 2) not null default 0 check (valor >= 0),
  comandas integer not null default 0 check (comandas >= 0),

  observacao text,
  criado_por text,
  criado_em timestamptz not null default now()
);

-- Uma venda por pessoa por turno. Duas seriam comissão em dobro sem ninguém
-- perceber. `nulls not distinct` para o turno vazio (a casa que fecha a
-- noite inteira de uma vez) cair na mesma regra.
create unique index if not exists idx_rh_vendas_pessoa_turno
  on public.rh_vendas (venue_id, dia, turno_id, atendente_id)
  nulls not distinct;

create index if not exists idx_rh_vendas_periodo on public.rh_vendas (venue_id, dia desc);

alter table public.rh_vendas enable row level security;

-- ============================================================
-- 3. Adicionais e descontos
-- ============================================================
--
-- O que não sai de percentual nenhum: a gorjeta que o cliente deixou na mão,
-- o rateio de um evento fechado, e do outro lado o consumo da pessoa no bar
-- que sai do acerto da semana.
--
-- Uma tabela só para os dois, com sinal no `tipo`: são a mesma coisa na
-- tela (uma linha no acerto de alguém) e separá-las em duas tabelas só
-- dobraria o código.
create table if not exists public.rh_gorjeta_extras (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,

  dia date not null,
  atendente_id uuid not null references public.pesquisa_atendentes(id) on delete cascade,

  tipo text not null check (tipo in ('adicional', 'desconto')),
  descricao text,
  valor numeric(12, 2) not null check (valor >= 0),

  criado_por text,
  criado_em timestamptz not null default now()
);

comment on column public.rh_gorjeta_extras.valor is
  'Sempre positivo. Quem decide se soma ou subtrai é o tipo.';

create index if not exists idx_rh_extras_periodo
  on public.rh_gorjeta_extras (venue_id, dia desc);
create index if not exists idx_rh_extras_pessoa
  on public.rh_gorjeta_extras (venue_id, atendente_id);

alter table public.rh_gorjeta_extras enable row level security;

-- ============================================================
-- 4. A semana de referência do fechamento de turno
-- ============================================================
--
-- O fechamento por turno continua existindo (é o método global), mas a tela
-- agora lê por semana. Sem índice por dia crescente a varredura da semana
-- vira sequential scan assim que a casa tiver um ano de lançamentos.
create index if not exists idx_rh_gorjetas_dia_asc on public.rh_gorjetas (venue_id, dia);

notify pgrst, 'reload schema';
