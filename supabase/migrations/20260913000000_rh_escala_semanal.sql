-- RH — Fase 2: a escala da semana.
--
-- Hoje a escala do bar vive num grupo de WhatsApp e num papel na cozinha. O
-- resultado é sempre o mesmo: alguém jura que não estava escalado, ninguém
-- acha a versão certa, e a troca combinada na quinta some até sábado.
--
-- Três tabelas, na ordem em que se usa:
--   rh_turnos   — os turnos DA CASA (almoço, noite, fechamento). Cada bar tem
--                 os seus; nada é fixo no código.
--   rh_escala   — uma linha por pessoa, por dia. Trabalha num turno, ou está
--                 de folga, férias ou atestado.
--   rh_semanas  — quando a semana foi publicada e quantos avisos saíram. É o
--                 que separa rascunho de escala valendo.
--
-- Turno que vira o dia (22h → 4h) é o normal em bar, não a exceção: `fim`
-- menor que `inicio` significa que o turno atravessa a meia-noite, e a linha
-- da escala pertence ao dia em que o turno COMEÇA. Sem essa regra, a noite de
-- sábado apareceria dividida entre sábado e domingo.

-- ============================================================
-- 1. Os turnos da casa
-- ============================================================
create table if not exists public.rh_turnos (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  nome text not null,
  inicio time not null,
  fim time not null,
  -- Ordem na grade. Almoço antes da noite, mesmo que alguém cadastre ao
  -- contrário.
  ordem integer not null default 0,
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  unique (venue_id, nome)
);

comment on table public.rh_turnos is
  'Turnos da casa. fim < inicio significa que o turno atravessa a meia-noite; a escala pertence ao dia em que ele começa.';

create index if not exists idx_rh_turnos_casa on public.rh_turnos (venue_id, ativo, ordem);

alter table public.rh_turnos enable row level security;

-- ============================================================
-- 2. A escala
-- ============================================================
create table if not exists public.rh_escala (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  data date not null,
  atendente_id uuid not null references public.pesquisa_atendentes(id) on delete cascade,

  -- Nulo quando a pessoa não trabalha nesse dia (folga, férias, atestado).
  turno_id uuid references public.rh_turnos(id) on delete cascade,

  situacao text not null default 'trabalha'
    check (situacao in ('trabalha', 'folga', 'ferias', 'atestado', 'falta')),

  -- O que a pessoa faz NESTE dia. Em bar não é fixo: quem é garçom na sexta
  -- cobre o caixa no domingo. Vazio = a função do cadastro dela.
  funcao text,
  observacao text,

  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now()
);

-- Um índice só, e ele precisa ser assim.
--
-- A regra tem duas metades: a mesma pessoa PODE pegar dois turnos no mesmo
-- dia (almoço e noite — dobra é comum em bar), mas NÃO pode ter o mesmo turno
-- duas vezes, nem duas linhas sem turno (folga e férias no mesmo dia).
--
-- A tentação é resolver com dois índices parciais (um `where turno_id is not
-- null`, outro `where turno_id is null`). Não funciona: o `on conflict` do
-- upsert não consegue mirar índice parcial sem repetir o `where`, e a tela
-- quebraria com "no unique or exclusion constraint matching" no segundo
-- clique da mesma célula. Testado, falha nos dois casos.
--
-- `nulls not distinct` (Postgres 15+) faz um índice só cobrir as duas metades:
-- duas linhas sem turno passam a colidir, que é exatamente a regra da folga.
drop index if exists public.idx_rh_escala_pessoa_turno;
drop index if exists public.idx_rh_escala_pessoa_sem_turno;

create unique index if not exists idx_rh_escala_pessoa_dia_turno
  on public.rh_escala (venue_id, data, atendente_id, turno_id)
  nulls not distinct;

create index if not exists idx_rh_escala_semana on public.rh_escala (venue_id, data);
create index if not exists idx_rh_escala_pessoa on public.rh_escala (venue_id, atendente_id, data);

create or replace function public.rh_escala_antes()
returns trigger
language plpgsql
as $$
begin
  new.atualizada_em := now();
  -- Quem não trabalha não tem turno, e quem tem turno trabalha. Deixar os
  -- dois viverem juntos criaria "folga das 18h" na grade.
  if new.situacao <> 'trabalha' then
    new.turno_id := null;
  end if;
  return new;
end;
$$;

drop trigger if exists rh_escala_antes on public.rh_escala;
create trigger rh_escala_antes
  before insert or update on public.rh_escala
  for each row execute function public.rh_escala_antes();

alter table public.rh_escala enable row level security;

-- ============================================================
-- 3. A semana publicada
-- ============================================================
--
-- Enquanto não publica, é rascunho: o gestor mexe à vontade e ninguém é
-- avisado. Publicar é o ato que manda a semana para o WhatsApp de cada um.
create table if not exists public.rh_semanas (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  -- Sempre a segunda-feira daquela semana.
  semana date not null,
  publicada_em timestamptz not null default now(),
  publicada_por text,
  avisos_enviados integer not null default 0,
  unique (venue_id, semana)
);

comment on column public.rh_semanas.semana is
  'A segunda-feira da semana. O domínio normaliza qualquer data para ela antes de gravar.';

create index if not exists idx_rh_semanas_casa on public.rh_semanas (venue_id, semana desc);

alter table public.rh_semanas enable row level security;

notify pgrst, 'reload schema';
