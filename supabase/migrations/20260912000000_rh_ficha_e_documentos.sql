-- RH — Fase 1: a ficha do funcionário e a pasta de documentos.
--
-- O sistema já sabia QUEM atende (`pesquisa_atendentes`: nome, apelido,
-- função), porque a pesquisa precisa disso para atribuir a nota e o cardápio
-- para escolher o garçom da mesa. O que nunca existiu é RH: CPF, admissão,
-- documento com validade, desligamento.
--
-- A decisão que sustenta tudo aqui: NÃO duplicar o cadastro. Quem já está na
-- lista de atendentes é a mesma pessoa; a ficha é uma EXTENSÃO ligada por
-- `atendente_id`. Assim uma casa que não contratou RH continua com a lista
-- leve de sempre, e o cardápio e a pesquisa não enxergam nada de novo.
--
-- Módulo `rh` em `venue_modulos`: sem a linha do contrato, nem o favo aparece.
--
-- ATENÇÃO ao que mora aqui: CPF, RG, endereço e salário. Por isso o balde de
-- arquivos é PRIVADO (ao contrário do balde do cardápio, que é público de
-- propósito) e as telas ficam restritas a dono e gerente.

-- ============================================================
-- 1. A ficha
-- ============================================================
create table if not exists public.rh_fichas (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  -- Some junto com o atendente: ficha órfã não serve para nada e ainda
  -- guardaria CPF de quem saiu do cadastro.
  atendente_id uuid not null references public.pesquisa_atendentes(id) on delete cascade,

  -- O nome social/apelido continua no atendente ("Zé do Bar"). Aqui vai o
  -- nome que está no documento, que é o que a contabilidade precisa.
  nome_completo text,
  cpf text,
  rg text,
  nascimento date,
  telefone text,
  endereco text,

  -- Bar e restaurante não é só CLT: tem diarista de fim de semana, freela de
  -- evento e MEI que emite nota. A regra de cada um muda, e o gestor precisa
  -- ver isso na lista sem abrir a ficha.
  vinculo text not null default 'clt'
    check (vinculo in ('clt', 'mei', 'diarista', 'freelancer', 'estagio', 'socio')),
  cargo text,
  admissao date,

  -- Desligamento não apaga a ficha: obrigação trabalhista se guarda por anos,
  -- e "quem trabalhou aqui em 2024" é pergunta que aparece.
  desligamento date,
  motivo_desligamento text,

  salario numeric(12, 2),
  forma_pagamento text
    check (forma_pagamento is null or forma_pagamento in ('pix', 'dinheiro', 'transferencia')),
  chave_pix text,
  banco text,

  -- Quem avisar se a pessoa passar mal no meio do turno.
  emergencia_nome text,
  emergencia_telefone text,

  observacoes text,
  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now(),

  -- Uma ficha por pessoa. Sem isto, duas telas abertas viram duas fichas e
  -- ninguém sabe qual é a boa.
  unique (atendente_id)
);

comment on column public.rh_fichas.vinculo is
  'clt, mei, diarista, freelancer, estagio ou socio. Muda a regra de cada um, não o cálculo — a folha continua com a contabilidade.';

-- Dois cadastros com o mesmo CPF é sempre erro de digitação ou pessoa
-- duplicada. Vale por casa: a mesma pessoa pode trabalhar em duas casas da
-- rede, e aí são duas fichas legítimas.
create unique index if not exists idx_rh_fichas_cpf
  on public.rh_fichas (venue_id, cpf)
  where cpf is not null and cpf <> '';

create index if not exists idx_rh_fichas_casa on public.rh_fichas (venue_id);

create or replace function public.rh_fichas_antes()
returns trigger
language plpgsql
as $$
begin
  new.atualizada_em := now();
  return new;
end;
$$;

drop trigger if exists rh_fichas_antes on public.rh_fichas;
create trigger rh_fichas_antes
  before update on public.rh_fichas
  for each row execute function public.rh_fichas_antes();

alter table public.rh_fichas enable row level security;

-- ============================================================
-- 2. A pasta de documentos
-- ============================================================
--
-- O que trava a vida de bar: exame admissional que vence, atestado que some,
-- carteira que ninguém digitalizou. Cada documento guarda a VALIDADE quando
-- tem uma — é dela que sai o aviso de vencimento.
create table if not exists public.rh_documentos (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  atendente_id uuid not null references public.pesquisa_atendentes(id) on delete cascade,

  tipo text not null default 'outro'
    check (tipo in (
      'rg', 'cpf', 'ctps', 'comprovante_endereco', 'exame_admissional',
      'exame_periodico', 'exame_demissional', 'atestado', 'contrato',
      'aso', 'foto', 'outro'
    )),
  -- Como a pessoa reconhece o arquivo na lista: "Atestado 3 dias — dr. Paulo".
  titulo text,
  -- Caminho DENTRO do balde privado, não URL pública: o endereço para abrir é
  -- assinado na hora e expira. Guardar link eterno aqui seria vazar documento.
  caminho text not null,
  content_type text,
  tamanho_bytes integer,
  validade date,

  enviado_em timestamptz not null default now(),
  enviado_por text
);

comment on column public.rh_documentos.caminho is
  'Caminho no balde privado "rh". A tela abre por URL assinada de curta duração; nunca há link público.';

create index if not exists idx_rh_documentos_pessoa
  on public.rh_documentos (venue_id, atendente_id, enviado_em desc);

-- O painel pergunta "o que vence nos próximos dias?" a cada abertura da tela.
create index if not exists idx_rh_documentos_validade
  on public.rh_documentos (venue_id, validade)
  where validade is not null;

alter table public.rh_documentos enable row level security;

-- ============================================================
-- 3. Onde ficam os arquivos — balde PRIVADO
-- ============================================================
--
-- Diferente do balde do cardápio: lá a foto do prato é para o mundo ver, aqui
-- é RG e atestado. `public = false` e nenhuma policy de leitura: só a
-- service_role (o servidor) alcança, e o navegador recebe URL assinada.
--
-- 20 MB cobre foto de documento e PDF de exame com folga.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'rh', 'rh', false, 20971520,
  array['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = 20971520,
      allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

-- Se alguma policy antiga tiver aberto este balde, ela sai aqui.
drop policy if exists "rh e publico para leitura" on storage.objects;

notify pgrst, 'reload schema';
