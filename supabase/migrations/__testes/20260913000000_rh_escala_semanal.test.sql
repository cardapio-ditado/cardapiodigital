\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

insert into venues (id, name) values ('11111111-1111-1111-1111-111111111111','Ditado Popular');

insert into pesquisa_atendentes (id, venue_id, nome) values
  ('22222222-2222-2222-2222-222222222221','11111111-1111-1111-1111-111111111111','Cida'),
  ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','JB');

insert into rh_turnos (id, venue_id, nome, inicio, fim, ordem) values
  ('33333333-3333-3333-3333-333333333331','11111111-1111-1111-1111-111111111111','Almoço','11:00','15:00',1),
  ('33333333-3333-3333-3333-333333333332','11111111-1111-1111-1111-111111111111','Noite','18:00','02:00',2);

\echo '--- 1. DOIS TURNOS NO MESMO DIA PODEM ---'
insert into rh_escala (venue_id, data, atendente_id, turno_id) values
  ('11111111-1111-1111-1111-111111111111','2026-09-18','22222222-2222-2222-2222-222222222221','33333333-3333-3333-3333-333333333331'),
  ('11111111-1111-1111-1111-111111111111','2026-09-18','22222222-2222-2222-2222-222222222221','33333333-3333-3333-3333-333333333332');
select case when count(*) = 2 then 'ok   almoço e noite no mesmo dia — dobra existe em bar'
            else 'FALHA: não aceitou dois turnos no mesmo dia' end
from rh_escala where data = '2026-09-18';

\echo '--- 2. O MESMO TURNO DUAS VEZES NÃO ---'
do $$
begin
  insert into rh_escala (venue_id, data, atendente_id, turno_id)
  values ('11111111-1111-1111-1111-111111111111','2026-09-18','22222222-2222-2222-2222-222222222221','33333333-3333-3333-3333-333333333331');
  raise exception 'FALHA: escalou a mesma pessoa duas vezes no mesmo turno';
exception when unique_violation then
  raise notice 'ok   turno repetido barrado — dois cliques não viram dois lançamentos';
end $$;

\echo '--- 3. UMA FOLGA SÓ POR DIA ---'
insert into rh_escala (venue_id, data, atendente_id, situacao)
values ('11111111-1111-1111-1111-111111111111','2026-09-19','22222222-2222-2222-2222-222222222222','folga');
do $$
begin
  insert into rh_escala (venue_id, data, atendente_id, situacao)
  values ('11111111-1111-1111-1111-111111111111','2026-09-19','22222222-2222-2222-2222-222222222222','ferias');
  raise exception 'FALHA: aceitou duas linhas sem turno no mesmo dia';
exception when unique_violation then
  raise notice 'ok   segunda linha sem turno barrada — folga e férias no mesmo dia é erro';
end $$;

\echo '--- 4. QUEM NÃO TRABALHA NÃO TEM TURNO ---'
insert into rh_escala (venue_id, data, atendente_id, turno_id, situacao)
values ('11111111-1111-1111-1111-111111111111','2026-09-20','22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333332','atestado');
select case when turno_id is null then 'ok   atestado com turno preenchido teve o turno zerado pelo banco'
            else 'FALHA: sobrou "atestado das 18h" na grade' end
from rh_escala where data = '2026-09-20';

\echo '--- 5. SITUAÇÃO INVENTADA ---'
do $$
begin
  insert into rh_escala (venue_id, data, atendente_id, situacao)
  values ('11111111-1111-1111-1111-111111111111','2026-09-21','22222222-2222-2222-2222-222222222222','licenca');
  raise exception 'FALHA: aceitou situação fora da lista';
exception when check_violation then
  raise notice 'ok   situação "licenca" recusada — a lista é fechada de propósito';
end $$;

\echo '--- 6. TURNO REPETIDO NA CASA ---'
do $$
begin
  insert into rh_turnos (venue_id, nome, inicio, fim)
  values ('11111111-1111-1111-1111-111111111111','Noite','19:00','03:00');
  raise exception 'FALHA: criou dois turnos com o mesmo nome';
exception when unique_violation then
  raise notice 'ok   turno com nome repetido barrado';
end $$;

\echo '--- 7. APAGAR O TURNO LEVA A ESCALA DELE ---'
delete from rh_turnos where id = '33333333-3333-3333-3333-333333333331';
select case when count(*) = 0 then 'ok   escala do turno apagado saiu junto — nada de linha órfã'
            else 'FALHA: sobrou escala apontando para turno que não existe' end
from rh_escala where turno_id = '33333333-3333-3333-3333-333333333331';

\echo '--- 8. UMA PUBLICAÇÃO POR SEMANA ---'
insert into rh_semanas (venue_id, semana, publicada_por, avisos_enviados)
values ('11111111-1111-1111-1111-111111111111','2026-09-14','Kadu',4);
do $$
begin
  insert into rh_semanas (venue_id, semana) values ('11111111-1111-1111-1111-111111111111','2026-09-14');
  raise exception 'FALHA: gravou a mesma semana duas vezes';
exception when unique_violation then
  raise notice 'ok   semana única por casa — publicar de novo atualiza, não duplica';
end $$;

\echo '--- 9. O CARIMBO DA ESCALA SE MEXE SOZINHO ---'
update rh_escala set atualizada_em = '2020-01-01' where data = '2026-09-19';
update rh_escala set observacao = 'trocou com a Cida' where data = '2026-09-19';
select case when atualizada_em > now() - interval '1 minute'
            then 'ok   atualizada_em subiu — é assim que a tela sabe que mudou depois de publicar'
            else 'FALHA: atualizada_em ficou parada' end
from rh_escala where data = '2026-09-19';

\echo '--- 10. RODAR A MIGRAÇÃO DUAS VEZES NÃO QUEBRA NADA ---'
\i supabase/migrations/20260913000000_rh_escala_semanal.sql
select case when (select count(*) from rh_escala) = 3 and (select count(*) from rh_turnos) = 1
            then 'ok   migração idempotente — turnos e escala continuam lá'
            else 'FALHA: rodar de novo mexeu nos dados' end;
