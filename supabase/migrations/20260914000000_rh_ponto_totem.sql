-- RH — Fase 3: o ponto, batido num tablet fixo na casa.
--
-- O desenho é o que funciona em bar: UM tablet preso na parede da cozinha ou
-- do estoque, sem app para instalar e sem login individual. A pessoa toca no
-- próprio nome, digita quatro dígitos e bate entrada, pausa, volta ou saída.
-- Garçom não tem crachá, não tem e-mail corporativo e muitas vezes está com
-- as mãos ocupadas — qualquer coisa mais pesada que isso não é usada.
--
-- Três peças:
--   rh_totens  — o tablet autorizado. O endereço carrega um token secreto; é
--                ele que separa "o tablet da casa" de "qualquer um na rua".
--   rh_fichas  — ganha o PIN da pessoa, guardado como hash (scrypt), nunca em
--                texto. Quatro dígitos é fraco por natureza: o que segura é o
--                limite de tentativas e o fato de o tablet estar dentro da
--                casa.
--   rh_pontos  — uma linha por batida. Hora trabalhada não é campo editável:
--                é conta feita em cima das batidas, e por isso a correção do
--                gestor também vira batida, com autor e motivo.

-- ============================================================
-- 1. O dia da casa — de novo, e de propósito
-- ============================================================
--
-- O CMV já tem `cmv_dia_operacional`. Esta função faz a mesma conta com nome
-- neutro porque o RH NÃO PODE depender do CMV estar contratado: são módulos
-- que se vendem separados, e uma casa pode ter ponto sem ter estoque.
-- A fonte da verdade continua sendo uma só: `venues.virada_do_dia`.
create or replace function public.dia_operacional(p_venue_id uuid, p_instante timestamptz)
returns date
language sql
stable
as $$
  select ((p_instante at time zone v.timezone) - make_interval(hours => v.virada_do_dia))::date
  from public.venues v
  where v.id = p_venue_id;
$$;

comment on function public.dia_operacional is
  'O dia DA CASA a que um instante pertence. Turno que termina às 4h pertence à noite anterior quando a casa vira às 5h.';

-- ============================================================
-- 2. O PIN de quatro dígitos
-- ============================================================
alter table public.rh_fichas add column if not exists pin_hash text;
alter table public.rh_fichas add column if not exists pin_atualizado_em timestamptz;

comment on column public.rh_fichas.pin_hash is
  'scrypt$<sal>$<hash> do PIN de 4 dígitos. Nunca guarde o PIN em texto: o gestor que vê a coluna veria o dígito de todo mundo.';

-- ============================================================
-- 3. O tablet autorizado
-- ============================================================
create table if not exists public.rh_totens (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  nome text not null,
  -- Segredo do endereço. Único no banco inteiro: dois totens com o mesmo
  -- token abririam a casa um do outro.
  token text not null unique,
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  ultimo_uso_em timestamptz
);

create index if not exists idx_rh_totens_casa on public.rh_totens (venue_id, ativo);

alter table public.rh_totens enable row level security;

-- ============================================================
-- 4. As batidas
-- ============================================================
create table if not exists public.rh_pontos (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  atendente_id uuid not null references public.pesquisa_atendentes(id) on delete cascade,

  -- O dia DA CASA, não o do calendário: a saída às 3h da manhã fecha a noite
  -- de ontem. Gravado junto porque é por ele que a tela agrupa, e recalcular
  -- a cada consulta obrigaria a ler a virada da casa em toda linha.
  dia date not null,
  tipo text not null check (tipo in ('entrada', 'pausa', 'volta', 'saida')),
  momento timestamptz not null default now(),

  origem text not null default 'totem' check (origem in ('totem', 'gestor')),
  totem_id uuid references public.rh_totens(id) on delete set null,

  -- Correção do gestor deixa rastro: quem mexeu e por quê. Ponto sem rastro
  -- não vale nada numa discussão trabalhista — nem para a casa, nem para a
  -- pessoa.
  editado_por text,
  motivo text,

  criado_em timestamptz not null default now()
);

create index if not exists idx_rh_pontos_dia on public.rh_pontos (venue_id, dia);
create index if not exists idx_rh_pontos_pessoa on public.rh_pontos (venue_id, atendente_id, dia, momento);

comment on column public.rh_pontos.tipo is
  'entrada, pausa, volta, saida — nessa ordem. A máquina de estados vive no código; o banco só guarda o que aconteceu.';

alter table public.rh_pontos enable row level security;

notify pgrst, 'reload schema';
