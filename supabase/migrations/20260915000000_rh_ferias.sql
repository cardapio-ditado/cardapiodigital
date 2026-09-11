-- RH — Fase 4: férias, com o relógio do vencimento à vista.
--
-- O que quebra casa de bar não é conceder férias: é PERDER a data. Cada
-- pessoa acumula um período aquisitivo de doze meses e a casa tem os doze
-- meses seguintes para conceder. Passou disso, a CLT manda pagar em dobro
-- (art. 137) — e isso normalmente se descobre tarde, junto com o susto.
--
-- Por isso a tabela guarda só o que é FATO (as férias pedidas e concedidas).
-- Os períodos aquisitivos não viram linha: são calculados a partir da data de
-- admissão, no código, e por isso nunca ficam desatualizados nem precisam de
-- rotina noturna para nascer.

create table if not exists public.rh_ferias (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  atendente_id uuid not null references public.pesquisa_atendentes(id) on delete cascade,

  inicio date not null,
  fim date not null,
  -- Guardado, e não recalculado na leitura: se a regra de contagem mudar um
  -- dia, o que já foi concedido continua valendo pelo que foi combinado.
  dias integer not null,

  -- Venda de parte das férias (abono pecuniário, até 1/3). Fica registrado
  -- aqui porque muda quantos dias saem do saldo; o VALOR é da contabilidade.
  abono_dias integer not null default 0,

  -- A qual período aquisitivo estas férias pertencem. É a data de início do
  -- período, que o código calcula a partir da admissão.
  periodo_inicio date,

  situacao text not null default 'pedido'
    check (situacao in ('pedido', 'aprovado', 'recusado', 'cancelado')),

  observacao text,
  pedido_por text,
  decidido_por text,
  decidido_em timestamptz,

  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),

  -- Fim antes do início é erro de digitação que passaria batido e viraria
  -- saldo negativo na tela.
  check (fim >= inicio)
);

comment on table public.rh_ferias is
  'Férias pedidas e concedidas. O período aquisitivo NÃO mora aqui: é calculado a partir da admissão, no código.';

create index if not exists idx_rh_ferias_pessoa
  on public.rh_ferias (venue_id, atendente_id, inicio desc);

-- A tela do calendário pergunta "quem está de férias neste mês?".
create index if not exists idx_rh_ferias_periodo
  on public.rh_ferias (venue_id, inicio, fim)
  where situacao in ('pedido', 'aprovado');

create or replace function public.rh_ferias_antes()
returns trigger
language plpgsql
as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;

drop trigger if exists rh_ferias_antes on public.rh_ferias;
create trigger rh_ferias_antes
  before update on public.rh_ferias
  for each row execute function public.rh_ferias_antes();

alter table public.rh_ferias enable row level security;

notify pgrst, 'reload schema';
