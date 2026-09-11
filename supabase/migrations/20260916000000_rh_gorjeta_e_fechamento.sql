-- RH — Fase 5: gorjeta rateada e o resumo do mês.
--
-- O fim da noite num bar é sempre a mesma cena: alguém soma o serviço na
-- calculadora do celular, divide de cabeça e anota num papel. No dia
-- seguinte ninguém lembra quanto foi nem quem estava. Discussão sobre
-- gorjeta é das que mais azedam equipe.
--
-- Aqui o gestor lança o valor arrecadado no turno e o sistema reparte entre
-- quem estava, por um critério escolhido — e guarda a conta, com centavo
-- fechando no total.
--
-- O VALOR TOTAL É DIGITADO À MÃO, de propósito: assim a casa que não tem o
-- CMV contratado usa a gorjeta do mesmo jeito. Nenhum módulo depende do
-- outro.

-- ============================================================
-- 1. Peso por função
-- ============================================================
--
-- "Garçom pesa mais que apoio" é regra de casa, não lei. Cada bar acerta a
-- sua; sem linha nenhuma aqui, todo mundo pesa igual.
create table if not exists public.rh_pesos (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  funcao text not null,
  peso numeric(6, 2) not null default 1 check (peso >= 0),
  criado_em timestamptz not null default now(),
  unique (venue_id, funcao)
);

alter table public.rh_pesos enable row level security;

-- ============================================================
-- 2. O fechamento do turno
-- ============================================================
create table if not exists public.rh_gorjetas (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,

  -- O dia DA CASA (a noite que virou a madrugada é uma só).
  dia date not null,
  turno_id uuid references public.rh_turnos(id) on delete set null,

  valor numeric(12, 2) not null check (valor >= 0),
  criterio text not null default 'igual' check (criterio in ('igual', 'peso', 'horas')),

  observacao text,
  criado_por text,
  criado_em timestamptz not null default now()
);

-- Um fechamento por turno por dia. Dois seriam pagamento em dobro sem
-- ninguém perceber. `nulls not distinct` para o turno vazio (a casa que
-- fecha a noite inteira de uma vez) cair na mesma regra.
create unique index if not exists idx_rh_gorjetas_turno
  on public.rh_gorjetas (venue_id, dia, turno_id)
  nulls not distinct;

create index if not exists idx_rh_gorjetas_periodo on public.rh_gorjetas (venue_id, dia desc);

alter table public.rh_gorjetas enable row level security;

-- ============================================================
-- 3. Quanto coube a cada um
-- ============================================================
--
-- A cota é GRAVADA, não recalculada na leitura: se o peso da função mudar
-- em janeiro, o que foi pago em dezembro continua sendo o que foi pago.
create table if not exists public.rh_gorjeta_cotas (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  gorjeta_id uuid not null references public.rh_gorjetas(id) on delete cascade,
  atendente_id uuid not null references public.pesquisa_atendentes(id) on delete cascade,

  -- O que entrou na conta daquela vez: o peso usado e os minutos
  -- trabalhados. Guardados para a divisão poder ser explicada depois.
  peso numeric(6, 2) not null default 1,
  minutos integer not null default 0,
  valor numeric(12, 2) not null default 0,

  unique (gorjeta_id, atendente_id)
);

create index if not exists idx_rh_cotas_pessoa
  on public.rh_gorjeta_cotas (venue_id, atendente_id);

alter table public.rh_gorjeta_cotas enable row level security;

notify pgrst, 'reload schema';
