\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- A casa vira às 5h: é o caso do Ditado, e o que quebra qualquer conta ingênua.
insert into venues (id, name, timezone, virada_do_dia)
values ('11111111-1111-1111-1111-111111111111','Ditado Popular','America/Cuiaba',5);

insert into pesquisa_atendentes (id, venue_id, nome) values
  ('22222222-2222-2222-2222-222222222221','11111111-1111-1111-1111-111111111111','Cida');

insert into rh_totens (id, venue_id, nome, token)
values ('44444444-4444-4444-4444-444444444441','11111111-1111-1111-1111-111111111111','Tablet da cozinha','segredo-do-tablet');

\echo '--- 1. O DIA DA CASA VIRA ÀS 5H ---'
-- 19/09 às 22h e 20/09 às 3h são a MESMA noite de trabalho.
select case when public.dia_operacional('11111111-1111-1111-1111-111111111111', '2026-09-19 22:00-04') = '2026-09-19'
             and public.dia_operacional('11111111-1111-1111-1111-111111111111', '2026-09-20 03:00-04') = '2026-09-19'
             and public.dia_operacional('11111111-1111-1111-1111-111111111111', '2026-09-20 06:00-04') = '2026-09-20'
            then 'ok   madrugada de domingo ainda é a noite de sábado'
            else 'FALHA: a virada das 5h não está sendo respeitada' end;

\echo '--- 2. TOKEN DE TABLET É ÚNICO NO BANCO INTEIRO ---'
insert into venues (id, name) values ('11111111-1111-1111-1111-111111111112','Outra Casa');
do $$
begin
  insert into rh_totens (venue_id, nome, token)
  values ('11111111-1111-1111-1111-111111111112','Tablet copiado','segredo-do-tablet');
  raise exception 'FALHA: dois tablets com o mesmo token';
exception when unique_violation then
  raise notice 'ok   token repetido barrado — um tablet abriria a casa do outro';
end $$;

\echo '--- 3. TIPO DE BATIDA FORA DA LISTA ---'
do $$
begin
  insert into rh_pontos (venue_id, atendente_id, dia, tipo)
  values ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222221','2026-09-19','almoco');
  raise exception 'FALHA: aceitou tipo de batida inventado';
exception when check_violation then
  raise notice 'ok   tipo "almoco" recusado — só entrada, pausa, volta e saida';
end $$;

\echo '--- 4. A NOITE INTEIRA CAI NO MESMO DIA DA CASA ---'
insert into rh_pontos (venue_id, atendente_id, dia, tipo, momento, totem_id) values
  ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222221',
   public.dia_operacional('11111111-1111-1111-1111-111111111111','2026-09-19 18:00-04'),'entrada','2026-09-19 18:00-04','44444444-4444-4444-4444-444444444441'),
  ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222221',
   public.dia_operacional('11111111-1111-1111-1111-111111111111','2026-09-20 02:30-04'),'saida','2026-09-20 02:30-04','44444444-4444-4444-4444-444444444441');
select case when count(distinct dia) = 1 and min(dia) = '2026-09-19'
            then 'ok   entrada às 18h e saída às 2h30 no mesmo dia da casa'
            else 'FALHA: a noite ficou partida em dois dias' end
from rh_pontos where atendente_id = '22222222-2222-2222-2222-222222222221';

\echo '--- 5. ORIGEM SÓ PODE SER TOTEM OU GESTOR ---'
do $$
begin
  insert into rh_pontos (venue_id, atendente_id, dia, tipo, origem)
  values ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222221','2026-09-19','entrada','importacao');
  raise exception 'FALHA: aceitou origem inventada';
exception when check_violation then
  raise notice 'ok   origem fora da lista recusada — ponto sem procedência não vale nada';
end $$;

\echo '--- 6. APAGAR O TABLET NÃO APAGA O PONTO ---'
delete from rh_totens where id = '44444444-4444-4444-4444-444444444441';
select case when count(*) = 2 then 'ok   batidas sobreviveram ao tablet — histórico não some com hardware'
            else 'FALHA: apagar o tablet levou o ponto junto' end
from rh_pontos where atendente_id = '22222222-2222-2222-2222-222222222221';

\echo '--- 7. TIRAR A PESSOA DO CADASTRO LEVA O PONTO DELA ---'
delete from pesquisa_atendentes where id = '22222222-2222-2222-2222-222222222221';
select case when count(*) = 0 then 'ok   ponto saiu junto com a pessoa — nada de batida órfã'
            else 'FALHA: sobrou batida sem dono' end
from rh_pontos;

\echo '--- 8. O PIN MORA NA FICHA, COMO HASH ---'
insert into pesquisa_atendentes (id, venue_id, nome)
values ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','JB');
insert into rh_fichas (venue_id, atendente_id, pin_hash, pin_atualizado_em)
values ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','scrypt$abc$def', now());
select case when pin_hash like 'scrypt$%' then 'ok   coluna do PIN existe e guarda hash, não o número'
            else 'FALHA: coluna do PIN não está como esperado' end
from rh_fichas where atendente_id = '22222222-2222-2222-2222-222222222222';

\echo '--- 9. RODAR A MIGRAÇÃO DUAS VEZES NÃO QUEBRA NADA ---'
\i supabase/migrations/20260914000000_rh_ponto_totem.sql
select case when (select count(*) from rh_fichas) = 1 and (select count(*) from rh_totens) = 0
            then 'ok   migração idempotente'
            else 'FALHA: rodar de novo mexeu nos dados' end;
